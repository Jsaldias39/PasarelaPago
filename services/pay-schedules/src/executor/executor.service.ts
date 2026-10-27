import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queryable } from '@pay/outbox';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database.module';
import { laPazDate, nextDue, periodOf } from '../dates';
import { newId, withTx } from '../db';
import { emit } from '../events';
import { LEDGER_CLIENT, type LedgerClient, type LedgerResult } from '../ledger/ledger.client';
import { CLOCK, type Clock } from '../mandates/mandates.service';
import { merchantStatus } from '../replica/merchant-replica';
import { SCHEDULE_SETTINGS, type ScheduleSettings } from '../settings';

interface Claimed {
  id: string;
  mandate_id: string;
  period: string;
  phase: 'hold' | 'post' | 'release' | 'void' | 'reverse' | 'done';
  attempts: number;
  ledger_attempt: number;
  hold_id: string | null;
}

interface MandateRow {
  id: string;
  merchant_id: string;
  mode: 'test' | 'live';
  kind: 'pay_obligation' | 'pay_commission';
  beneficiary_merchant_id: string;
  amount_minor: number;
  status: string;
}

export interface RunSummary {
  materialized: number;
  processed: number;
  executed: number;
  waitingFunds: number;
  failed: number;
  retryLater: number;
}

type FailureCode = 'insufficient_funds' | 'merchant_suspended' | 'ledger_unavailable' | 'invalid_state_transition' | 'internal_error';

/**
 * Ejecutor de pagos programados (7.7 y 7.8). Una corrida:
 *  1. materializa los periodos vencidos: una fila por (mandato, periodo) — la UNIQUE de la tabla es la garantía última de que un
 *     periodo se ejecuta una sola vez aunque el job corra dos veces o en dos réplicas;
 *  2. toma (con candado `SKIP LOCKED` y un arriendo) los pagos listos y los avanza por fases contra el libro mayor:
 *     retención (hold) en `merchant:{pagador}:available → schedule:{mandato}:reserve` → confirmación → liberación al beneficiario.
 * Cada fase se guarda antes de la siguiente y cada llamada al libro mayor lleva una clave estable por (pago, fase, intento): un
 * corte, un timeout o un 5xx NO prueban que no se ejecutó (regla 11), así que se reintenta con la MISMA clave y nunca se anula nada.
 */
@Injectable()
export class ExecutorService {
  private readonly logger = new Logger(ExecutorService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SCHEDULE_SETTINGS) private readonly settings: ScheduleSettings,
    @Inject(LEDGER_CLIENT) private readonly ledger: LedgerClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async runOnce(): Promise<RunSummary> {
    const summary: RunSummary = { materialized: 0, processed: 0, executed: 0, waitingFunds: 0, failed: 0, retryLater: 0 };
    summary.materialized = await this.materialize();
    for (const payment of await this.claim()) {
      summary.processed += 1;
      const outcome = await this.process(payment);
      if (outcome === 'executed') summary.executed += 1;
      else if (outcome === 'waiting_funds') summary.waitingFunds += 1;
      else if (outcome === 'failed') summary.failed += 1;
      else if (outcome === 'retry_later') summary.retryLater += 1;
    }
    return summary;
  }

