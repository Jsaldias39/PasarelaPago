import { createHash, randomBytes } from 'node:crypto';
import { hashRequest, IdempotencyStore, type IdempotencyResult, type PoolLike } from '@pay/idempotency';
import { ProblemError, type FieldError } from '@pay/problem';
import type { CardData, VaultBackend } from '../backend/vault-backend';
import { vaultRepo, type SessionRow, type TokenRow } from './vault.repo';

const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const PAYMENT_INTENT_ID = /^pi_[a-z0-9]{10,40}$/;
const CHARGE_ID = /^ch_[a-z0-9]{10,40}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (errors: FieldError[]): never => {
  throw new ProblemError('validation_failed', { errors });
};

export interface CreateCaptureInput {
  readonly merchantId: string;
  readonly paymentIntentId?: string;
  readonly saveCard: boolean;
  readonly expiresInSeconds: number;
}

export function parseCaptureSession(body: unknown): CreateCaptureInput {
  const errors: FieldError[] = [];
  if (!isObj(body)) return fail([{ field: '', code: 'invalid_type' }]);
  for (const key of Object.keys(body)) if (!['merchant_id', 'payment_intent_id', 'save_card', 'expires_in_seconds'].includes(key)) errors.push({ field: key, code: 'unknown_field' });
  if (typeof body.merchant_id !== 'string' || !MERCHANT_ID.test(body.merchant_id)) errors.push({ field: 'merchant_id', code: 'invalid_value' });
  if (body.payment_intent_id !== undefined && (typeof body.payment_intent_id !== 'string' || !PAYMENT_INTENT_ID.test(body.payment_intent_id))) errors.push({ field: 'payment_intent_id', code: 'invalid_value' });
  if (body.save_card !== undefined && typeof body.save_card !== 'boolean') errors.push({ field: 'save_card', code: 'invalid_value' });
  const ttl = body.expires_in_seconds;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) errors.push({ field: 'expires_in_seconds', code: 'out_of_range' });
  if (errors.length > 0) return fail(errors);
  return { merchantId: body.merchant_id as string, ...(body.payment_intent_id ? { paymentIntentId: body.payment_intent_id as string } : {}), saveCard: body.save_card === true, expiresInSeconds: ttl as number };
}

export function parseReveal(body: unknown): { chargeId: string } {
  if (!isObj(body)) return fail([{ field: '', code: 'invalid_type' }]);
  const errors: FieldError[] = [];
  for (const key of Object.keys(body)) if (key !== 'charge_id') errors.push({ field: key, code: 'unknown_field' });
  if (typeof body.charge_id !== 'string' || !CHARGE_ID.test(body.charge_id)) errors.push({ field: 'charge_id', code: 'invalid_value' });
  if (errors.length > 0) return fail(errors);
  return { chargeId: body.charge_id as string };
}

const sessionView = (s: SessionRow): Record<string, unknown> => ({
  id: s.id,
  object: 'capture_session',
  status: s.status,
  ...(s.status === 'open' ? { capture_url: s.captureUrl } : {}),
  token: s.token,
  expires_at: s.expiresAt.toISOString(),
  created_at: s.createdAt.toISOString(),
});

const tokenView = (t: TokenRow): Record<string, unknown> => ({
  token: t.token,
  object: 'card_token',
  brand: t.brand,
  last4: t.last4,
  exp_month: t.expMonth,
  exp_year: t.expYear,
  fingerprint: t.fingerprint,
  single_use: t.singleUse,
  created_at: t.createdAt.toISOString(),
});

