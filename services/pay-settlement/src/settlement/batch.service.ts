import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { IdempotencyStore, hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { PG_POOL } from '../database.module';
import { type BatchRow, BATCH_COLUMNS, batchDto } from './dto';
import { LedgerRejectedError, LedgerUnavailableError } from './errors';
import { businessRef, randomId, stableId } from './ids';
import type { PayMode } from './mode';
import { NettingService } from './netting.service';
import { PayoutService } from './payout.service';
import { LEDGER_PORT, type LedgerPort } from './ports';
import { batchCreate, decodeCursor, encodeCursor, fieldError, listQuery, parseOrThrow } from './schemas';
import { emitBatchClosed } from './settlement-events';
import { SETTLEMENT_CONFIG, type SettlementConfig } from './settlement.config';
import { inTransaction } from './unit-of-work';

interface ItemRow {
  batch_id: string;
  merchant_id: string;
  status: 'pending' | 'planned' | 'released' | 'done' | 'failed';
  planned_release_minor: string | null;
  new_residual_minor: string | null;
  ledger_attempt: number;
}

const DAY_MS = 86_400_000;

/** Medianoche local del día `date` (`YYYY-MM-DD`) como instante UTC. Bolivia es UTC−4: el corte del lunes es a las 04:00Z. */
export function localMidnight(date: string, tzOffsetMinutes: number): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - tzOffsetMinutes * 60_000);
}