  /** Crea el pago programado de cada periodo vencido. Idempotente: `ON CONFLICT DO NOTHING` sobre (mandato, periodo). */
  private async materialize(): Promise<number> {
    const now = this.clock();
    const today = laPazDate(now);
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id, next_run_on::text AS next_run_on, end_date::text AS end_date FROM mandates
          WHERE status = 'active' AND next_run_on IS NOT NULL AND next_run_on <= $1 ORDER BY next_run_on, id LIMIT 100 FOR UPDATE SKIP LOCKED`,
        [today],
      );
      let created = 0;
      for (const row of rows) {
        const due = row.next_run_on as string;
        const inserted = await client.query(
          `INSERT INTO scheduled_payments (id, mandate_id, period, due_on, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (mandate_id, period) DO NOTHING`,
          [newId('sp'), row.id, periodOf(due), due, now],
        );
        created += inserted.rowCount ?? 0;
        const following = nextDue(due);
        const done = row.end_date !== null && following > (row.end_date as string);
        await client.query('UPDATE mandates SET next_run_on = $2 WHERE id = $1', [row.id, done ? null : following]);
      }
      return created;
    });
  }

  /** Toma los pagos listos con un arriendo: otro ejecutor no los toca hasta que venza. */
  private async claim(): Promise<Claimed[]> {
    const now = this.clock();
    const leaseUntil = new Date(now.getTime() + this.settings.leaseSeconds * 1000);
    const { rows } = await this.pool.query(
      `UPDATE scheduled_payments SET lease_until = $2
        WHERE id IN (SELECT id FROM scheduled_payments
                      WHERE status IN ('due', 'waiting_funds') AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until < $1)
                      ORDER BY next_attempt_at, id LIMIT 50 FOR UPDATE SKIP LOCKED)
        RETURNING id, mandate_id, period, phase, attempts, ledger_attempt, hold_id`,
      [now, leaseUntil],
    );
    return rows as Claimed[];
  }

  private async mandateOf(id: string): Promise<MandateRow> {
    const { rows } = await this.pool.query('SELECT id, merchant_id, mode, kind, beneficiary_merchant_id, amount_minor::text AS amount_minor, status FROM mandates WHERE id = $1', [id]);
    return { ...(rows[0] as MandateRow), amount_minor: Number(rows[0].amount_minor) };
  }

  private async process(payment: Claimed): Promise<'executed' | 'waiting_funds' | 'failed' | 'retry_later' | 'canceled'> {
    const mandate = await this.mandateOf(payment.mandate_id);
    // Cancelado antes de tocar el libro mayor: no se ejecuta. Si ya hay dinero retenido, el pago en vuelo se completa.
    if (mandate.status === 'canceled' && payment.phase === 'hold' && payment.hold_id === null) {
      await this.pool.query(`UPDATE scheduled_payments SET status = 'canceled', lease_until = NULL WHERE id = $1`, [payment.id]);
      return 'canceled';
    }
    const payer = await merchantStatus(this.pool, mandate.merchant_id);
    if (payer === 'suspended' || payer === 'closed') {
      // Si ya hay dinero en la reserva, lo resuelve una persona: nada se libera ni se anula solo.
      return this.fail(payment, mandate, 'merchant_suspended', payment.phase !== 'hold');
    }

    // El beneficiario de una obligación tiene que ser un comercio ACTIVO: si no existe en la réplica, está suspendido o cerrado, no se le
    // acredita nada. (En una comisión el beneficiario es la plataforma —`platform:fees`—: no hay estado de comercio que consultar.)
    const beneficiaryBlocked = async (): Promise<boolean> => mandate.kind === 'pay_obligation' && (await merchantStatus(this.pool, mandate.beneficiary_merchant_id)) !== 'active';
    if (payment.phase === 'hold' && (await beneficiaryBlocked())) return this.fail(payment, mandate, 'merchant_suspended', false); // nada retenido: sin revisión

    const payerAccount = `merchant:${mandate.merchant_id}:available`;
    const reserve = `schedule:${mandate.id}:reserve`;
    let holdId = payment.hold_id;
    let phase = payment.phase;

    for (;;) {
      if (phase === 'hold') {
        const key = `${payment.id}:reserve:${payment.ledger_attempt}`;
        const result = await this.ledger.createHold(mandate.mode, key, {
          businessRef: `${payment.id}:reserve`,
          attempt: payment.ledger_attempt,
          debitAccount: payerAccount,
          creditAccount: reserve,
          amountMinor: mandate.amount_minor,
          expiresInSeconds: this.settings.holdExpiresSeconds,
        });
        if (result.kind === 'ok') {
          if (result.value.status === 'voided' || result.value.status === 'expired') return this.fail(payment, mandate, 'invalid_state_transition', true);
          holdId = result.value.id;
          phase = result.value.status === 'posted' ? 'release' : 'post';
          await this.savePhase(payment.id, phase, holdId);
          continue;
        }
        if (result.kind === 'rejected' && result.code === 'insufficient_funds') return this.insufficientFunds(payment, mandate, payerAccount);
        return this.unresolved(payment, mandate, result, phase);
      }

      // El estado del beneficiario puede cambiar entre fases. Con fondos YA retenidos: si la retención sigue pendiente se anula (void);
      // si ya se confirmó hacia la reserva se devuelve al pagador con un asiento inverso. Nunca se acredita al beneficiario bloqueado.
      if ((phase === 'post' || phase === 'release') && (await beneficiaryBlocked())) {
        phase = phase === 'post' ? 'void' : 'reverse';
        await this.savePhase(payment.id, phase, holdId);
      }

      if (phase === 'void') {
        const voided = await this.ledger.voidHold(mandate.mode, `${payment.id}:void`, holdId as string);
        if (voided.kind === 'ok') return this.fail(payment, mandate, 'merchant_suspended', true);
        if (voided.kind === 'conflict') {
          // 409: ya estaba resuelta (por ejemplo, la confirmación anterior sí se aplicó). Se decide con la consulta autoritativa.
          const current = await this.ledger.getHold(mandate.mode, holdId as string);
          if (current.kind === 'ok' && current.value.status === 'posted') {
            phase = 'reverse';
            await this.savePhase(payment.id, phase, holdId);
            continue;
          }
          if (current.kind === 'ok') return this.fail(payment, mandate, current.value.status === 'voided' ? 'merchant_suspended' : 'invalid_state_transition', true);
          return this.unresolved(payment, mandate, current, phase);
        }
        return this.unresolved(payment, mandate, voided, phase);
      }

      if (phase === 'reverse') {
        const reversal = await this.ledger.createTransaction(mandate.mode, `${payment.id}:reverse`, {
          businessRef: `${payment.id}:reverse`,
          attempt: 1,
          legs: [{ debit_account: reserve, credit_account: payerAccount, amount_minor: mandate.amount_minor, code: 'release' }],
        });
        if (reversal.kind === 'ok' && reversal.value.status === 'posted') return this.fail(payment, mandate, 'merchant_suspended', true);
        if (reversal.kind === 'ok' || reversal.kind === 'rejected' || reversal.kind === 'conflict') return this.fail(payment, mandate, 'invalid_state_transition', true);
        return this.unresolved(payment, mandate, reversal, phase);
      }

      if (phase === 'post') {
        const post = await this.ledger.postHold(mandate.mode, `${payment.id}:post`, holdId as string);
        if (post.kind === 'ok') {
          phase = 'release';
          await this.savePhase(payment.id, phase, holdId);
          continue;
        }
        if (post.kind === 'conflict') {
          // 409: ya estaba resuelta. Solo seguimos si la consulta autoritativa dice que se CONFIRMÓ; si no, lo mira una persona.
          const current = await this.ledger.getHold(mandate.mode, holdId as string);
          if (current.kind === 'ok' && current.value.status === 'posted') {
            phase = 'release';
            await this.savePhase(payment.id, phase, holdId);
            continue;
          }
          if (current.kind === 'ok') return this.fail(payment, mandate, 'invalid_state_transition', true);
          return this.unresolved(payment, mandate, current, phase);
        }
        return this.unresolved(payment, mandate, post, phase);
      }

      if (phase === 'release') {
        const toPlatform = mandate.kind === 'pay_commission';
        const tx = await this.ledger.createTransaction(mandate.mode, `${payment.id}:release`, {
          businessRef: `${payment.id}:release`,
          attempt: 1,
          legs: [{ debit_account: reserve, credit_account: toPlatform ? 'platform:fees' : `merchant:${mandate.beneficiary_merchant_id}:available`, amount_minor: mandate.amount_minor, code: toPlatform ? 'fee' : 'mandate' }],
        });
        if (tx.kind === 'ok') {
          if (tx.value.status !== 'posted') return this.fail(payment, mandate, 'internal_error', true);
          return this.executed(payment, mandate, tx.value.id, tx.value.transferIds[0] ?? null);
        }
        if (tx.kind === 'rejected' || tx.kind === 'conflict') return this.fail(payment, mandate, tx.kind === 'rejected' ? 'internal_error' : 'invalid_state_transition', true);
        return this.unresolved(payment, mandate, tx, phase);
      }

      // phase === 'done' no debería reclamarse (status ya es terminal)
      return 'retry_later';
    }
  }

  private async savePhase(id: string, phase: string, holdId: string | null): Promise<void> {
    await this.pool.query('UPDATE scheduled_payments SET phase = $2, hold_id = $3 WHERE id = $1', [id, phase, holdId]);
  }

  /** Retraso del reintento número `attempts` (1 = tras el primer intento), o `null` si la política se agotó. */
  private delayAfter(attempts: number): number | null {
    return attempts <= this.settings.retryDelaysSeconds.length ? this.settings.retryDelaysSeconds[attempts - 1] : null;
  }

  private async markMandateActive(client: Queryable, mandateId: string): Promise<void> {
    await client.query(`UPDATE mandates SET status = 'active' WHERE id = $1 AND status = 'paused_insufficient_funds'`, [mandateId]);
  }

  /** Si ya no quedan periodos por materializar ni pagos pendientes, el mandato se completa. */
  private async completeIfFinished(client: Queryable, mandateId: string): Promise<void> {
    await client.query(
      `UPDATE mandates SET status = 'completed' WHERE id = $1 AND status = 'active' AND next_run_on IS NULL
          AND NOT EXISTS (SELECT 1 FROM scheduled_payments WHERE mandate_id = $1 AND status IN ('due', 'waiting_funds'))`,
      [mandateId],
    );
  }

  private async executed(payment: Claimed, mandate: MandateRow, transactionId: string, transferId: string | null): Promise<'executed'> {
    const now = this.clock();
    await withTx(this.pool, async (client) => {
      await client.query(
        `UPDATE scheduled_payments SET status = 'executed', phase = 'done', ledger_transaction_id = $2, ledger_transfer_id = $3, executed_at = $4, lease_until = NULL,
                needs_review = $5, last_failure_code = NULL, attempts = attempts + 1
          WHERE id = $1`,
        [payment.id, transactionId, transferId, now, transferId === null],
      );
      await this.markMandateActive(client, mandate.id);
      await this.completeIfFinished(client, mandate.id);
      if (transferId === null) {
        // El dinero SE MOVIÓ (la verdad es el libro mayor), pero no hay id `tf_…` para el evento: queda a revisión y no se emite
        // un evento inválido. PR-09 pide al libro mayor que lo devuelva.
        this.logger.warn({ scheduled_payment_id: payment.id }, 'El libro mayor no devolvió el id de la transferencia: pago ejecutado sin evento, a revisión');
        return;
      }
      await emit(client, {
        type: 'scheduled_payment.executed',
        merchantId: mandate.merchant_id,
        subject: payment.id,
        aggregateType: 'scheduled_payment',
        aggregateId: payment.id,
        data: {
          scheduled_payment_id: payment.id,
          mandate_id: mandate.id,
          merchant_id: mandate.merchant_id,
          period: payment.period,
          amount_minor: mandate.amount_minor,
          currency: 'BOB',
          ledger_transfer_id: transferId,
          executed_at: now.toISOString(),
        },
      });
    });
    return 'executed';
  }

  /** Rechazo definitivo por falta de fondos: aviso, y reintento según la política (o fallo si se agotó). */
  private async insufficientFunds(payment: Claimed, mandate: MandateRow, payerAccount: string): Promise<'waiting_funds' | 'failed' | 'retry_later'> {
    // El saldo se consulta para el aviso. Si no se puede, el rechazo NO se registra todavía: reintentar el mismo `attempt` devuelve el mismo rechazo.
    const balance = await this.ledger.balance(mandate.mode, payerAccount);
    if (balance.kind !== 'ok') return this.unresolved(payment, mandate, balance, 'hold');
    const attempts = payment.attempts + 1;
    const delay = this.delayAfter(attempts);
    const now = this.clock();
    if (delay === null) return this.failWith(payment, mandate, 'insufficient_funds', false, attempts);
    const retryAt = new Date(now.getTime() + delay * 1000);
    await withTx(this.pool, async (client) => {
      await client.query(
        `UPDATE scheduled_payments SET status = 'waiting_funds', attempts = $2, ledger_attempt = ledger_attempt + 1, next_attempt_at = $3, lease_until = NULL, last_failure_code = 'insufficient_funds'
          WHERE id = $1`,
        [payment.id, attempts, retryAt],
      );
      await client.query(`UPDATE mandates SET status = 'paused_insufficient_funds' WHERE id = $1 AND status = 'active'`, [mandate.id]);
      await emit(client, {
        type: 'scheduled_payment.insufficient_funds',
        merchantId: mandate.merchant_id,
        subject: payment.id,
        aggregateType: 'scheduled_payment',
        aggregateId: payment.id,
        data: {
          scheduled_payment_id: payment.id,
          mandate_id: mandate.id,
          merchant_id: mandate.merchant_id,
          period: payment.period,
          amount_minor: mandate.amount_minor,
          currency: 'BOB',
          required_minor: mandate.amount_minor,
          available_minor: balance.value.balanceMinor,
          attempt: attempts,
          retry_at: retryAt.toISOString(),
        },
      });
    });
    return 'waiting_funds';
  }

  /** Resultado que no se pudo resolver (ambiguo, o conflicto que no se arregla solo): se conserva el estado y se reintenta con la MISMA clave. */
  private async unresolved(payment: Claimed, mandate: MandateRow, result: LedgerResult<unknown>, phase: string): Promise<'retry_later' | 'failed'> {
    if (result.kind === 'conflict') return this.fail(payment, mandate, 'invalid_state_transition', phase !== 'hold');
    if (result.kind === 'rejected') return this.fail(payment, mandate, 'internal_error', phase !== 'hold');
    const attempts = payment.attempts + 1;
    const delay = this.delayAfter(attempts);
    if (delay === null) return this.failWith(payment, mandate, 'ledger_unavailable', true, attempts);
    this.logger.warn({ scheduled_payment_id: payment.id, phase, attempts }, 'Resultado del libro mayor sin resolver; se reintenta con la misma clave');
    await this.pool.query(
      `UPDATE scheduled_payments SET attempts = $2, next_attempt_at = $3, lease_until = NULL, last_failure_code = 'ledger_unavailable' WHERE id = $1`,
      [payment.id, attempts, new Date(this.clock().getTime() + delay * 1000)],
    );
    return 'retry_later';
  }

  private fail(payment: Claimed, mandate: MandateRow, code: FailureCode, needsReview: boolean): Promise<'failed'> {
    return this.failWith(payment, mandate, code, needsReview, payment.attempts + 1);
  }

  /** Estado terminal `failed` con su aviso. Nunca anula una retención ni borra nada (los registros de dinero son de solo-agregar). */
  private async failWith(payment: Claimed, mandate: MandateRow, code: FailureCode, needsReview: boolean, attempts: number): Promise<'failed'> {
    const now = this.clock();
    await withTx(this.pool, async (client: PoolClient) => {
      await client.query(
        `UPDATE scheduled_payments SET status = 'failed', attempts = $2, last_failure_code = $3, needs_review = $4, lease_until = NULL WHERE id = $1`,
        [payment.id, attempts, code, needsReview],
      );
      // Cada periodo es independiente: un periodo fallido no deja al mandato en pausa para siempre (supuesto, ver DECISIONES-TOMADAS).
      await this.markMandateActive(client, mandate.id);
      await this.completeIfFinished(client, mandate.id);
      await emit(client, {
        type: 'scheduled_payment.failed',
        merchantId: mandate.merchant_id,
        subject: payment.id,
        aggregateType: 'scheduled_payment',
        aggregateId: payment.id,
        data: {
          scheduled_payment_id: payment.id,
          mandate_id: mandate.id,
          merchant_id: mandate.merchant_id,
          period: payment.period,
          amount_minor: mandate.amount_minor,
          currency: 'BOB',
          failure_code: code,
          attempt: attempts,
          failed_at: now.toISOString(),
        },
      });
    });
    return 'failed';
  }
}
