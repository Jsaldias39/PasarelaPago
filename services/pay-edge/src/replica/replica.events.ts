/**
 * Validación a mano del sobre y de los datos de los eventos que pay-edge replica (`api_key.*` y `merchant.*` de
 * pay-merchants, ver contracts/asyncapi/merchants-schedules.yaml). Un evento mal formado se descarta (`term`) y se registra:
 * no se reintenta, porque reintentarlo no lo arregla.
 */
export type ReplicaEvent =
  | { readonly kind: 'api_key.created'; readonly eventId: string; readonly keyId: string; readonly merchantId: string; readonly mode: 'test' | 'live'; readonly keyHash: string }
  | { readonly kind: 'api_key.revoked'; readonly eventId: string; readonly keyId: string; readonly merchantId: string; readonly mode: 'test' | 'live'; readonly revokedAt: string }
  | { readonly kind: 'merchant.status'; readonly eventId: string; readonly merchantId: string; readonly status: 'active' | 'suspended' | 'closed'; readonly at: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^key_[a-z0-9]{10,40}$/;
const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const KEY_HASH = /^sha256\$[0-9a-f]{64}$/;
const SOURCE = '/pay-merchants';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const iso = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);
const mode = (value: unknown): 'test' | 'live' | null => (value === 'test' || value === 'live' ? value : null);

/** Devuelve el evento tipado, o `null` si no cumple el contrato. Nunca lanza. */
export function parseReplicaEvent(raw: unknown): ReplicaEvent | null {
  if (!isRecord(raw) || raw.specversion !== '1.0' || raw.source !== SOURCE || typeof raw.id !== 'string' || !UUID.test(raw.id) || !isRecord(raw.data)) return null;
  const data = raw.data;
  const eventId = raw.id;

  if (raw.type === 'api_key.created') {
    const m = mode(data.mode);
    if (typeof data.key_id !== 'string' || !KEY_ID.test(data.key_id) || typeof data.merchant_id !== 'string' || !MERCHANT_ID.test(data.merchant_id) || !m || typeof data.key_hash !== 'string' || !KEY_HASH.test(data.key_hash)) return null;
    return { kind: 'api_key.created', eventId, keyId: data.key_id, merchantId: data.merchant_id, mode: m, keyHash: data.key_hash };
  }
  if (raw.type === 'api_key.revoked') {
    const m = mode(data.mode);
    const at = iso(data.revoked_at);
    if (typeof data.key_id !== 'string' || !KEY_ID.test(data.key_id) || typeof data.merchant_id !== 'string' || !MERCHANT_ID.test(data.merchant_id) || !m || !at) return null;
    return { kind: 'api_key.revoked', eventId, keyId: data.key_id, merchantId: data.merchant_id, mode: m, revokedAt: at };
  }
  const statusAt: Record<string, ['active' | 'suspended' | 'closed', string]> = {
    'merchant.activated': ['active', 'activated_at'],
    'merchant.suspended': ['suspended', 'suspended_at'],
    'merchant.closed': ['closed', 'closed_at'],
  };
  const spec = typeof raw.type === 'string' ? statusAt[raw.type] : undefined;
  if (spec) {
    const at = iso(data[spec[1]]);
    if (typeof data.merchant_id !== 'string' || !MERCHANT_ID.test(data.merchant_id) || !at) return null;
    return { kind: 'merchant.status', eventId, merchantId: data.merchant_id, status: spec[0], at };
  }
  return null;
}
