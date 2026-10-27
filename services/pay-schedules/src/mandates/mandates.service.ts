import { Inject, Injectable } from '@nestjs/common';
import { IdempotencyStore } from '@pay/idempotency';
import type { Queryable } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { firstDue, isRealDate, laPazDate, nextDue } from '../dates';
import { newId, withTx } from '../db';
import { emit } from '../events';
import { rethrowStoredProblem } from '../idempotent';
import { merchantStatus } from '../replica/merchant-replica';
import { SCHEDULE_SETTINGS, type ScheduleSettings } from '../settings';

export type Mode = 'test' | 'live';
export type Clock = () => Date;
export const CLOCK = Symbol('CLOCK');

export interface MandateInput {
  kind: 'pay_obligation' | 'pay_commission';
  beneficiary_merchant_id: string;
  amount_minor: number;
  currency: 'BOB';
  schedule: { frequency: 'monthly'; day_of_month: number; start_date: string; end_date?: string | null };
  description?: string;
}

export interface MandateView extends Omit<MandateInput, 'schedule' | 'description'> {
  id: string;
  object: 'mandate';
  status: 'active' | 'paused_insufficient_funds' | 'canceled' | 'completed';
  next_run_on: string | null;
  created_at: string;
  schedule: { frequency: 'monthly'; day_of_month: number; start_date: string; end_date: string | null };
  description?: string;
}

const COLUMNS = `id, kind, beneficiary_merchant_id, amount_minor::text AS amount_minor, currency, frequency, day_of_month, start_date::text AS start_date,
  end_date::text AS end_date, description, status, next_run_on::text AS next_run_on, created_at`;

export function toView(row: Record<string, unknown>): MandateView {
  return {
    id: row.id as string,
    object: 'mandate',
    kind: row.kind as MandateView['kind'],
    beneficiary_merchant_id: row.beneficiary_merchant_id as string,
    amount_minor: Number(row.amount_minor),
    currency: 'BOB',
    schedule: { frequency: 'monthly', day_of_month: Number(row.day_of_month), start_date: row.start_date as string, end_date: (row.end_date as string | null) ?? null },
    ...(row.description !== null && row.description !== undefined && { description: row.description as string }),
    status: row.status as MandateView['status'],
    next_run_on: (row.next_run_on as string | null) ?? null,
    created_at: (row.created_at as Date).toISOString(),
  };
}

const fail = (errors: { field: string; code: string }[]): never => {
  throw new ProblemError('validation_failed', { errors });
};

interface Cursor {
  at: string;
  id: string;
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url');
function decodeCursor(raw: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && !Number.isNaN(Date.parse(parsed[0])) && typeof parsed[1] === 'string' && /^md_[a-z0-9]{10,40}$/.test(parsed[1])) return { at: parsed[0], id: parsed[1] };
  } catch {
    // cae al error de abajo
  }
  return fail([{ field: 'starting_after', code: 'invalid' }]);
}

@Injectable()
export class MandatesService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SCHEDULE_SETTINGS) private readonly settings: ScheduleSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  private async validate(client: Queryable, merchantId: string, input: MandateInput, today: string): Promise<void> {
    const payer = await merchantStatus(client, merchantId);
    if (payer === 'suspended') throw new ProblemError('merchant_suspended');
    if (payer === 'closed') throw new ProblemError('forbidden');

    const errors: { field: string; code: string }[] = [];
    const beneficiary = input.beneficiary_merchant_id;
    let checkBeneficiaryStatus = true;
    if (beneficiary === merchantId) {
      errors.push({ field: 'beneficiary_merchant_id', code: 'is_payer' });
      checkBeneficiaryStatus = false;
    } else if (input.kind === 'pay_commission') {
      // 7.8: la comisión se paga a ALOVIDA. Sin comercio de plataforma configurado no se aceptan (Q-15, supuesto conservador).
      if (this.settings.platformMerchantId === undefined) {
        errors.push({ field: 'kind', code: 'commission_not_supported' });
        checkBeneficiaryStatus = false;
      } else if (beneficiary !== this.settings.platformMerchantId) {
        errors.push({ field: 'beneficiary_merchant_id', code: 'not_platform' });
        checkBeneficiaryStatus = false;
      }
    }
    if (checkBeneficiaryStatus) {
      const status = await merchantStatus(client, beneficiary);
      if (status === null) errors.push({ field: 'beneficiary_merchant_id', code: 'unknown' });
      else if (status !== 'active') errors.push({ field: 'beneficiary_merchant_id', code: 'not_active' });
    }
    if (this.settings.mandateMaxAmountMinor !== undefined && input.amount_minor > this.settings.mandateMaxAmountMinor) errors.push({ field: 'amount_minor', code: 'over_cap' });

