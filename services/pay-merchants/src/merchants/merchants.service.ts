import { Inject, Injectable } from '@nestjs/common';
import { IdempotencyStore } from '@pay/idempotency';
import type { Queryable } from '@pay/outbox';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { PG_POOL } from '../database.module';
import { newId, sqlState, withTx } from '../db';
import { rethrowStoredProblem } from '../idempotent';
import { emit, iso } from './events';

export const REQUIRED_KYC_KINDS = ['constitucion', 'nit', 'seprec', 'licencia_funcionamiento', 'certificado_sedes', 'poder_representante'] as const;
export type KycKind = (typeof REQUIRED_KYC_KINDS)[number];

export type SuspensionReason = 'kyc_expired' | 'risk_review' | 'contract_breach' | 'manual';

export interface MerchantRow {
  id: string;
  display_name: string;
  legal_type: string;
  status: 'pending' | 'active' | 'suspended' | 'closed';
  suspension_reason: string | null;
  created_at: Date;
  activated_at: Date | null;
}

export interface MerchantAdminView {
  id: string;
  object: 'merchant';
  display_name: string;
  legal_type: string;
  status: MerchantRow['status'];
  suspension_reason: string | null;
  kyc: { status: string; risk_level: string | null; missing_documents: KycKind[] };
  contract: { current_version: number | null; accepted_version: number | null; up_to_date: boolean };
  created_at: string;
  activated_at: string | null;
}

export interface CreateMerchantInput {
  display_name: string;
  legal_name: string;
  legal_type: string;
  tax_id: string;
  directory_tenant_ref?: string;
}

/** Versión del contrato legal en vigencia: la de mayor número que ya empezó. */
export async function currentContractVersion(db: Queryable): Promise<number | null> {
  const { rows } = await db.query('SELECT version FROM contract_versions WHERE effective_from <= now() ORDER BY version DESC LIMIT 1');
  return rows.length === 0 ? null : Number(rows[0].version);
}

