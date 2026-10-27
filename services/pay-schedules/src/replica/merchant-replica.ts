import type { Queryable } from '@pay/outbox';

/**
 * Réplica del estado de los comercios a partir de los eventos `merchant.*` de pay-merchants: pay-schedules no lee la base
 * de otro servicio. Validación a mano del sobre; un evento mal formado se descarta y se registra (reintentarlo no lo arregla).
 */
export interface MerchantStatusEvent {
  readonly eventId: string;
  readonly merchantId: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const iso = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

const BY_TYPE: Record<string, ['active' | 'suspended' | 'closed', string]> = {
  'merchant.activated': ['active', 'activated_at'],
  'merchant.suspended': ['suspended', 'suspended_at'],
  'merchant.closed': ['closed', 'closed_at'],
};

/** Devuelve el evento tipado, o `null` si no cumple el contrato. Nunca lanza. */
export function parseMerchantEvent(raw: unknown): MerchantStatusEvent | null {
  if (!isRecord(raw) || raw.specversion !== '1.0' || raw.source !== '/pay-merchants' || typeof raw.id !== 'string' || !UUID.test(raw.id) || !isRecord(raw.data)) return null;
  const spec = typeof raw.type === 'string' ? BY_TYPE[raw.type] : undefined;
  if (!spec) return null;
  const at = iso(raw.data[spec[1]]);
  const merchantId = raw.data.merchant_id;
  if (typeof merchantId !== 'string' || !MERCHANT_ID.test(merchantId) || !at) return null;
  return { eventId: raw.id, merchantId, status: spec[0], at };
}

/**
 * Aplica el hecho si es MÁS NUEVO que lo que ya se sabe: un `merchant.suspended` que llega tarde no reactiva a un comercio
 * que ya está cerrado. Un empate de hora lo gana el estado más restrictivo (closed > suspended > active).
 */
export async function applyMerchantEvent(client: Queryable, event: MerchantStatusEvent): Promise<void> {
  await client.query(
    `INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, $2, $3)
     ON CONFLICT (merchant_id) DO UPDATE SET status = EXCLUDED.status, as_of = EXCLUDED.as_of, updated_at = now()
      WHERE merchant_replica.as_of < EXCLUDED.as_of
         OR (merchant_replica.as_of = EXCLUDED.as_of
             AND (CASE EXCLUDED.status WHEN 'closed' THEN 2 WHEN 'suspended' THEN 1 ELSE 0 END)
               > (CASE merchant_replica.status WHEN 'closed' THEN 2 WHEN 'suspended' THEN 1 ELSE 0 END))`,
    [event.merchantId, event.status, event.at],
  );
}

export async function merchantStatus(db: Queryable, merchantId: string): Promise<'active' | 'suspended' | 'closed' | null> {
  const { rows } = await db.query('SELECT status FROM merchant_replica WHERE merchant_id = $1', [merchantId]);
  return rows.length === 0 ? null : (rows[0].status as 'active' | 'suspended' | 'closed');
}
