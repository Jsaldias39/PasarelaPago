import { Inject, Injectable } from '@nestjs/common';
import type { Queryable } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { withTx } from '../db';
import { PG_POOL } from '../database.module';
import type { RuleSet } from './engine';

export const CLOCK = Symbol('CLOCK');
export type Clock = () => Date;

export interface RuleSetInput {
  effective_from?: string;
  max_amount_minor?: number;
  merchant_daily_amount_minor?: number;
  payer_daily_amount_minor?: number;
  payer_velocity?: { max: number; window_seconds: number };
  merchant_velocity?: { max: number; window_seconds: number };
  hours?: { from: number; to: number };
}

export interface RuleSetView {
  object: 'risk_rule_set';
  version: number;
  effective_from: string;
  max_amount_minor: number | null;
  merchant_daily_amount_minor: number | null;
  payer_daily_amount_minor: number | null;
  payer_velocity: { max: number; window_seconds: number } | null;
  merchant_velocity: { max: number; window_seconds: number } | null;
  hours: { from: number; to: number } | null;
  published_by: string;
}

const big = (value: unknown): bigint | null => (value === null || value === undefined ? null : BigInt(value as string));
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

interface Row {
  version: number;
  effective_from: Date;
  max_amount_minor: string | null;
  merchant_daily_amount_minor: string | null;
  payer_daily_amount_minor: string | null;
  payer_velocity_max: number | null;
  payer_velocity_window_seconds: number | null;
  merchant_velocity_max: number | null;
  merchant_velocity_window_seconds: number | null;
  hours_from: number | null;
  hours_to: number | null;
  published_by: string;
}

const COLUMNS = `version, effective_from, max_amount_minor::text, merchant_daily_amount_minor::text, payer_daily_amount_minor::text,
  payer_velocity_max, payer_velocity_window_seconds, merchant_velocity_max, merchant_velocity_window_seconds, hours_from, hours_to, published_by`;

export function toRuleSet(row: Row): RuleSet {
  return {
    version: Number(row.version),
    maxAmountMinor: big(row.max_amount_minor),
    merchantDailyAmountMinor: big(row.merchant_daily_amount_minor),
    payerDailyAmountMinor: big(row.payer_daily_amount_minor),
    payerVelocity: row.payer_velocity_max === null ? null : { max: Number(row.payer_velocity_max), windowSeconds: Number(row.payer_velocity_window_seconds) },
    merchantVelocity: row.merchant_velocity_max === null ? null : { max: Number(row.merchant_velocity_max), windowSeconds: Number(row.merchant_velocity_window_seconds) },
    hours: row.hours_from === null ? null : { from: Number(row.hours_from), to: Number(row.hours_to) },
  };
}

const toView = (row: Row): RuleSetView => ({
  object: 'risk_rule_set',
  version: Number(row.version),
  effective_from: row.effective_from.toISOString(),
  max_amount_minor: num(row.max_amount_minor),
  merchant_daily_amount_minor: num(row.merchant_daily_amount_minor),
  payer_daily_amount_minor: num(row.payer_daily_amount_minor),
  payer_velocity: row.payer_velocity_max === null ? null : { max: Number(row.payer_velocity_max), window_seconds: Number(row.payer_velocity_window_seconds) },
  merchant_velocity: row.merchant_velocity_max === null ? null : { max: Number(row.merchant_velocity_max), window_seconds: Number(row.merchant_velocity_window_seconds) },
  hours: row.hours_from === null ? null : { from: Number(row.hours_from), to: Number(row.hours_to) },
  published_by: row.published_by,
});

@Injectable()
export class RuleSetsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Conjunto vigente en `now`: el de mayor `effective_from` que ya empezó (la versión 1 «sin límites» siempre existe). */
  async currentRows(db: Queryable, now: Date): Promise<Row> {
    const { rows } = await db.query(`SELECT ${COLUMNS} FROM risk_rule_sets WHERE effective_from <= $1 ORDER BY effective_from DESC, version DESC LIMIT 1`, [now]);
    return rows[0] as unknown as Row;
  }

  async current(db: Queryable, now: Date): Promise<RuleSet> {
    return toRuleSet(await this.currentRows(db, now));
  }

  async currentView(): Promise<RuleSetView> {
    return toView(await this.currentRows(this.pool, this.clock()));
  }

  /** Publica la versión siguiente. Las anteriores quedan intactas (la tabla es inmutable) para poder reproducir cada decisión. */
  async publish(input: RuleSetInput, operatorSub: string): Promise<RuleSetView> {
    const now = this.clock();
    const effectiveFrom = input.effective_from ? new Date(input.effective_from) : now;
    // 5 s de tolerancia por el desfase entre el reloj del cliente y el del servicio.
    if (effectiveFrom.getTime() < now.getTime() - 5000) throw new ProblemError('validation_failed', { errors: [{ field: 'effective_from', code: 'in_the_past' }] });
    return withTx(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('risk:rule_sets', 0))`);
      const last = await client.query('SELECT version, effective_from FROM risk_rule_sets ORDER BY version DESC LIMIT 1');
      if (effectiveFrom < (last.rows[0].effective_from as Date)) {
        throw new ProblemError('validation_failed', { errors: [{ field: 'effective_from', code: 'before_previous_version' }] });
      }
      const version = Number(last.rows[0].version) + 1;
      const { rows } = await client.query(
        `INSERT INTO risk_rule_sets (version, effective_from, max_amount_minor, merchant_daily_amount_minor, payer_daily_amount_minor,
            payer_velocity_max, payer_velocity_window_seconds, merchant_velocity_max, merchant_velocity_window_seconds, hours_from, hours_to, published_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${COLUMNS}`,
        [
          version, effectiveFrom, input.max_amount_minor ?? null, input.merchant_daily_amount_minor ?? null, input.payer_daily_amount_minor ?? null,
          input.payer_velocity?.max ?? null, input.payer_velocity?.window_seconds ?? null, input.merchant_velocity?.max ?? null, input.merchant_velocity?.window_seconds ?? null,
          input.hours?.from ?? null, input.hours?.to ?? null, operatorSub, now,
        ],
      );
      return toView(rows[0] as unknown as Row);
    });
  }
}