    const { start_date: start, end_date: end, day_of_month: day } = input.schedule;
    if (!isRealDate(start)) errors.push({ field: 'schedule.start_date', code: 'invalid_date' });
    else if (start < today) errors.push({ field: 'schedule.start_date', code: 'in_the_past' });
    if (end !== undefined && end !== null) {
      if (!isRealDate(end)) errors.push({ field: 'schedule.end_date', code: 'invalid_date' });
      else if (isRealDate(start) && end < start) errors.push({ field: 'schedule.end_date', code: 'before_start' });
      else if (isRealDate(start) && firstDue(start, day) > end) errors.push({ field: 'schedule.end_date', code: 'no_periods' });
    }
    if (errors.length > 0) fail(errors);
  }

  /** Programa un pago recurrente. Idempotente por `(comercio, modo, Idempotency-Key)`. */
  async create(merchantId: string, mode: Mode, idempotencyKey: string, requestHash: string, input: MandateInput): Promise<{ status: 200 | 201; body: MandateView }> {
    const result = await this.idempotency.execute({ scope: `${merchantId}:${mode}`, key: idempotencyKey, requestHash }, async (ctx) => {
      if (ctx.recoveryPoint !== 'started') throw new ProblemError('invalid_state_transition', { detail: 'La creación anterior quedó a medias: reintentá con otra Idempotency-Key' });
      const view = await ctx.atomic('created', async (client) => {
        const now = this.clock();
        await this.validate(client, merchantId, input, laPazDate(now));
        const id = newId('md');
        const { rows } = await client.query(
          `INSERT INTO mandates (id, merchant_id, mode, kind, beneficiary_merchant_id, amount_minor, currency, frequency, day_of_month, start_date, end_date, description, next_run_on, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'BOB', 'monthly', $7, $8, $9, $10, $11, $12) RETURNING ${COLUMNS}`,
          [
            id, merchantId, mode, input.kind, input.beneficiary_merchant_id, input.amount_minor, input.schedule.day_of_month, input.schedule.start_date,
            input.schedule.end_date ?? null, input.description ?? null, firstDue(input.schedule.start_date, input.schedule.day_of_month), now,
          ],
        );
        await emit(client, {
          type: 'mandate.created',
          merchantId,
          subject: id,
          aggregateType: 'mandate',
          aggregateId: id,
          data: {
            mandate_id: id,
            merchant_id: merchantId,
            mode,
            status: 'active',
            kind: input.kind,
            beneficiary_merchant_id: input.beneficiary_merchant_id,
            amount_minor: input.amount_minor,
            currency: 'BOB',
            frequency: 'monthly',
            day_of_month: input.schedule.day_of_month,
            start_date: input.schedule.start_date,
            end_date: input.schedule.end_date ?? null,
          },
        });
        return toView(rows[0]);
      });
      return { status: 201, body: view };
    });
    rethrowStoredProblem(result);
    return { status: result.replayed ? 200 : 201, body: result.body };
  }

  async list(merchantId: string, mode: Mode, limit: number, startingAfter: string | undefined): Promise<{ object: 'list'; has_more: boolean; next_cursor: string | null; data: MandateView[] }> {
    const cursor = startingAfter ? decodeCursor(startingAfter) : undefined;
    const params: unknown[] = [merchantId, mode, limit + 1];
    const after = cursor ? `AND (created_at, id) < ($4::timestamptz, $5)` : '';
    if (cursor) params.push(cursor.at, cursor.id);
    // Orden determinista: más nuevo primero con desempate por id, para que la paginación no cambie entre páginas.
    const { rows } = await this.pool.query(`SELECT ${COLUMNS} FROM mandates WHERE merchant_id = $1 AND mode = $2 ${after} ORDER BY created_at DESC, id DESC LIMIT $3`, params);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page[page.length - 1];
    return { object: 'list', has_more: hasMore, next_cursor: hasMore && last ? encodeCursor({ at: (last.created_at as Date).toISOString(), id: last.id as string }) : null, data: page.map(toView) };
  }

  /**
   * Cancela el mandato (404 si no es de ese comercio y modo). Los pagos ya ejecutados no se deshacen y los que ya tienen dinero
   * retenido en el libro mayor se completan; los que todavía no tocaron el libro mayor se cancelan. Repetir no hace nada.
   */
  async cancel(merchantId: string, mode: Mode, id: string): Promise<void> {
    await withTx(this.pool, async (client) => {
      const { rows } = await client.query('SELECT status FROM mandates WHERE id = $1 AND merchant_id = $2 AND mode = $3 FOR UPDATE', [id, merchantId, mode]);
      if (rows.length === 0) throw new ProblemError('resource_not_found');
      if (rows[0].status === 'canceled' || rows[0].status === 'completed') return;
      const now = this.clock();
      await client.query(`UPDATE mandates SET status = 'canceled', canceled_at = $2, next_run_on = NULL WHERE id = $1`, [id, now]);
      await client.query(
        `UPDATE scheduled_payments SET status = 'canceled', lease_until = NULL
          WHERE mandate_id = $1 AND status IN ('due', 'waiting_funds') AND phase = 'hold' AND hold_id IS NULL AND (lease_until IS NULL OR lease_until < $2)`,
        [id, now],
      );
      await emit(client, {
        type: 'mandate.canceled',
        merchantId,
        subject: id,
        aggregateType: 'mandate',
        aggregateId: id,
        data: { mandate_id: id, merchant_id: merchantId, mode, status: 'canceled', canceled_at: now.toISOString() },
      });
    });
  }
}

export { nextDue };
