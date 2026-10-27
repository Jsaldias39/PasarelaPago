import { num, type Db } from './db';
import type { ChannelFee } from '../domain/quote';

export type MerchantStatus = 'pending' | 'active' | 'suspended' | 'closed';

/** Réplicas locales alimentadas por eventos (regla de separación #5). Un evento atrasado no pisa a uno más nuevo. */
export const replicasRepo = {
  /** @returns `true` si cambió algo; `false` si el evento era más viejo que lo que ya sabemos. */
  async upsertMerchantStatus(db: Db, merchantId: string, status: MerchantStatus, occurredAt: Date): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO merchant_replica (merchant_id, status, occurred_at) VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id) DO UPDATE SET status = EXCLUDED.status, occurred_at = EXCLUDED.occurred_at, updated_at = now()
       WHERE merchant_replica.occurred_at < EXCLUDED.occurred_at`,
      [merchantId, status, occurredAt],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async merchantStatus(db: Db, merchantId: string): Promise<MerchantStatus | null> {
    const { rows } = await db.query('SELECT status FROM merchant_replica WHERE merchant_id = $1', [merchantId]);
    return (rows[0]?.status as MerchantStatus | undefined) ?? null;
  },

  async upsertFeeSchedule(db: Db, input: { merchantId: string; version: number; currency: string; channels: readonly ChannelFee[]; effectiveFrom: Date; effectiveTo: Date | null }): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO fee_schedule_replica (merchant_id, version, currency, channels, effective_from, effective_to)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) ON CONFLICT (merchant_id, version) DO NOTHING`,
      [input.merchantId, input.version, input.currency, JSON.stringify(input.channels), input.effectiveFrom, input.effectiveTo],
    );
    return (result.rowCount ?? 0) === 1;
  },

  /** Tarifa vigente: la versión más alta cuya vigencia cubre `at`. */
  async effectiveFeeSchedule(db: Db, merchantId: string, at: Date): Promise<{ version: number; channels: ChannelFee[] } | null> {
    const { rows } = await db.query(
      `SELECT version, channels FROM fee_schedule_replica
        WHERE merchant_id = $1 AND effective_from <= $2 AND (effective_to IS NULL OR effective_to > $2)
        ORDER BY version DESC LIMIT 1`,
      [merchantId, at],
    );
    return rows[0] ? { version: num(rows[0].version), channels: rows[0].channels as ChannelFee[] } : null;
  },
};