/** Casos de uso de pay-vault. El dato sensible vive en el `VaultBackend`; acá solo metadatos, control por comercio y auditoría. */
export class VaultService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    private readonly pool: PoolLike,
    private readonly backend: VaultBackend,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.idempotency = new IdempotencyStore(pool, { lockTimeoutMs: 30_000, waitForCompletionMs: 5000 });
  }

  /** Un fallo del backend nunca devuelve su mensaje (podría traer datos): error genérico 500 y se registra solo el nombre. */
  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ProblemError) throw error;
      throw new ProblemError('internal_error');
    }
  }

  async createCaptureSession(caller: string, idempotencyKey: string, body: unknown): Promise<IdempotencyResult<Record<string, unknown>>> {
    const input = parseCaptureSession(body);
    const request = { scope: `vault:capture:${caller}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/capture_sessions', body }) };
    return this.idempotency.execute(request, async () => {
      const id = `cs_${createHash('sha256').update(`${caller}:${idempotencyKey}`).digest('hex').slice(0, 24)}`;
      const expiresAt = new Date(this.now().getTime() + input.expiresInSeconds * 1000);
      const { captureUrl } = await this.guarded(() => this.backend.openCapture({ sessionId: id, merchantId: input.merchantId, saveCard: input.saveCard, expiresAt }));
      await vaultRepo.insertSession(this.pool, { id, merchantId: input.merchantId, paymentIntentId: input.paymentIntentId, saveCard: input.saveCard, captureUrl, expiresAt });
      const row = await vaultRepo.session(this.pool, id);
      return { status: 201, body: sessionView(row as SessionRow) };
    });
  }

  async getCaptureSession(id: string): Promise<Record<string, unknown>> {
    let session = await vaultRepo.session(this.pool, id);
    if (!session) throw new ProblemError('resource_not_found');
    if (session.status === 'open') {
      if (session.expiresAt.getTime() < this.now().getTime()) {
        await vaultRepo.closeSession(this.pool, id, 'expired');
      } else {
        const state = await this.guarded(() => this.backend.getCapture(id));
        if (state.status === 'completed') {
          // El token y la sesión se cierran juntos: no existe un token sin su sesión completada ni al revés.
          await this.transaction(async (db) => {
            await vaultRepo.insertToken(db, { token: state.token, merchantId: session!.merchantId, singleUse: !session!.saveCard, ...state.card });
            await vaultRepo.closeSession(db, id, 'completed', state.token);
          });
        } else if (state.status === 'expired' || state.status === 'canceled') {
          await vaultRepo.closeSession(this.pool, id, state.status);
        }
      }
      session = (await vaultRepo.session(this.pool, id)) as SessionRow;
    }
    return sessionView(session);
  }

  async getToken(merchantId: string, token: string): Promise<Record<string, unknown>> {
    const row = await vaultRepo.tokenFor(this.pool, merchantId, token);
    if (!row) throw new ProblemError('resource_not_found');
    return tokenView(row);
  }

  /** Idempotente: borrar un token que ya se borró es 204. Un token que nunca fue de este comercio es 404. */
  async deleteToken(merchantId: string, token: string): Promise<void> {
    const row = await vaultRepo.tokenFor(this.pool, merchantId, token, { includeDeleted: true });
    if (!row) throw new ProblemError('resource_not_found');
    await this.guarded(() => this.backend.delete(token));
    await vaultRepo.markDeleted(this.pool, token);
  }

  /**
   * Entrega los datos de tarjeta a pay-connectors. Deja rastro SIEMPRE (también las negativas) y, si no puede dejarlo, no
   * entrega nada. NO usa el almacén de idempotencia: guardaría la respuesta (el PAN) en una tabla. Es de lectura: repetirla es inocuo.
   */
  async reveal(caller: string, merchantId: string, token: string, idempotencyKey: string | undefined, body: unknown): Promise<CardData> {
    const { chargeId } = parseReveal(body);
    const audit = (outcome: 'granted' | 'denied_not_found' | 'denied_bound_to_other_charge' | 'backend_error') =>
      vaultRepo.audit(this.pool, { token, merchantId, chargeId, caller, outcome, idempotencyKey });
    const row = await vaultRepo.tokenFor(this.pool, merchantId, token);
    if (!row) {
      await audit('denied_not_found');
      throw new ProblemError('resource_not_found');
    }
    if (row.singleUse && !(await vaultRepo.bindCharge(this.pool, token, chargeId))) {
      await audit('denied_bound_to_other_charge');
      throw new ProblemError('resource_not_found');
    }
    await audit('granted'); // primero el rastro: sin él no sale ningún dato
    let card: CardData | null;
    try {
      card = await this.backend.reveal(token);
    } catch {
      await audit('backend_error');
      throw new ProblemError('internal_error');
    }
    if (!card) throw new ProblemError('resource_not_found');
    return card;
  }

  /** Borra los tokens de un solo uso ya usados hace más de `olderThanMs` (para un job; el contrato dice «se elimina después»). */
  async purgeSingleUse(olderThanMs: number): Promise<number> {
    const { rows } = await this.pool.query(
      `UPDATE card_tokens SET deleted_at = now() WHERE single_use AND bound_charge_id IS NOT NULL AND deleted_at IS NULL AND created_at < $1 RETURNING token`,
      [new Date(this.now().getTime() - olderThanMs)],
    );
    for (const r of rows) await this.backend.delete(r.token as string);
    return rows.length;
  }

  private async transaction<T>(work: (db: PoolLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client as unknown as PoolLike);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const newVaultId = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;