@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(SETTLEMENT_CONFIG) private readonly config: SettlementConfig,
    private readonly payouts: PayoutService,
    private readonly netting: NettingService,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  /** `POST /batches`. Idempotente por `Idempotency-Key` y, sobre todo, por `cutoff_date`: el mismo lunes nunca se paga dos veces. */
  run(rawBody: unknown, caller: string, mode: PayMode, idempotencyKey: string) {
    return this.idempotency.execute({ scope: `${caller}|${mode}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/batches', body: rawBody }) }, async () => {
      const input = parseOrThrow(batchCreate, rawBody);
      const releaseDays = input.release_days ?? this.config.releaseDays;
      const cutoff = localMidnight(input.cutoff_date, this.config.tzOffsetMinutes);
      // La fecha tiene que existir de verdad (2026-02-30 pasa el formato de zod pero no el calendario).
      if (new Date(`${input.cutoff_date}T00:00:00Z`).toISOString().slice(0, 10) !== input.cutoff_date) throw fieldError('cutoff_date', 'invalid_date');
      if (this.config.cutoffWeekday !== null && new Date(`${input.cutoff_date}T00:00:00Z`).getUTCDay() !== this.config.cutoffWeekday) throw fieldError('cutoff_date', 'not_a_cutoff_day');
      if (cutoff.getTime() > Date.now()) throw fieldError('cutoff_date', 'future_cutoff');

      const { batch, created } = await this.claim(mode, input.cutoff_date, releaseDays, cutoff);
      if (batch.release_days !== releaseDays) throw fieldError('release_days', 'differs_from_existing_batch');
      const finished = await this.process(batch.id);
      return { status: created ? 201 : 200, body: batchDto(finished) };
    });
  }

  private async claim(mode: PayMode, cutoffDate: string, releaseDays: number, cutoff: Date): Promise<{ batch: BatchRow; created: boolean }> {
    const releaseBefore = new Date(cutoff.getTime() - releaseDays * DAY_MS);
    const now = new Date();
    return inTransaction(this.pool, async (client) => {
      // Dos cortes a la vez para la misma fecha se serializan acá; el segundo ve el lote del primero.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`batch:${mode}:${cutoffDate}`]);
      const existing = await client.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM settlement_batches WHERE mode = $1 AND cutoff_date = $2`, [mode, cutoffDate]);
      if (existing.rows[0]) return { batch: existing.rows[0], created: false };
      const previous = await client.query<{ release_before: Date }>(
        `SELECT release_before FROM settlement_batches WHERE mode = $2 AND cutoff_date < $1 AND status = 'completed' ORDER BY cutoff_date DESC LIMIT 1`,
        [cutoffDate, mode],
      );
      const first = await client.query<{ first_seen: Date | null }>('SELECT MIN(first_seen_at) AS first_seen FROM settlement_merchants');
      const periodFrom = previous.rows[0]?.release_before ?? first.rows[0].first_seen ?? releaseBefore;
      const id = randomId('sb');
      const inserted = await client.query<BatchRow>(
        `INSERT INTO settlement_batches (id, cutoff_date, release_days, release_before, period_from, status, created_at, mode)
         VALUES ($1, $2, $3, $4, LEAST($5::timestamptz, $4::timestamptz), 'running', $6, $7)
         RETURNING ${BATCH_COLUMNS}`,
        [id, cutoffDate, releaseDays, releaseBefore, periodFrom, now, mode],
      );
      // Los comercios del lote se congelan acá: uno que aparezca a mitad del corte entra en el siguiente.
      await client.query(
        `INSERT INTO settlement_batch_items (batch_id, merchant_id, status, updated_at) SELECT $1, merchant_id, 'pending', $2 FROM settlement_merchants`,
        [id, now],
      );
      return { batch: inserted.rows[0], created: true };
    });
  }

  private async getBatch(id: string): Promise<BatchRow> {
    const found = await this.pool.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM settlement_batches WHERE id = $1`, [id]);
    return found.rows[0];
  }

  /** Procesa los comercios pendientes del lote. Un candado de asesoría evita dos procesadores a la vez; repetirlo retoma lo que falta. */
  async process(batchId: string): Promise<BatchRow> {
    const lock = await this.pool.connect();
    try {
      const got = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`batch-run:${batchId}`]);
      if (!got.rows[0].locked) return await this.getBatch(batchId);
      try {
        return await this.processLocked(batchId);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`batch-run:${batchId}`]);
      }
    } finally {
      lock.release();
    }
  }

  private async processLocked(batchId: string): Promise<BatchRow> {
    const batch = await this.getBatch(batchId);
    if (batch.status === 'completed') return batch;
    // Un comercio cuyo asiento de liberación fue rechazado se reintenta con el attempt siguiente (el rechazo quema su id en el ledger).
    await this.pool.query(
      `UPDATE settlement_batch_items SET status = 'pending', ledger_attempt = ledger_attempt + 1, failure_code = NULL, planned_release_minor = NULL, new_residual_minor = NULL, updated_at = $2
        WHERE batch_id = $1 AND status = 'failed'`,
      [batchId, new Date()],
    );
    const items = await this.pool.query<ItemRow>(
      `SELECT batch_id, merchant_id, status, planned_release_minor, new_residual_minor, ledger_attempt FROM settlement_batch_items
        WHERE batch_id = $1 AND status <> 'done' ORDER BY merchant_id`,
      [batchId],
    );
    for (const item of items.rows) {
      try {
        await this.processItem(batch, item);
      } catch (error) {
        if (error instanceof ProblemError) throw error;
        if (error instanceof LedgerUnavailableError) throw new ProblemError('ledger_unavailable');
        throw error;
      }
    }
    return this.close(batch);
  }

  private async processItem(batch: BatchRow, original: ItemRow): Promise<void> {
    let item = original;
    const merchant = item.merchant_id;
    const pendingAccount = `merchant:${merchant}:pending`;

    if (item.status === 'pending') {
      const state = await this.pool.query<{ watermark_at: Date | null; residual_minor: string }>('SELECT watermark_at, residual_minor FROM settlement_merchant_marks WHERE mode = $1 AND merchant_id = $2', [batch.mode, merchant]);
      const watermark = state.rows[0]?.watermark_at ?? null;
      const residual = Number(state.rows[0]?.residual_minor ?? 0);
      const entries = await this.ledger.listStatement(batch.mode, pendingAccount, { ...(watermark && { from: watermark.toISOString() }), to: batch.release_before.toISOString() });
      const net = entries.reduce((sum, e) => sum + (e.direction === 'credit' ? e.amount_minor : -e.amount_minor), 0);
      const balance = await this.ledger.getBalance(batch.mode, pendingAccount);
      const pendingNow = balance && balance.nature === 'credit' ? balance.balance_minor : 0;
      const available = residual + net;
      const release = Math.max(0, Math.min(available, pendingNow));
      await this.pool.query(
        `UPDATE settlement_batch_items SET status = 'planned', window_from = $3, planned_release_minor = $4, new_residual_minor = $5, updated_at = $6 WHERE batch_id = $1 AND merchant_id = $2`,
        [batch.id, merchant, watermark, release, available - release, new Date()],
      );
      item = { ...item, status: 'planned', planned_release_minor: String(release), new_residual_minor: String(available - release) };
    }

    if (item.status === 'planned') {
      const release = Number(item.planned_release_minor);
      if (release > 0) {
        try {
          await this.ledger.createTransaction(
            batch.mode,
            {
              businessRef: businessRef(stableId('rl', batch.id, merchant), 'release'),
              attempt: item.ledger_attempt,
              legs: [{ debit_account: pendingAccount, credit_account: `merchant:${merchant}:available`, amount_minor: release, code: 'release' }],
            },
            `release-${batch.id}-${merchant}-${item.ledger_attempt}`,
          );
        } catch (error) {
          if (error instanceof LedgerRejectedError) {
            await this.pool.query(`UPDATE settlement_batch_items SET status = 'failed', failure_code = $3, updated_at = $4 WHERE batch_id = $1 AND merchant_id = $2`, [batch.id, merchant, error.code, new Date()]);
            this.logger.warn({ batch: batch.id, merchant, code: error.code }, 'El ledger rechazó la liberación del comercio');
            return;
          }
          throw error;
        }
      }
      await inTransaction(this.pool, async (client) => {
        const now = new Date();
        await client.query(`UPDATE settlement_batch_items SET status = 'released', released_minor = $3, updated_at = $4 WHERE batch_id = $1 AND merchant_id = $2`, [batch.id, merchant, release, now]);
        await client.query(
          `INSERT INTO settlement_merchant_marks (mode, merchant_id, watermark_at, residual_minor) VALUES ($1, $2, $3, $4)
           ON CONFLICT (mode, merchant_id) DO UPDATE SET watermark_at = EXCLUDED.watermark_at, residual_minor = EXCLUDED.residual_minor`,
          [batch.mode, merchant, batch.release_before, item.new_residual_minor],
        );
      });
      item = { ...item, status: 'released' };
    }

    if (item.status === 'released') {
      // Primero lo que el comercio debe (deuda del comercio, cobros abiertos y el abono del mes), después lo que se le paga.
      await this.netDebt(batch, merchant);
      await this.netting.collectOpenFor(batch.mode, merchant);
      const fee = await this.netting.chargeMonthlyFee(batch.mode, merchant, batch.cutoff_date);
      if (fee) await this.netting.collect(fee.id);
      const balance = await this.ledger.getBalance(batch.mode, `merchant:${merchant}:available`);
      const free = balance && balance.nature === 'credit' ? balance.balance_minor : 0;
      let payoutId: string | null = null;
      // Si el pago de este corte ya existe (reintento tras un corte del proceso) se RETOMA tal cual: su monto no se recalcula —el disponible
      // ya descuenta la retención— y no se vuelve a insertar.
      const existing = await this.pool.query<{ id: string }>('SELECT id FROM settlement_payouts WHERE batch_id = $1 AND merchant_id = $2', [batch.id, merchant]);
      if (existing.rows[0]) {
        payoutId = (await this.payouts.advance(existing.rows[0].id)).id;
      } else if (free > 0) {
        payoutId = (await this.payouts.createForBatch({ batchId: batch.id, mode: batch.mode, merchantId: merchant, amountMinor: free, periodFrom: batch.period_from, periodTo: batch.release_before })).id;
      }
      await this.pool.query(`UPDATE settlement_batch_items SET status = 'done', payout_id = $3, updated_at = $4 WHERE batch_id = $1 AND merchant_id = $2`, [batch.id, merchant, payoutId, new Date()]);
    }
  }

  /**
   * Deuda del comercio por contracargo (D-22): lo que superó su saldo pendiente se asentó en `merchant:{id}:debt` (cuenta deudora; `pending`
   * nunca queda en negativo). El corte la netea moviendo `min(deuda, disponible)` de `available` a `debt`, con el monto fijado ANTES de
   * llamar al ledger. Lo que el disponible no alcanza sigue debiéndose y se reintenta en el corte siguiente (`available` nunca queda negativo y
   * la deuda no se puede pagar de más: lo impide el ledger). Si el ledger rechaza el movimiento porque el saldo cambió, este corte lo omite.
   */
  private async netDebt(batch: BatchRow, merchant: string): Promise<void> {
    const row = (await this.pool.query<{ netting_minor: string | null; netting_attempt: number }>('SELECT netting_minor, netting_attempt FROM settlement_batch_items WHERE batch_id = $1 AND merchant_id = $2', [batch.id, merchant])).rows[0];
    let planned = row.netting_minor === null ? null : Number(row.netting_minor);
    if (planned === null) {
      const owed = await this.ledger.getBalance(batch.mode, `merchant:${merchant}:debt`);
      const free = await this.ledger.getBalance(batch.mode, `merchant:${merchant}:available`);
      const debt = owed && owed.nature === 'debit' ? owed.balance_minor : 0;
      planned = Math.min(debt, free && free.nature === 'credit' ? free.balance_minor : 0);
      await this.pool.query('UPDATE settlement_batch_items SET netting_minor = $3, updated_at = $4 WHERE batch_id = $1 AND merchant_id = $2', [batch.id, merchant, planned, new Date()]);
    }
    if (planned < 1) return;
    try {
      await this.ledger.createTransaction(
        batch.mode,
        {
          businessRef: businessRef(stableId('nd', batch.id, merchant), 'collect'),
          attempt: row.netting_attempt,
          legs: [{ debit_account: `merchant:${merchant}:available`, credit_account: `merchant:${merchant}:debt`, amount_minor: planned, code: 'adjustment' }],
        },
        `netting-${batch.id}-${merchant}-${row.netting_attempt}`,
      );
    } catch (error) {
      if (!(error instanceof LedgerRejectedError)) throw error;
      this.logger.warn({ batch: batch.id, merchant, code: error.code }, 'El ledger rechazó el neteo de la deuda; queda para el próximo corte');
      await this.pool.query('UPDATE settlement_batch_items SET netting_minor = 0, updated_at = $3 WHERE batch_id = $1 AND merchant_id = $2', [batch.id, merchant, new Date()]);
    }
  }

  private async close(batch: BatchRow): Promise<BatchRow> {
    return inTransaction(this.pool, async (client) => {
      const totals = await client.query<{ merchants: string; payouts: string; released: string; failed: string }>(
        `SELECT COUNT(*)::text AS merchants, COUNT(payout_id)::text AS payouts, COALESCE(SUM(released_minor), 0)::text AS released,
                COUNT(*) FILTER (WHERE status <> 'done')::text AS failed
           FROM settlement_batch_items WHERE batch_id = $1`,
        [batch.id],
      );
      const t = totals.rows[0];
      const failed = Number(t.failed);
      const now = new Date();
      const updated = await client.query<BatchRow>(
        `UPDATE settlement_batches SET status = $2, merchants_count = $3, payouts_count = $4, released_minor = $5, failed_count = $6, completed_at = $7
          WHERE id = $1 AND status <> 'completed' RETURNING ${BATCH_COLUMNS}`,
        [batch.id, failed === 0 ? 'completed' : 'failed', Number(t.merchants), Number(t.payouts), t.released, failed, failed === 0 ? now : null],
      );
      if (!updated.rows[0]) return (await client.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM settlement_batches WHERE id = $1`, [batch.id])).rows[0];
      if (failed === 0) {
        await emitBatchClosed(client, {
          batchId: batch.id,
          mode: batch.mode,
          periodFrom: batch.period_from,
          periodTo: batch.release_before,
          merchantsCount: Number(t.merchants),
          payoutsCount: Number(t.payouts),
          releasedMinor: Number(t.released),
          closedAt: now,
        });
      }
      return updated.rows[0];
    });
  }

  async list(rawQuery: unknown, mode: PayMode) {
    const q = parseOrThrow(listQuery, rawQuery);
    const cursor = q.starting_after ? decodeCursor(q.starting_after) : null;
    const { rows } = await this.pool.query<BatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM settlement_batches
        WHERE mode = $4 AND ($1::timestamptz IS NULL OR (created_at, id) < ($1, $2))
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [cursor?.at ?? null, cursor?.id ?? null, q.limit + 1, mode],
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { rows: page, has_more: rows.length > q.limit, next_cursor: rows.length > q.limit && last ? encodeCursor(last.created_at, last.id) : null };
  }

  /** Retoma los lotes que quedaron a medias (el proceso murió con el lote en `running`). */
  async resumeRunning(): Promise<number> {
    const running = await this.pool.query<{ id: string }>(`SELECT id FROM settlement_batches WHERE status = 'running' ORDER BY created_at LIMIT 20`);
    let resumed = 0;
    for (const { id } of running.rows) {
      try {
        await this.process(id);
        resumed += 1;
      } catch (error) {
        this.logger.warn({ batch: id, err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo retomar el lote');
      }
    }
    return resumed;
  }
}
