import { Inject, Injectable } from '@nestjs/common';
import { generateApiKey, type ApiKeyMode } from '@pay/api-key';
import { IdempotencyStore } from '@pay/idempotency';
import type { Queryable } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { withTx } from '../db';
import { rethrowStoredProblem } from '../idempotent';
import { emit, iso } from '../merchants/events';
import { lockMerchant, type MerchantRow } from '../merchants/merchants.service';
import { SETTINGS, type Settings } from '../settings';

export interface ApiKeyView {
  id: string;
  object: 'api_key';
  mode: ApiKeyMode;
  label?: string;
  last4: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
}

export type RevokeReason = 'revoked_by_merchant' | 'rotated' | 'compromised';

interface KeyRow {
  key_id: string;
  merchant_id: string;
  mode: ApiKeyMode;
  label: string | null;
  last4: string;
  created_at: Date;
  revoked_at: Date | null;
  grace_ends_at: Date | null;
}

const toView = (row: KeyRow): ApiKeyView => ({
  id: row.key_id,
  object: 'api_key',
  mode: row.mode,
  ...(row.label !== null && { label: row.label }),
  last4: row.last4,
  created_at: iso(row.created_at),
  revoked_at: row.revoked_at ? iso(row.revoked_at) : null,
  expires_at: row.grace_ends_at ? iso(row.grace_ends_at) : null,
});

export interface CreatedKey {
  /** 201 al crear, 200 si es una repetición (la repetición NUNCA lleva el secreto). */
  status: 200 | 201;
  body: ApiKeyView & { secret?: string };
  replayed: boolean;
}

