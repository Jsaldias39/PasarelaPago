import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { IdempotencyStore, hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import { LedgerRejectedError, LedgerUnavailableError } from './errors';
import { businessRef, stableId } from './ids';
import type { PayMode } from './mode';
import { LEDGER_PORT, type LedgerPort } from './ports';
import { chargeCreate, parseOrThrow } from './schemas';
import { inTransaction } from './unit-of-work';
import { watchClient } from '../pg-client';

export interface ChargeRow {
  id: string;
  mode: PayMode;
  merchant_id: string;
  kind: 'monthly_fee' | 'provider_commission' | 'chargeback_debt';
  period_key: string;
  credit_account: string;
  ledger_code: 'fee' | 'refund';
  amount_minor: string;
  collected_minor: string;
  status: 'open' | 'collected';
  requested_by: string;
  created_at: Date;
  collected_at: Date | null;
}

const COLUMNS = 'id, mode, merchant_id, kind, period_key, credit_account, ledger_code, amount_minor, collected_minor, status, requested_by, created_at, collected_at';

export interface NewCharge {
  readonly mode: PayMode;
  readonly merchantId: string;
  readonly kind: ChargeRow['kind'];
  readonly periodKey: string;
  readonly amountMinor: number;
  readonly creditAccount: string;
  readonly requestedBy: string;
}

/**
 * Neteo contra el saldo del comercio: abono mensual (D-07, P2.H2.M9), comisión programada de proveedores (7.8, P2.H2.M5) y deuda por
 * contracargo (D-22). Un cobro se intenta de inmediato contra `merchant:{id}:available`; lo que el saldo no alcanza queda ABIERTO y se
 * vuelve a intentar en cada corte antes de pagar (nunca se deja el saldo en negativo: el ledger lo impide).
 *
 * Cada intento fija su monto y su referencia ANTES de llamar al ledger (`settlement_charge_collections`), de modo que repetirlo tras
 * un corte reenvía exactamente el mismo asiento y el ledger no lo duplica.
 */
@Injectable()
export class NettingService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  /** `POST /charges` (declarado en el contrato desde la ola 2). Idempotente por `(llamador, Idempotency-Key)` y por `(comercio, tipo, referencia)`. */
  register(rawBody: unknown, caller: string, mode: PayMode, idempotencyKey: string) {
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/charges', body: rawBody }) }, async () => {
      const input = parseOrThrow(chargeCreate, rawBody);
      const charge = await this.open({
        mode,
        merchantId: input.merchant_id,
        kind: input.kind,
        periodKey: input.reference,
        amountMinor: input.amount_minor,
        creditAccount: input.kind === 'chargeback_debt' ? `connector:${input.connector}:clearing` : 'platform:fees',
        requestedBy: caller,
      });
      if (Number(charge.amount_minor) !== input.amount_minor) {
        throw new ProblemError('invalid_state_transition', { detail: 'Ya hay un cobro con esa referencia y otro monto' });
      }
      const settled = await this.collect(charge.id);
      return { status: 201, body: chargeDto(settled) };
    });
  }

  /** Crea el cobro si no existe (mismo `(comercio, tipo, periodo)` → el mismo). */
  async open(input: NewCharge): Promise<ChargeRow> {
    const now = new Date();
    const id = stableId('cg', input.mode, input.merchantId, input.kind, input.periodKey);
    return inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO settlement_charges (id, merchant_id, kind, period_key, credit_account, ledger_code, amount_minor, status, requested_by, created_at, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9, $10)
         ON CONFLICT (mode, merchant_id, kind, period_key) DO NOTHING`,
        [id, input.merchantId, input.kind, input.periodKey, input.creditAccount, input.kind === 'chargeback_debt' ? 'refund' : 'fee', input.amountMinor, input.requestedBy, now, input.mode],
      );
      const found = await client.query<ChargeRow>(`SELECT ${COLUMNS} FROM settlement_charges WHERE mode = $4 AND merchant_id = $1 AND kind = $2 AND period_key = $3`, [input.merchantId, input.kind, input.periodKey, input.mode]);
      return found.rows[0];
    });
  }

  async get(id: string): Promise<ChargeRow> {
    const found = await this.pool.query<ChargeRow>(`SELECT ${COLUMNS} FROM settlement_charges WHERE id = $1`, [id]);
    return found.rows[0];
  }

  /** Cobra lo que se pueda de un cobro abierto. Devuelve el cobro como quedó. */
  async collect(chargeId: string): Promise<ChargeRow> {
    const lock = await this.pool.connect();
    const watch = watchClient(lock);
    try {
      await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`charge:${chargeId}`]);
      try {
        return await this.collectLocked(chargeId);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`charge:${chargeId}`]).catch(() => undefined); // si la conexión murió, el candado de sesión murió con ella
      }
    } finally {
      watch.release();
    }
  }

  private async collectLocked(chargeId: string): Promise<ChargeRow> {
    let charge = await this.get(chargeId);
    for (;;) {
      if (charge.status === 'collected') return charge;
      const planned = await this.pool.query<{ seq: number; amount_minor: string; ledger_ref: string }>(
        `SELECT seq, amount_minor, ledger_ref FROM settlement_charge_collections WHERE charge_id = $1 AND status = 'planned'`,
        [chargeId],
      );
      let step = planned.rows[0];
      if (!step) {
        const due = Number(charge.amount_minor) - Number(charge.collected_minor);
        const balance = await this.ledger.getBalance(charge.mode, `merchant:${charge.merchant_id}:available`);
        const free = balance && balance.nature === 'credit' ? balance.balance_minor : 0;
        const amount = Math.min(due, free);
        if (amount < 1) return charge; // sin saldo: queda abierto para el próximo corte
        const next = await this.pool.query<{ next: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM settlement_charge_collections WHERE charge_id = $1', [chargeId]);
        const seq = Number(next.rows[0].next);
        const ref = businessRef(stableId('cg', chargeId, seq), 'collect');
        await this.pool.query(`INSERT INTO settlement_charge_collections (charge_id, seq, amount_minor, ledger_ref, status, created_at) VALUES ($1, $2, $3, $4, 'planned', $5)`, [chargeId, seq, amount, ref, new Date()]);
        step = { seq, amount_minor: String(amount), ledger_ref: ref };
      }
      try {
        await this.ledger.createTransaction(
          charge.mode,
          {
            businessRef: step.ledger_ref,
            attempt: 1,
            legs: [{ debit_account: `merchant:${charge.merchant_id}:available`, credit_account: charge.credit_account, amount_minor: Number(step.amount_minor), code: charge.ledger_code }],
          },
          `collect-${step.ledger_ref}`,
        );
      } catch (error) {
        if (error instanceof LedgerRejectedError) {
          // El saldo cambió entre leerlo y cobrar. Este intento queda quemado; el cobro sigue abierto.
          await this.pool.query(`UPDATE settlement_charge_collections SET status = 'rejected' WHERE charge_id = $1 AND seq = $2`, [chargeId, step.seq]);
          return charge;
        }
        if (error instanceof LedgerUnavailableError) throw new ProblemError('ledger_unavailable');
        throw error;
      }
      charge = await inTransaction(this.pool, async (client) => {
        await client.query(`UPDATE settlement_charge_collections SET status = 'posted' WHERE charge_id = $1 AND seq = $2`, [chargeId, step.seq]);
        const now = new Date();
        const updated = await client.query<ChargeRow>(
          `UPDATE settlement_charges
              SET collected_minor = collected_minor + $2,
                  status = CASE WHEN collected_minor + $2 = amount_minor THEN 'collected' ELSE 'open' END,
                  collected_at = CASE WHEN collected_minor + $2 = amount_minor THEN $3::timestamptz ELSE NULL END
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [chargeId, step.amount_minor, now],
        );
        return updated.rows[0];
      });
    }
  }

  /** Cobros abiertos de un comercio, del más viejo al más nuevo (se cobra primero lo más antiguo). */
  async collectOpenFor(mode: PayMode, merchantId: string): Promise<{ collectedMinor: number; stillOpen: number }> {
    const open = await this.pool.query<{ id: string }>(`SELECT id FROM settlement_charges WHERE mode = $2 AND merchant_id = $1 AND status = 'open' ORDER BY created_at, id`, [merchantId, mode]);
    let collected = 0;
    let stillOpen = 0;
    for (const { id } of open.rows) {
      const before = Number((await this.get(id)).collected_minor);
      const after = await this.collect(id);
      collected += Number(after.collected_minor) - before;
      if (after.status === 'open') stillOpen += 1;
    }
    return { collectedMinor: collected, stillOpen };
  }

  /** Abono mensual del comercio para el mes de `cutoffDate` (`YYYY-MM`), si su tarifario lo tiene. Una sola vez por mes. */
  async chargeMonthlyFee(mode: PayMode, merchantId: string, cutoffDate: string): Promise<ChargeRow | null> {
    const plan = await this.pool.query<{ monthly_fee_minor: string }>(
      `SELECT monthly_fee_minor FROM settlement_fee_plans
        WHERE merchant_id = $1 AND monthly_fee_minor > 0 AND effective_from <= $2::date + 1 AND (effective_to IS NULL OR effective_to > $2::date)`,
      [merchantId, cutoffDate],
    );
    const fee = plan.rows[0] ? Number(plan.rows[0].monthly_fee_minor) : 0;
    if (fee < 1) return null;
    return this.open({ mode, merchantId, kind: 'monthly_fee', periodKey: cutoffDate.slice(0, 7), amountMinor: fee, creditAccount: 'platform:fees', requestedBy: 'pay-settlement' });
  }
}

export function chargeDto(row: ChargeRow) {
  return {
    id: row.id,
    object: 'settlement_charge' as const,
    merchant_id: row.merchant_id,
    kind: row.kind,
    reference: row.period_key,
    amount_minor: Number(row.amount_minor),
    collected_minor: Number(row.collected_minor),
    debt_minor: Number(row.amount_minor) - Number(row.collected_minor),
    currency: 'BOB' as const,
    status: row.status,
    created_at: row.created_at.toISOString(),
    collected_at: row.collected_at ? row.collected_at.toISOString() : null,
  };
}