/** Bloquea y devuelve el comercio, o lanza 404. */
export async function lockMerchant(client: Queryable, id: string): Promise<MerchantRow> {
  const { rows } = await client.query(
    'SELECT id, display_name, legal_type, status, suspension_reason, created_at, activated_at FROM merchants WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (rows.length === 0) throw new ProblemError('resource_not_found');
  return rows[0] as unknown as MerchantRow;
}

@Injectable()
export class MerchantsService {
  private readonly idempotency: IdempotencyStore;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.idempotency = new IdempotencyStore(pool);
  }

  /** Vista de back-office: incluye qué documentos faltan y si el contrato aceptado es el vigente. */
  async view(db: Queryable, id: string): Promise<MerchantAdminView> {
    const merchant = await db.query(
      `SELECT m.id, m.display_name, m.legal_type, m.status, m.suspension_reason, m.created_at, m.activated_at,
              k.status AS kyc_status, k.risk_level,
              COALESCE((SELECT array_agg(DISTINCT d.kind) FROM kyc_documents d WHERE d.merchant_id = m.id), '{}') AS kinds,
              (SELECT max(a.version) FROM contract_acceptances a WHERE a.merchant_id = m.id) AS accepted_version
         FROM merchants m LEFT JOIN merchant_kyc k ON k.merchant_id = m.id WHERE m.id = $1`,
      [id],
    );
    if (merchant.rows.length === 0) throw new ProblemError('resource_not_found');
    const row = merchant.rows[0] as Record<string, unknown>;
    const current = await currentContractVersion(db);
    const accepted = await db.query('SELECT 1 FROM contract_acceptances WHERE merchant_id = $1 AND version = $2', [id, current ?? -1]);
    const present = new Set(row.kinds as string[]);
    return {
      id: row.id as string,
      object: 'merchant',
      display_name: row.display_name as string,
      legal_type: row.legal_type as string,
      status: row.status as MerchantRow['status'],
      suspension_reason: (row.suspension_reason as string | null) ?? null,
      kyc: {
        status: (row.kyc_status as string | null) ?? 'pending',
        risk_level: (row.risk_level as string | null) ?? null,
        missing_documents: REQUIRED_KYC_KINDS.filter((kind) => !present.has(kind)),
      },
      contract: {
        current_version: current,
        accepted_version: row.accepted_version === null ? null : Number(row.accepted_version),
        up_to_date: current !== null && accepted.rows.length > 0,
      },
      created_at: iso(row.created_at as Date),
      activated_at: row.activated_at ? iso(row.activated_at as Date) : null,
    };
  }

  /** Alta (7.1): idempotente por `Idempotency-Key`; queda `pending`. */
  async create(idempotencyKey: string, requestHash: string, input: CreateMerchantInput): Promise<{ status: number; body: MerchantAdminView; replayed: boolean }> {
    const result = await this.idempotency.execute({ scope: 'backoffice:merchants.create', key: idempotencyKey, requestHash }, async (ctx) => {
      const id = await ctx.atomic('created', async (client) => {
        const merchantId = newId('mc');
        try {
          await client.query(
            `INSERT INTO merchants (id, display_name, legal_name, legal_type, tax_id, directory_tenant_ref) VALUES ($1, $2, $3, $4, $5, $6)`,
            [merchantId, input.display_name, input.legal_name, input.legal_type, input.tax_id, input.directory_tenant_ref ?? null],
          );
        } catch (error) {
          if (sqlState(error) === '23505') {
            throw new ProblemError('validation_failed', { detail: 'Ya existe un comercio abierto con ese NIT', errors: [{ field: 'tax_id', code: 'already_registered' }] });
          }
          throw error;
        }
        await client.query('INSERT INTO merchant_kyc (merchant_id) VALUES ($1)', [merchantId]);
        await emit(client, {
          type: 'merchant.created',
          merchantId,
          subject: merchantId,
          aggregateType: 'merchant',
          aggregateId: merchantId,
          data: { merchant_id: merchantId, status: 'pending', created_at: iso(new Date()) },
        });
        return merchantId;
      });
      return { status: 201, body: await this.view(this.pool, id) };
    });
    rethrowStoredProblem(result);
    return { status: result.replayed ? 200 : result.status, body: result.body, replayed: result.replayed };
  }

  /**
   * Activa un comercio (REQ-P5-1). Exige KYC `approved` Y el contrato vigente aceptado. Si falta algo, 409 con el motivo
   * en `errors[]` y NO cambia nada.
   */
  async activate(id: string): Promise<MerchantAdminView> {
    await withTx(this.pool, async (client) => {
      const merchant = await lockMerchant(client, id);
      if (merchant.status !== 'pending' && merchant.status !== 'suspended') {
        throw new ProblemError('invalid_state_transition', { detail: `No se puede activar desde ${merchant.status}`, errors: [{ field: 'status', code: `from_${merchant.status}` }] });
      }
      const missing: { field: string; code: string }[] = [];
      const kyc = await client.query('SELECT status FROM merchant_kyc WHERE merchant_id = $1', [id]);
      if (kyc.rows[0]?.status !== 'approved') missing.push({ field: 'kyc', code: 'not_approved' });
      const current = await currentContractVersion(client);
      const accepted = await client.query('SELECT 1 FROM contract_acceptances WHERE merchant_id = $1 AND version = $2', [id, current ?? -1]);
      if (current === null || accepted.rows.length === 0) missing.push({ field: 'contract', code: 'not_accepted' });
      if (missing.length > 0) throw new ProblemError('invalid_state_transition', { detail: 'Faltan condiciones para activar el comercio', errors: missing });
      const now = new Date();
      await client.query(`UPDATE merchants SET status = 'active', activated_at = $2, suspended_at = NULL, suspension_reason = NULL WHERE id = $1`, [id, now]);
      await emit(client, {
        type: 'merchant.activated',
        merchantId: id,
        subject: id,
        aggregateType: 'merchant',
        aggregateId: id,
        data: { merchant_id: id, status: 'active', activated_at: iso(now) },
      });
    });
    return this.view(this.pool, id);
  }

  async suspend(id: string, reason: SuspensionReason): Promise<MerchantAdminView> {
    await withTx(this.pool, async (client) => {
      const merchant = await lockMerchant(client, id);
      if (merchant.status !== 'active') {
        throw new ProblemError('invalid_state_transition', { detail: `No se puede suspender desde ${merchant.status}`, errors: [{ field: 'status', code: `from_${merchant.status}` }] });
      }
      const now = new Date();
      await client.query(`UPDATE merchants SET status = 'suspended', suspended_at = $2, suspension_reason = $3 WHERE id = $1`, [id, now, reason]);
      await emit(client, {
        type: 'merchant.suspended',
        merchantId: id,
        subject: id,
        aggregateType: 'merchant',
        aggregateId: id,
        data: { merchant_id: id, status: 'suspended', suspended_at: iso(now), reason },
      });
    });
    return this.view(this.pool, id);
  }

  /** Cierre: terminal. Los consumidores dejan de aceptar al comercio por `merchant.closed`. */
  async close(id: string): Promise<MerchantAdminView> {
    await withTx(this.pool, async (client) => {
      const merchant = await lockMerchant(client, id);
      if (merchant.status === 'closed') {
        throw new ProblemError('invalid_state_transition', { detail: 'El comercio ya está cerrado', errors: [{ field: 'status', code: 'from_closed' }] });
      }
      const now = new Date();
      await client.query(`UPDATE merchants SET status = 'closed', closed_at = $2 WHERE id = $1`, [id, now]);
      await emit(client, {
        type: 'merchant.closed',
        merchantId: id,
        subject: id,
        aggregateType: 'merchant',
        aggregateId: id,
        data: { merchant_id: id, status: 'closed', closed_at: iso(now) },
      });
    });
    return this.view(this.pool, id);
  }
}