@Injectable()
export class ApiKeysService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  /**
   * Quién puede tener claves: las `test` cualquier comercio `pending` o `active`; las `live` solo uno `active`.
   * Un comercio suspendido no crea ni rota claves (403 `merchant_suspended`).
   */
  private assertCanHoldKeys(merchant: MerchantRow, mode: ApiKeyMode): void {
    if (merchant.status === 'suspended') throw new ProblemError('merchant_suspended');
    if (merchant.status === 'closed') throw new ProblemError('forbidden');
    if (mode === 'live' && merchant.status !== 'active') throw new ProblemError('forbidden', { detail: 'Las claves live requieren un comercio activo' });
  }

  private async insertKey(client: Queryable, merchantId: string, mode: ApiKeyMode, label: string | undefined) {
    const active = await client.query('SELECT count(*)::int AS n FROM api_keys WHERE merchant_id = $1 AND revoked_at IS NULL', [merchantId]);
    if (Number(active.rows[0].n) >= this.settings.apiKeyMaxActive) {
      throw new ProblemError('validation_failed', { errors: [{ field: 'mode', code: 'too_many_active_keys' }] });
    }
    const key = generateApiKey(mode);
    const { rows } = await client.query(
      'INSERT INTO api_keys (key_id, merchant_id, mode, label, last4, key_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at',
      [key.keyId, merchantId, mode, label ?? null, key.last4, key.keyHash],
    );
    const createdAt = rows[0].created_at as Date;
    // D-27: se publica el hash que devuelve generateApiKey y el modo; el secreto nunca sale de acá.
    await emit(client, {
      type: 'api_key.created',
      merchantId,
      subject: key.keyId,
      aggregateType: 'api_key',
      aggregateId: key.keyId,
      data: { key_id: key.keyId, merchant_id: merchantId, mode, key_hash: key.keyHash, last4: key.last4, created_at: iso(createdAt) },
    });
    const view: ApiKeyView = { id: key.keyId, object: 'api_key', mode, ...(label !== undefined && { label }), last4: key.last4, created_at: iso(createdAt), revoked_at: null, expires_at: null };
    return { view, token: key.token };
  }

  /** Crea una clave. El secreto se devuelve UNA vez; en la base queda solo su hash y la repetición no lo trae. */
  async create(merchantId: string, idempotencyKey: string, requestHash: string, input: { mode: ApiKeyMode; label?: string }): Promise<CreatedKey> {
    let token: string | undefined;
    const result = await this.idempotency.execute({ scope: merchantId, key: idempotencyKey, requestHash }, async (ctx) => {
      if (ctx.recoveryPoint !== 'started') {
        throw new ProblemError('invalid_state_transition', { detail: 'La creación anterior quedó a medias: generá otra clave con otra Idempotency-Key' });
      }
      const view = await ctx.atomic('created', async (client) => {
        this.assertCanHoldKeys(await lockMerchant(client, merchantId), input.mode);
        const created = await this.insertKey(client, merchantId, input.mode, input.label);
        token = created.token;
        return created.view;
      });
      return { status: 201, body: view };
    });
    return this.respond(result, token);
  }

  /** Rota: crea la clave nueva y deja la anterior válida hasta que termine el periodo de gracia. */
  async rotate(merchantId: string, keyId: string, idempotencyKey: string, requestHash: string, callerMode: ApiKeyMode): Promise<CreatedKey> {
    let token: string | undefined;
    const result = await this.idempotency.execute({ scope: merchantId, key: idempotencyKey, requestHash }, async (ctx) => {
      if (ctx.recoveryPoint !== 'started') {
        throw new ProblemError('invalid_state_transition', { detail: 'La rotación anterior quedó a medias: revisá tus claves antes de reintentar' });
      }
      const view = await ctx.atomic('rotated', async (client) => {
        const merchant = await lockMerchant(client, merchantId);
        const old = await client.query('SELECT mode, label, revoked_at, grace_ends_at FROM api_keys WHERE key_id = $1 AND merchant_id = $2 AND mode = $3 FOR UPDATE', [keyId, merchantId, callerMode]);
        // Una clave de otro modo se trata como inexistente (404, D-28).
        if (old.rows.length === 0) throw new ProblemError('resource_not_found');
        const row = old.rows[0] as { mode: ApiKeyMode; label: string | null; revoked_at: Date | null; grace_ends_at: Date | null };
        if (row.revoked_at !== null || row.grace_ends_at !== null) {
          throw new ProblemError('invalid_state_transition', { detail: 'La clave ya está revocada o ya fue rotada' });
        }
        this.assertCanHoldKeys(merchant, row.mode);
        const graceEnds = new Date(Date.now() + this.settings.apiKeyRotationGraceSeconds * 1000);
        await client.query('UPDATE api_keys SET grace_ends_at = $2 WHERE key_id = $1', [keyId, graceEnds]);
        const created = await this.insertKey(client, merchantId, row.mode, row.label ?? undefined);
        token = created.token;
        return created.view;
      });
      return { status: 201, body: view };
    });
    return this.respond(result, token);
  }

  private respond(result: { status: number; body: ApiKeyView; replayed: boolean }, token: string | undefined): CreatedKey {
    rethrowStoredProblem(result);
    if (result.replayed) return { status: 200, body: result.body, replayed: true };
    return { status: 201, body: { ...result.body, ...(token !== undefined && { secret: token }) }, replayed: false };
  }

  async list(merchantId: string, mode: ApiKeyMode): Promise<{ object: 'list'; has_more: boolean; next_cursor: null; data: ApiKeyView[] }> {
    const { rows } = await this.pool.query(
      `SELECT key_id, merchant_id, mode, label, last4, created_at, revoked_at, grace_ends_at FROM api_keys
        WHERE merchant_id = $1 AND mode = $2 ORDER BY created_at DESC, key_id DESC LIMIT 101`,
      [merchantId, mode],
    );
    return { object: 'list', has_more: rows.length > 100, next_cursor: null, data: (rows.slice(0, 100) as unknown as KeyRow[]).map(toView) };
  }

  /** Revoca una clave del comercio (404 si no es suya o es de otro modo que el llamador). Repetir la revocación no hace nada ni publica otro evento. */
  async revoke(merchantId: string, keyId: string, reason: RevokeReason, now = new Date(), onlyMode?: ApiKeyMode): Promise<void> {
    await withTx(this.pool, async (client) => {
      // `onlyMode` lo fija la API pública (D-28); el back-office de seguridad opera sobre cualquier modo.
      const { rows } = await client.query('SELECT mode, revoked_at FROM api_keys WHERE key_id = $1 AND merchant_id = $2 AND ($3::text IS NULL OR mode = $3) FOR UPDATE', [keyId, merchantId, onlyMode ?? null]);
      if (rows.length === 0) throw new ProblemError('resource_not_found');
      if (rows[0].revoked_at !== null) return;
      await this.markRevoked(client, merchantId, keyId, rows[0].mode as ApiKeyMode, reason, now);
    });
  }

  private async markRevoked(client: Queryable, merchantId: string, keyId: string, mode: ApiKeyMode, reason: RevokeReason, now: Date): Promise<void> {
    await client.query('UPDATE api_keys SET revoked_at = $2, revoke_reason = $3 WHERE key_id = $1', [keyId, now, reason]);
    await emit(client, {
      type: 'api_key.revoked',
      merchantId,
      subject: keyId,
      aggregateType: 'api_key',
      aggregateId: keyId,
      data: { key_id: keyId, merchant_id: merchantId, mode, reason, revoked_at: iso(now) },
    });
  }

  /**
   * Revoca las claves cuyo periodo de gracia terminó (`reason: rotated`). `pay-edge` mantiene válida la anterior hasta
   * que le llega este evento. Varias réplicas pueden correrlo a la vez: `SKIP LOCKED` evita que dos tomen la misma.
   *
   * @returns Cuántas claves revocó.
   */
  async sweepRotated(now = new Date(), batch = 100): Promise<number> {
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT key_id, merchant_id, mode FROM api_keys
          WHERE revoked_at IS NULL AND grace_ends_at IS NOT NULL AND grace_ends_at <= $1
          ORDER BY grace_ends_at, key_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, batch],
      );
      for (const row of rows) await this.markRevoked(client, row.merchant_id as string, row.key_id as string, row.mode as ApiKeyMode, 'rotated', now);
      return rows.length;
    });
  }
}
