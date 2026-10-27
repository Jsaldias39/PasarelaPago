import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { IdempotencyStore, hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import { type PayoutRow, PAYOUT_COLUMNS, type Rail, payoutDto } from './dto';
import { LedgerRejectedError, LedgerUnavailableError, RailAmbiguousError, RailUnavailableError } from './errors';
import { businessRef, stableId } from './ids';
import { LEDGER_PORT, type LedgerPort, PAYOUT_RAILS, type PayoutOrder, type PayoutRail, type RailOutcome } from './ports';
import { emitPayoutCreated, emitPayoutFailed, emitPayoutPaid } from './settlement-events';
import { SETTLEMENT_CONFIG, type SettlementConfig } from './settlement.config';
import { decodeCursor, encodeCursor, fieldError, parseOrThrow, payoutCreate, payoutId, payoutListQuery, publicPayoutListQuery } from './schemas';
import { inTransaction } from './unit-of-work';

export type RailMap = Readonly<Record<Rail, PayoutRail>>;

export interface NewPayout {
  readonly id: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly reason: PayoutRow['reason'];
  readonly requestedBy: string;
  readonly batchId?: string;
  readonly periodFrom?: Date;
  readonly periodTo?: Date;
}

@Injectable()
export class PayoutService {
  private readonly logger = new Logger(PayoutService.name);
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(PAYOUT_RAILS) private readonly rails: RailMap,
    @Inject(SETTLEMENT_CONFIG) private readonly config: SettlementConfig,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  /** El riel que corresponde a `settlement.mode`: modo A → transferencia bancaria; modo B → doble del adquirente. */
  get activeRail(): PayoutRail {
    return this.config.mode === 'bank' ? this.rails.bank_transfer : this.rails.acquirer_settlement;
  }

  /** `POST /payouts`. Idempotente por `(llamador, Idempotency-Key)`; si se corta a la mitad, el mismo pedido la retoma. */
  create(rawBody: unknown, caller: string, idempotencyKey: string) {
    return this.idempotency.execute({ scope: caller, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/payouts', body: rawBody }) }, async () => {
      const input = parseOrThrow(payoutCreate, rawBody);
      if (input.reason === 'weekly_cut') throw fieldError('reason', 'reserved_for_batch');
      if (input.batch_id !== undefined) throw fieldError('batch_id', 'reserved_for_batch');
      if (input.rail !== this.activeRail.code) throw fieldError('rail', 'rail_not_enabled');
      const id = stableId('po', caller, idempotencyKey);
      const { row } = await this.insert({ id, merchantId: input.merchant_id, amountMinor: input.amount_minor, reason: input.reason, requestedBy: caller });
      const done = await this.advance(row.id);
      if (done.failure_code === 'insufficient_funds') throw new ProblemError('insufficient_funds', { detail: 'El comercio no tiene disponible ese monto' });
      return { status: 201, body: payoutDto(done) };
    });
  }

  /** Crea el pago del corte de un comercio. Mismo `(lote, comercio)` → mismo pago, siempre. */
  async createForBatch(input: { batchId: string; merchantId: string; amountMinor: number; periodFrom: Date; periodTo: Date }): Promise<PayoutRow> {
    const id = stableId('po', input.batchId, input.merchantId);
    const { row } = await this.insert({
      id,
      merchantId: input.merchantId,
      amountMinor: input.amountMinor,
      reason: 'weekly_cut',
      requestedBy: 'pay-settlement',
      batchId: input.batchId,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
    });
    return this.advance(row.id);
  }

  private async insert(input: NewPayout): Promise<{ row: PayoutRow; created: boolean }> {
    const rail = this.activeRail;
    const now = new Date();
    return inTransaction(this.pool, async (client) => {
      const inserted = await client.query<PayoutRow>(
        `INSERT INTO settlement_payouts (id, merchant_id, amount_minor, currency, rail, simulated, reason, status, step, hold_business_ref, batch_id, requested_by, period_from, period_to, created_at, updated_at)
         VALUES ($1, $2, $3, 'BOB', $4, $5, $6, 'pending', 'created', $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${PAYOUT_COLUMNS}`,
        [
          input.id,
          input.merchantId,
          input.amountMinor,
          rail.code,
          rail.simulated,
          input.reason,
          businessRef(input.id, 'payout'),
          input.batchId ?? null,
          input.requestedBy,
          input.periodFrom ?? now,
          input.periodTo ?? now,
          now,
        ],
      );
      if (inserted.rows[0]) {
        const row = inserted.rows[0];
        // `payout.created` exige el lote (settlement_batch_id es obligatorio en el contrato): los pagos sueltos no lo emiten (PROPUESTAS.md).
        if (row.batch_id) {
          await emitPayoutCreated(client, { payoutId: row.id, merchantId: row.merchant_id, amountMinor: Number(row.amount_minor), batchId: row.batch_id, periodFrom: row.period_from, periodTo: row.period_to, at: now });
        }
        return { row, created: true };
      }
      const existing = await client.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM settlement_payouts WHERE id = $1`, [input.id]);
      return { row: existing.rows[0], created: false };
    });
  }

  private order(row: PayoutRow): PayoutOrder {
    return { payoutId: row.id, businessRef: row.hold_business_ref, attempt: 1, merchantId: row.merchant_id, amountMinor: Number(row.amount_minor), currency: 'BOB' };
  }

  private railOf(row: PayoutRow): PayoutRail {
    return this.rails[row.rail];
  }

  async get(rawId: string): Promise<PayoutRow> {
    const id = payoutId.safeParse(rawId);
    if (!id.success) throw new ProblemError('resource_not_found');
    const found = await this.pool.query<PayoutRow>(`SELECT ${PAYOUT_COLUMNS} FROM settlement_payouts WHERE id = $1`, [id.data]);
    if (!found.rows[0]) throw new ProblemError('resource_not_found');
    return found.rows[0];
  }

  /** Listado paginado (del más nuevo al más viejo, desempate por id). `forMerchant` fija el comercio y no se puede cambiar por la consulta. */
  async list(rawQuery: unknown, forMerchant?: string) {
    // Con comercio fijado (consulta pública) no existen ni `merchant_id` ni `status`: se rechazan, no se ignoran en silencio.
    const q = parseOrThrow(forMerchant ? publicPayoutListQuery : payoutListQuery, rawQuery) as ReturnType<typeof payoutListQuery.parse>;
    const cursor = q.starting_after ? decodeCursor(q.starting_after) : null;
    const { rows } = await this.pool.query<PayoutRow>(
      `SELECT ${PAYOUT_COLUMNS} FROM settlement_payouts
        WHERE ($1::text IS NULL OR merchant_id = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [forMerchant ?? q.merchant_id ?? null, q.status ?? null, cursor?.at ?? null, cursor?.id ?? null, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { rows: page, has_more: rows.length > q.limit, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /**
   * Lleva un pago de `created` hasta donde se pueda: retiene el monto, ordena el pago por el riel y lo confirma o lo anula. Cada paso es
   * idempotente en el ledger y en el riel, de modo que repetirlo tras un corte no mueve dinero dos veces. Un candado de asesoría evita
   * que dos procesos lo avancen a la vez; el que no lo consigue devuelve el estado actual.
   *
   * @throws ProblemError `ledger_unavailable` si el ledger no responde (el pago queda donde estaba y el barrido lo retoma).
   */
  async advance(id: string): Promise<PayoutRow> {
    const lock = await this.pool.connect();
    try {
      const got = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`payout:${id}`]);
      if (!got.rows[0].locked) return await this.get(id);
      try {
        return await this.drive(id);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`payout:${id}`]);
      }
    } finally {
      lock.release();
    }
  }

  private async drive(id: string): Promise<PayoutRow> {
    let row = await this.get(id);
    if (row.step === 'created') {
      try {
        const hold = await this.ledger.createHold(
          { businessRef: row.hold_business_ref, attempt: 1, debitAccount: `merchant:${row.merchant_id}:available`, creditAccount: 'payout:clearing', amountMinor: Number(row.amount_minor), expiresInSeconds: this.config.payoutHoldTtlSeconds },
          `hold-${row.id}`,
        );
        row = (await this.setHeld(row, hold.id)) ?? (await this.get(id));
      } catch (error) {
        if (error instanceof LedgerRejectedError) {
          // Saldo insuficiente: no hay retención que anular. Cualquier otro rechazo del ledger es un defecto nuestro, no del comercio.
          return await this.finishFailed(row, error.code === 'insufficient_funds' ? 'insufficient_funds' : 'internal_error');
        }
        if (error instanceof LedgerUnavailableError) throw new ProblemError('ledger_unavailable');
        throw error;
      }
    }
    if (row.step === 'held') {
      let outcome: RailOutcome;
      try {
        outcome = await this.railOf(row).send(this.order(row));
      } catch (error) {
        if (error instanceof RailUnavailableError) return await this.voidAndFail(row, 'connector_unavailable');
        if (error instanceof RailAmbiguousError) {
          // No se sabe si el banco ejecutó la orden: NO se anula la retención. El pago queda `in_transit` con la retención viva y se
          // concilia con el riel (`poll`) antes de decidir confirmar o anular. Nunca se anula por ambigüedad.
          this.logger.warn({ payout: row.id }, 'El riel no confirmó la orden; el pago queda en tránsito con la retención viva');
          return (await this.setSent(row, null, 'in_transit')) ?? (await this.get(id));
        }
        throw error;
      }
      return await this.apply(row, outcome);
    }
    if (row.step === 'sent' && row.status === 'in_transit') return await this.poll(row);
    // El riel ya pagó pero no se pudo confirmar la retención (ledger caído): se reintenta solo la confirmación.
    if (row.step === 'sent' && row.status === 'pending') return await this.postAndPay(row);
    return row;
  }

  /** Consulta al riel un pago en tránsito y lo resuelve si ya terminó (confirmación tardía incluida). */
  private async poll(row: PayoutRow): Promise<PayoutRow> {
    let outcome: RailOutcome;
    try {
      outcome = await this.railOf(row).query(this.order(row));
    } catch (error) {
      if (error instanceof RailUnavailableError || error instanceof RailAmbiguousError) {
        // La consulta autoritativa no concluyó: NO se anula, NO se paga de nuevo. Queda en tránsito y se escala a una persona.
        await this.escalate(row, error.name);
        return row;
      }
      throw error;
    }
    return this.apply(row, outcome);
  }

  /** Deja constancia durable (una sola vez por pago) de que un pago en tránsito necesita ojos humanos. */
  private async escalate(row: PayoutRow, reason: string): Promise<void> {
    this.logger.error({ payout: row.id, reason }, 'ESCALAR: no se pudo saber si el riel pagó; la retención sigue viva');
    await this.pool.query(
      `INSERT INTO settlement_audit (actor, role, action, subject, detail, at)
       SELECT 'pay-settlement', 'system', 'payout.needs_attention', $1, $2::jsonb, $3
        WHERE NOT EXISTS (SELECT 1 FROM settlement_audit WHERE subject = $1 AND action = 'payout.needs_attention')`,
      [row.id, JSON.stringify({ reason }), new Date()],
    );
  }

  /** Confirmación externa (por ejemplo, la línea del extracto que prueba que el banco pagó). */
  async confirm(id: string, outcome: RailOutcome): Promise<PayoutRow> {
    const row = await this.get(id);
    if (row.step === 'resolved') return row;
    if (row.step !== 'sent') throw new ProblemError('invalid_state_transition', { detail: 'El pago todavía no se envió al riel' });
    return this.apply(row, outcome);
  }

  private async apply(row: PayoutRow, outcome: RailOutcome): Promise<PayoutRow> {
    if (outcome.state === 'in_transit') return (await this.setSent(row, outcome.reference, 'in_transit')) ?? (await this.get(row.id));
    if (outcome.state === 'failed') return this.voidAndFail(row, outcome.code);
    // El riel afirma que no tiene la orden (solo una consulta lo dice): el dinero no salió, se anula la retención.
    if (outcome.state === 'not_found') return this.voidAndFail(row, 'connector_unavailable');
    const sent = row.step === 'held' ? ((await this.setSent(row, outcome.reference, 'pending')) ?? (await this.get(row.id))) : row;
    return this.postAndPay(sent);
  }

  private async postAndPay(row: PayoutRow): Promise<PayoutRow> {
    if (!row.hold_id) throw new Error('Un pago sin retención no se puede confirmar');
    try {
      await this.ledger.postHold(row.hold_id, `post-${row.id}`);
    } catch (error) {
      if (error instanceof LedgerRejectedError) {
        // La retención ya no está pendiente. Si se confirmó antes (reintento tras un corte) está bien; si venció o se anuló mientras el
        // banco pagaba, el dinero salió y el saldo volvió: NO se declara pagado ni fallido, se deja para una persona.
        const hold = await this.ledger.getHold(row.hold_id);
        if (hold?.status !== 'posted') {
          this.logger.error({ payout: row.id, hold: row.hold_id, hold_status: hold?.status ?? 'ausente' }, 'El riel pagó pero la retención del ledger no se pudo confirmar');
          throw new ProblemError('invalid_state_transition', { detail: 'La retención ya no se puede confirmar' });
        }
      } else if (error instanceof LedgerUnavailableError) {
        throw new ProblemError('ledger_unavailable');
      } else {
        throw error;
      }
    }
    return (await this.finishPaid(row)) ?? (await this.get(row.id));
  }

  private async voidAndFail(row: PayoutRow, failureCode: string): Promise<PayoutRow> {
    if (row.hold_id) {
      try {
        await this.ledger.voidHold(row.hold_id, `void-${row.id}`);
      } catch (error) {
        if (error instanceof LedgerRejectedError) {
          const hold = await this.ledger.getHold(row.hold_id);
          if (hold?.status === 'posted') {
            this.logger.error({ payout: row.id, hold: row.hold_id }, 'Se pidió anular una retención que ya estaba confirmada');
            throw new ProblemError('invalid_state_transition', { detail: 'La retención ya se confirmó' });
          }
          // voided o expired: el saldo ya volvió; se sigue.
        } else if (error instanceof LedgerUnavailableError) {
          throw new ProblemError('ledger_unavailable');
        } else {
          throw error;
        }
      }
    }
    return this.finishFailed(row, failureCode);
  }

  private async setHeld(row: PayoutRow, holdId: string): Promise<PayoutRow | undefined> {
    const updated = await this.pool.query<PayoutRow>(
      `UPDATE settlement_payouts SET step = 'held', hold_id = $2, updated_at = $3 WHERE id = $1 AND step = 'created' RETURNING ${PAYOUT_COLUMNS}`,
      [row.id, holdId, new Date()],
    );
    return updated.rows[0];
  }

  private async setSent(row: PayoutRow, reference: string | null, status: 'pending' | 'in_transit'): Promise<PayoutRow | undefined> {
    const updated = await this.pool.query<PayoutRow>(
      `UPDATE settlement_payouts SET step = 'sent', status = $3, rail_reference = $2, updated_at = $4 WHERE id = $1 AND step IN ('held', 'sent') AND status <> 'paid' RETURNING ${PAYOUT_COLUMNS}`,
      [row.id, reference, status, new Date()],
    );
    return updated.rows[0];
  }

  private async finishPaid(row: PayoutRow): Promise<PayoutRow | undefined> {
    const now = new Date();
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<PayoutRow>(
        `UPDATE settlement_payouts SET status = 'paid', step = 'resolved', paid_at = $2, updated_at = $2 WHERE id = $1 AND step <> 'resolved' RETURNING ${PAYOUT_COLUMNS}`,
        [row.id, now],
      );
      if (!updated.rows[0]) return undefined;
      await emitPayoutPaid(client, { payoutId: row.id, merchantId: row.merchant_id, amountMinor: Number(row.amount_minor), paidAt: now });
      return updated.rows[0];
    }).then(async (done) => done ?? (await this.get(row.id)));
  }

  private async finishFailed(row: PayoutRow, failureCode: string): Promise<PayoutRow> {
    const now = new Date();
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<PayoutRow>(
        `UPDATE settlement_payouts SET status = 'failed', step = 'resolved', failure_code = $2, updated_at = $3 WHERE id = $1 AND step <> 'resolved' RETURNING ${PAYOUT_COLUMNS}`,
        [row.id, failureCode, now],
      );
      if (!updated.rows[0]) return undefined;
      await emitPayoutFailed(client, { payoutId: row.id, merchantId: row.merchant_id, amountMinor: Number(row.amount_minor), failureCode, failedAt: now });
      return updated.rows[0];
    }).then(async (done) => done ?? (await this.get(row.id)));
  }

  /** Barrido: retoma los pagos que quedaron a medias (corte del proceso, ledger caído, riel sin confirmar). */
  async recover(): Promise<{ advanced: number; failed: number }> {
    const cutoff = new Date(Date.now() - this.config.stuckAfterMs);
    const open = await this.pool.query<{ id: string }>(`SELECT id FROM settlement_payouts WHERE step <> 'resolved' AND updated_at <= $1 ORDER BY updated_at LIMIT 200`, [cutoff]);
    let advanced = 0;
    let failed = 0;
    for (const { id } of open.rows) {
      try {
        const before = await this.get(id);
        const after = await this.advance(id);
        if (after.step !== before.step || after.status !== before.status) advanced += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn({ payout: id, err: error instanceof Error ? error.name : 'desconocido' }, 'El barrido no pudo avanzar el pago');
      }
    }
    return { advanced, failed };
  }
}
