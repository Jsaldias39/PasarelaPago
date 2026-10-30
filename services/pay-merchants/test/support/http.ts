import request, { type Test } from 'supertest';
import type { ContractValidator } from '@pay/testing';
import { bearer } from '../doubles/operator-auth.double';
import { KINDS, merchantInput, pdf, SHA } from './fixtures';
import type { TestContext } from './app';

/** Cuerpo JSON de una respuesta: las pruebas lo recorren por nombre (el tipo de `JSON.parse`, a propósito). */
export type Body = ReturnType<typeof JSON.parse>;

export type Method = 'get' | 'post' | 'put' | 'delete';
let sequence = 0;
export const uniqueKey = (): string => `idem-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;

/** Llamada de back-office como el servicio `pay-backoffice` con la credencial del [DOBLE] de operadores. */
export const bo = (ctx: TestContext, method: Method, path: string, as = 'op-admin'): Test =>
  request(ctx.server)[method](path).set('x-service-id', 'pay-backoffice').set('authorization', bearer(as));

/** Llamada pública como `pay-edge` en nombre de un comercio; `mode` es el de la clave del llamador (D-28). */
export const pub = (ctx: TestContext, method: Method, path: string, merchantId: string, mode: 'test' | 'live' = 'test'): Test =>
  request(ctx.server)[method](path).set('x-service-id', 'pay-edge').set('x-merchant-id', merchantId).set('x-pay-mode', mode);

/** Comprueba estado HTTP y que el cuerpo cumpla el contrato. Devuelve el cuerpo. */
export function verified(contract: ContractValidator, method: Method, path: string, res: request.Response, status: number): Body {
  expect({ status: res.status, body: res.body }).toMatchObject({ status });
  contract.assertResponse({ method, path: path.split('?')[0], status: res.status, body: res.body });
  return res.body;
}

export async function createMerchant(ctx: TestContext, n: number): Promise<string> {
  const res = await bo(ctx, 'post', '/merchants').set('idempotency-key', uniqueKey()).send(merchantInput(n));
  return verified(ctx.backofficeContract, 'post', '/merchants', res, 201).id;
}

export async function uploadAllDocs(ctx: TestContext, merchantId: string, skip: readonly string[] = []): Promise<void> {
  for (const kind of KINDS.filter((k) => !skip.includes(k))) {
    const res = await bo(ctx, 'post', `/merchants/${merchantId}/kyc/documents`, 'op-kyc').field('kind', kind).attach('file', pdf(kind), { filename: `${kind}.pdf`, contentType: 'application/pdf' });
    verified(ctx.backofficeContract, 'post', `/merchants/${merchantId}/kyc/documents`, res, 201);
  }
}

export async function approveKyc(ctx: TestContext, merchantId: string, risk = 'low'): Promise<void> {
  const res = await bo(ctx, 'put', `/merchants/${merchantId}/kyc/review`, 'op-kyc').send({ decision: 'approved', risk_level: risk });
  verified(ctx.backofficeContract, 'put', `/merchants/${merchantId}/kyc/review`, res, 200);
}

/** Publica la versión `version` del contrato si todavía no existe (las versiones son globales). */
export async function ensureContractVersion(ctx: TestContext, version: number): Promise<void> {
  const exists = await ctx.db.pool.query('SELECT 1 FROM contract_versions WHERE version = $1', [version]);
  if (exists.rows.length > 0) return;
  const res = await bo(ctx, 'post', '/contract_versions', 'op-legal').send({ version, text_sha256: SHA.replace(/a/g, version.toString(16)[0]) });
  verified(ctx.backofficeContract, 'post', '/contract_versions', res, 201);
}

/** Versión del contrato que rige ahora. */
export async function currentVersion(ctx: TestContext): Promise<number> {
  const { rows } = await ctx.db.pool.query('SELECT max(version) AS v FROM contract_versions WHERE effective_from <= now()');
  return Number(rows[0].v);
}

export async function acceptContract(ctx: TestContext, merchantId: string, version: number): Promise<void> {
  const res = await bo(ctx, 'post', `/merchants/${merchantId}/contract_acceptances`).send({ version, accepted_by_ref: 'representante-sintetico-01' });
  verified(ctx.backofficeContract, 'post', `/merchants/${merchantId}/contract_acceptances`, res, 201);
}

/** Comercio listo para activar: documentos, KYC aprobado y contrato vigente aceptado. */
export async function readyMerchant(ctx: TestContext, n: number): Promise<string> {
  const id = await createMerchant(ctx, n);
  await uploadAllDocs(ctx, id);
  await approveKyc(ctx, id);
  await ensureContractVersion(ctx, 1);
  await acceptContract(ctx, id, await currentVersion(ctx));
  return id;
}

export async function activeMerchant(ctx: TestContext, n: number): Promise<string> {
  const id = await readyMerchant(ctx, n);
  const res = await bo(ctx, 'post', `/merchants/${id}/activate`);
  verified(ctx.backofficeContract, 'post', `/merchants/${id}/activate`, res, 200);
  return id;
}

/** Eventos del outbox de un tipo, en orden, ya validados contra el AsyncAPI. */
export async function eventsOf(ctx: TestContext, type: string, aggregateId?: string): Promise<Body[]> {
  const { rows } = await ctx.db.pool.query(
    `SELECT subject, envelope FROM outbox_events WHERE type = $1 ${aggregateId ? 'AND aggregate_id = $2' : ''} ORDER BY seq`,
    aggregateId ? [type, aggregateId] : [type],
  );
  return rows.map((r) => {
    const errors = ctx.events.validate(r.subject as string, r.envelope);
    expect({ subject: r.subject, errors }).toEqual({ subject: r.subject, errors: [] });
    return r.envelope;
  });
}
