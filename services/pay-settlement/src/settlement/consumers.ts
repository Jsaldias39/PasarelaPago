import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';
import { processOnce } from '@pay/outbox';
import { PG_POOL } from '../database.module';

/**
 * Consumidores de eventos (inbox: efecto único por `(consumidor, evento)`). pay-settlement necesita saber QUÉ comercios existen sin leer
 * la base de nadie, y la única vía permitida son los eventos:
 *  - `ledger.transfer.posted` (pay-ledger): un crédito a `merchant:{id}:pending` es un comercio con ventas por liberar.
 *  - `fee_schedule.published` (pay-merchants): el abono mensual del tarifario vigente (D-07).
 * Entrega al menos una vez y sin orden entre agregados: un tarifario viejo nunca pisa a uno nuevo (`version`).
 */

const envelope = z.object({
  id: z.string().min(8).max(100),
  source: z.string(),
  type: z.string(),
  time: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
});

const transferData = z.object({ credit_account: z.string(), posted_at: z.iso.datetime() });
const feeScheduleData = z.object({
  merchant_id: z.string().regex(/^mc_[a-z0-9]{10,40}$/),
  version: z.number().int().min(1),
  currency: z.literal('BOB'),
  effective_from: z.iso.datetime(),
  effective_to: z.iso.datetime().nullable(),
  monthly_fee_minor: z.number().int().min(0).optional(),
});

export type Handled = 'processed' | 'duplicate' | 'ignored' | 'invalid';

export const CONSUMER_LEDGER = 'pay-settlement.ledger-transfer-posted';
export const CONSUMER_FEES = 'pay-settlement.fee-schedule-published';

@Injectable()
export class SettlementConsumers {
  private readonly logger = new Logger(SettlementConsumers.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Procesa un evento ya decodificado. `invalid` = no se puede procesar nunca (se descarta con registro, sin datos). */
  async handle(raw: unknown): Promise<Handled> {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('Evento descartado: el sobre no es válido');
      return 'invalid';
    }
    const event = parsed.data;
    if (event.type === 'ledger.transfer.posted' && event.source === '/pay-ledger') return this.onTransferPosted(event.id, event.data);
    if (event.type === 'fee_schedule.published' && event.source === '/pay-merchants') return this.onFeeSchedule(event.id, event.data);
    return 'ignored';
  }

  private async onTransferPosted(eventId: string, data: Record<string, unknown>): Promise<Handled> {
    const parsed = transferData.safeParse(data);
    if (!parsed.success) {
      this.logger.warn({ event: eventId }, 'Evento descartado: ledger.transfer.posted inválido');
      return 'invalid';
    }
    const merchant = /^merchant:(mc_[a-z0-9]{10,40}):pending$/.exec(parsed.data.credit_account)?.[1];
    if (!merchant) return 'ignored';
    return processOnce(this.pool, CONSUMER_LEDGER, eventId, async (client) => {
      const at = new Date(parsed.data.posted_at);
      await client.query(
        `INSERT INTO settlement_merchants (merchant_id, first_seen_at, last_activity_at) VALUES ($1, $2, $2)
         ON CONFLICT (merchant_id) DO UPDATE SET last_activity_at = GREATEST(settlement_merchants.last_activity_at, EXCLUDED.last_activity_at)`,
        [merchant, at],
      );
    });
  }

  private async onFeeSchedule(eventId: string, data: Record<string, unknown>): Promise<Handled> {
    const parsed = feeScheduleData.safeParse(data);
    if (!parsed.success) {
      this.logger.warn({ event: eventId }, 'Evento descartado: fee_schedule.published inválido');
      return 'invalid';
    }
    const plan = parsed.data;
    return processOnce(this.pool, CONSUMER_FEES, eventId, async (client) => {
      const now = new Date();
      // Un comercio con abono pero sin ventas también se liquida (el abono se cobra igual): entra al registro.
      await client.query(`INSERT INTO settlement_merchants (merchant_id, first_seen_at, last_activity_at) VALUES ($1, $2, $2) ON CONFLICT (merchant_id) DO NOTHING`, [plan.merchant_id, now]);
      // Solo la versión más nueva manda: un evento atrasado no hace retroceder el tarifario.
      await client.query(
        `INSERT INTO settlement_fee_plans (merchant_id, version, monthly_fee_minor, effective_from, effective_to, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (merchant_id) DO UPDATE SET version = EXCLUDED.version, monthly_fee_minor = EXCLUDED.monthly_fee_minor, effective_from = EXCLUDED.effective_from, effective_to = EXCLUDED.effective_to, updated_at = EXCLUDED.updated_at
          WHERE settlement_fee_plans.version < EXCLUDED.version`,
        [plan.merchant_id, plan.version, plan.monthly_fee_minor ?? 0, plan.effective_from, plan.effective_to, now],
      );
    });
  }
}
