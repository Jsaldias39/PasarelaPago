import { Inject, Injectable } from '@nestjs/common';
import type { Queryable } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { withTx } from '../db';
import { emit, iso } from '../merchants/events';
import { lockMerchant } from '../merchants/merchants.service';
import { type ChannelRule, quoteFee, validateChannels } from './quote';

export interface FeeScheduleView {
  object: 'fee_schedule';
  merchant_id: string;
  version: number;
  currency: 'BOB';
  effective_from: string;
  monthly_fee_minor: number;
  channels: ChannelRule[];
}

const num = (value: unknown): number => Number(value);

@Injectable()
export class FeesService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Versión en vigencia: la de mayor `effective_from` que ya empezó. `null` si todavía no hay ninguna. */
  async current(db: Queryable, merchantId: string): Promise<FeeScheduleView | null> {
    const version = await db.query(
      `SELECT version, effective_from, monthly_fee_minor FROM fee_schedule_versions
        WHERE merchant_id = $1 AND effective_from <= now() ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [merchantId],
    );
    if (version.rows.length === 0) return null;
    return this.load(db, merchantId, num(version.rows[0].version), version.rows[0].effective_from as Date, num(version.rows[0].monthly_fee_minor));
  }

  private async load(db: Queryable, merchantId: string, version: number, effectiveFrom: Date, monthly: number): Promise<FeeScheduleView> {
    const { rows } = await db.query(
      'SELECT channel, percent, fixed_minor, min_minor, cap_minor FROM fee_schedule_channels WHERE merchant_id = $1 AND version = $2 ORDER BY channel',
      [merchantId, version],
    );
    return {
      object: 'fee_schedule',
      merchant_id: merchantId,
      version,
      currency: 'BOB',
      effective_from: iso(effectiveFrom),
      monthly_fee_minor: monthly,
      channels: rows.map((r) => ({
        channel: r.channel as ChannelRule['channel'],
        percent: r.percent as string,
        fixed_minor: num(r.fixed_minor),
        ...(r.min_minor !== null && { min_minor: num(r.min_minor) }),
        ...(r.cap_minor !== null && { cap_minor: num(r.cap_minor) }),
      })),
    };
  }

  /**
   * Publica una versión nueva del tarifario (REQ-P5-3). Las anteriores quedan intactas (las tablas son inmutables) y una
   * versión rige hasta que empieza la siguiente. No se publican versiones con inicio en el pasado.
   */
  async publish(merchantId: string, input: { effective_from?: string; monthly_fee_minor?: number; channels: ChannelRule[] }, operatorSub: string): Promise<FeeScheduleView> {
    const errors = validateChannels(input.channels);
    if (input.monthly_fee_minor !== undefined && (!Number.isSafeInteger(input.monthly_fee_minor) || input.monthly_fee_minor < 0)) errors.push({ field: 'monthly_fee_minor', code: 'invalid' });
    if (errors.length > 0) throw new ProblemError('validation_failed', { errors });

    return withTx(this.pool, async (client) => {
      const merchant = await lockMerchant(client, merchantId);
      if (merchant.status === 'closed') throw new ProblemError('invalid_state_transition', { errors: [{ field: 'status', code: 'from_closed' }] });
      const now = new Date();
      const effectiveFrom = input.effective_from ? new Date(input.effective_from) : now;
      // 5 s de tolerancia por el desfase entre el reloj del cliente y el de la base.
      if (effectiveFrom.getTime() < now.getTime() - 5000) throw new ProblemError('validation_failed', { errors: [{ field: 'effective_from', code: 'in_the_past' }] });
      const last = await client.query('SELECT version, effective_from FROM fee_schedule_versions WHERE merchant_id = $1 ORDER BY version DESC LIMIT 1', [merchantId]);
      const version = last.rows.length === 0 ? 1 : num(last.rows[0].version) + 1;
      if (last.rows.length > 0 && effectiveFrom < (last.rows[0].effective_from as Date)) {
        throw new ProblemError('validation_failed', { errors: [{ field: 'effective_from', code: 'before_previous_version' }] });
      }
      const monthly = input.monthly_fee_minor ?? 0;
      await client.query(
        'INSERT INTO fee_schedule_versions (merchant_id, version, effective_from, monthly_fee_minor, published_by) VALUES ($1, $2, $3, $4, $5)',
        [merchantId, version, effectiveFrom, monthly, operatorSub],
      );
      for (const rule of input.channels) {
        await client.query(
          'INSERT INTO fee_schedule_channels (merchant_id, version, channel, percent, fixed_minor, min_minor, cap_minor) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [merchantId, version, rule.channel, rule.percent, rule.fixed_minor ?? 0, rule.min_minor ?? null, rule.cap_minor ?? null],
        );
      }
      const view = await this.load(client, merchantId, version, effectiveFrom, monthly);
      await emit(client, {
        type: 'fee_schedule.published',
        merchantId,
        subject: merchantId,
        aggregateType: 'fee_schedule',
        aggregateId: `${merchantId}:${version}`,
        data: {
          merchant_id: merchantId,
          version,
          currency: 'BOB',
          effective_from: iso(effectiveFrom),
          effective_to: null,
          channels: view.channels,
          monthly_fee_minor: monthly,
        },
      });
      return view;
    });
  }

  /** Cotiza un importe con el tarifario vigente. */
  async quote(merchantId: string, channel: string, amountMinor: bigint) {
    const exists = await this.pool.query('SELECT 1 FROM merchants WHERE id = $1', [merchantId]);
    if (exists.rows.length === 0) throw new ProblemError('resource_not_found');
    const schedule = await this.current(this.pool, merchantId);
    if (!schedule) throw new ProblemError('resource_not_found', { detail: 'El comercio no tiene un tarifario en vigencia' });
    const { fee_minor, net_minor } = quoteFee(schedule.channels, channel, amountMinor);
    return { object: 'fee_quote' as const, channel, amount_minor: Number(amountMinor), fee_minor: Number(fee_minor), net_minor: Number(net_minor), schedule_version: schedule.version };
  }
}
