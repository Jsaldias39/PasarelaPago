import type { Queryable } from '@pay/idempotency';
import type { CardMetadata } from '../backend/vault-backend';

export type Db = Queryable;

export interface SessionRow {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentIntentId: string | null;
  readonly saveCard: boolean;
  readonly status: 'open' | 'completed' | 'expired' | 'canceled';
  readonly captureUrl: string;
  readonly token: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface TokenRow extends CardMetadata {
  readonly token: string;
  readonly merchantId: string;
  readonly singleUse: boolean;
  readonly boundChargeId: string | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

const SESSION_COLUMNS = 'id, merchant_id, payment_intent_id, save_card, status, capture_url, token, expires_at, created_at';
const TOKEN_COLUMNS = 'token, merchant_id, brand, last4, exp_month, exp_year, fingerprint, single_use, bound_charge_id, deleted_at, created_at';

const mapSession = (r: Record<string, unknown>): SessionRow => ({
  id: r.id as string,
  merchantId: r.merchant_id as string,
  paymentIntentId: (r.payment_intent_id as string | null) ?? null,
  saveCard: r.save_card as boolean,
  status: r.status as SessionRow['status'],
  captureUrl: r.capture_url as string,
  token: (r.token as string | null) ?? null,
  expiresAt: new Date(r.expires_at as string),
  createdAt: new Date(r.created_at as string),
});

const mapToken = (r: Record<string, unknown>): TokenRow => ({
  token: r.token as string,
  merchantId: r.merchant_id as string,
  brand: r.brand as TokenRow['brand'],
  last4: r.last4 as string,
  expMonth: Number(r.exp_month),
  expYear: Number(r.exp_year),
  fingerprint: r.fingerprint as string,
  singleUse: r.single_use as boolean,
  boundChargeId: (r.bound_charge_id as string | null) ?? null,
  deletedAt: r.deleted_at ? new Date(r.deleted_at as string) : null,
  createdAt: new Date(r.created_at as string),
});

export const vaultRepo = {
  async insertSession(db: Db, s: { id: string; merchantId: string; paymentIntentId?: string | undefined; saveCard: boolean; captureUrl: string; expiresAt: Date }): Promise<void> {
    await db.query(
      `INSERT INTO capture_sessions (id, merchant_id, payment_intent_id, save_card, capture_url, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.merchantId, s.paymentIntentId ?? null, s.saveCard, s.captureUrl, s.expiresAt],
    );
  },
  async session(db: Db, id: string, options: { forUpdate?: boolean } = {}): Promise<SessionRow | null> {
    const { rows } = await db.query(`SELECT ${SESSION_COLUMNS} FROM capture_sessions WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] ? mapSession(rows[0]) : null;
  },
  /** Cierra la sesión solo si seguía abierta (CAS). */
  async closeSession(db: Db, id: string, status: 'completed' | 'expired' | 'canceled', token?: string): Promise<boolean> {
    const result = await db.query(
      `UPDATE capture_sessions SET status = $2, token = $3, completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END WHERE id = $1 AND status = 'open'`,
      [id, status, token ?? null],
    );
    return (result.rowCount ?? 0) === 1;
  },
  async insertToken(db: Db, t: { token: string; merchantId: string; singleUse: boolean } & CardMetadata): Promise<void> {
    await db.query(
      `INSERT INTO card_tokens (token, merchant_id, brand, last4, exp_month, exp_year, fingerprint, single_use) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (token) DO NOTHING`,
      [t.token, t.merchantId, t.brand, t.last4, t.expMonth, t.expYear, t.fingerprint, t.singleUse],
    );
  },
  /** El token de OTRO comercio es indistinguible de uno que no existe: devuelve `null` para ambos. */
  async tokenFor(db: Db, merchantId: string, token: string, options: { includeDeleted?: boolean; forUpdate?: boolean } = {}): Promise<TokenRow | null> {
    const { rows } = await db.query(
      `SELECT ${TOKEN_COLUMNS} FROM card_tokens WHERE token = $1 AND merchant_id = $2${options.includeDeleted ? '' : ' AND deleted_at IS NULL'}${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [token, merchantId],
    );
    return rows[0] ? mapToken(rows[0]) : null;
  },
  async markDeleted(db: Db, token: string): Promise<void> {
    await db.query('UPDATE card_tokens SET deleted_at = COALESCE(deleted_at, now()) WHERE token = $1', [token]);
  },
  /** Ata un token de un solo uso a su primer cobro. @returns `false` si ya estaba atado a OTRO cobro. */
  async bindCharge(db: Db, token: string, chargeId: string): Promise<boolean> {
    const result = await db.query('UPDATE card_tokens SET bound_charge_id = $2 WHERE token = $1 AND (bound_charge_id IS NULL OR bound_charge_id = $2)', [token, chargeId]);
    return (result.rowCount ?? 0) === 1;
  },
  async audit(db: Db, a: { token: string; merchantId: string; chargeId: string; caller: string; outcome: 'granted' | 'denied_not_found' | 'denied_bound_to_other_charge' | 'backend_error'; idempotencyKey?: string | undefined }): Promise<void> {
    await db.query('INSERT INTO reveal_audit (token, merchant_id, charge_id, caller, outcome, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6)', [a.token, a.merchantId, a.chargeId, a.caller, a.outcome, a.idempotencyKey ?? null]);
  },
};
