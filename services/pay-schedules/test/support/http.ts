import { randomBytes } from 'node:crypto';
import request, { type Test } from 'supertest';
import type { ContractValidator } from '@pay/testing';
import type { TestContext } from './app';

/** Cuerpo JSON de una respuesta: las pruebas lo recorren por nombre (el tipo de `JSON.parse`, a propósito). */
export type Body = ReturnType<typeof JSON.parse>;

let sequence = 0;
export const uniqueKey = (): string => `idem-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const newMerchant = (): string => {
  let body = '';
  for (const byte of randomBytes(16)) body += ALPHABET[byte % 32];
  return `mc_${body}`;
};

export const mandateBody = (beneficiary: string, over: Record<string, unknown> = {}, schedule: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'pay_obligation',
  beneficiary_merchant_id: beneficiary,
  amount_minor: 100_000,
  currency: 'BOB',
  schedule: { frequency: 'monthly', day_of_month: 15, start_date: '2026-03-10', end_date: null, ...schedule },
  description: 'Obligación mensual de prueba',
  ...over,
});

type Method = 'get' | 'post' | 'delete';
/** Llamada pública como `pay-edge` en nombre de un comercio; `mode` es el de la clave del llamador (D-28). */
export const pub = (ctx: TestContext, method: Method, path: string, merchantId: string, mode: 'test' | 'live' = 'test'): Test =>
  request(ctx.server)[method](path).set('x-service-id', 'pay-edge').set('x-merchant-id', merchantId).set('x-pay-mode', mode);

export const createMandate = (ctx: TestContext, merchantId: string, body: object, key = uniqueKey(), mode: 'test' | 'live' = 'test'): Test =>
  pub(ctx, 'post', '/mandates', merchantId, mode).set('idempotency-key', key).send(body);

export function verified(contract: ContractValidator, method: 'get' | 'post' | 'delete', path: string, res: request.Response, status: number): Body {
  expect({ status: res.status, body: res.body }).toMatchObject({ status });
  contract.assertResponse({ method, path, status: res.status, body: res.body });
  return res.body;
}

/**
 * DEFECTO CONOCIDO DEL CONTRATO (PR-10, dueño P1): en `public-v1.yaml`, `Mandate` es `allOf: [MandateCreate, {id, object, status, …}]` y
 * `MandateCreate` trae `additionalProperties: false`, así que NINGUNA respuesta con `id` lo cumple. Este verificador tolera SOLO esos
 * cinco campos de la segunda rama y exige que el resto del contrato se cumpla y que esos campos estén presentes con su forma.
 */
const MANDATE_BRANCH_FIELDS = ['id', 'object', 'status', 'next_run_on', 'created_at'];
export function verifiedMandate(contract: ContractValidator, method: 'get' | 'post', path: string, res: request.Response, status: number): Body {
  expect({ status: res.status, body: res.body }).toMatchObject({ status });
  const items: Record<string, unknown>[] = path === '/mandates' && method === 'get' ? res.body.data : [res.body];
  const errors = contract.validateResponse({ method, path, status: res.status, body: res.body }).filter((e) => !MANDATE_BRANCH_FIELDS.some((f) => e.includes(`"additionalProperty":"${f}"`)));
  expect(errors).toEqual([]);
  for (const item of items) {
    expect(item).toMatchObject({ id: expect.stringMatching(/^md_[a-z0-9]{10,40}$/), object: 'mandate', status: expect.stringMatching(/^(active|paused_insufficient_funds|canceled|completed)$/), created_at: expect.any(String) });
    expect('next_run_on' in item).toBe(true);
  }
  return res.body;
}

/** Hace que un comercio exista en la réplica (como si hubieran llegado sus eventos `merchant.*`). */
export async function setMerchantStatus(ctx: TestContext, merchantId: string, status: 'active' | 'suspended' | 'closed', at = new Date('2026-01-01T00:00:00Z')): Promise<void> {
  await ctx.db.pool.query(
    `INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, $2, $3)
     ON CONFLICT (merchant_id) DO UPDATE SET status = EXCLUDED.status, as_of = EXCLUDED.as_of`,
    [merchantId, status, at],
  );
}

export const rows = async (ctx: TestContext, sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;

/** Eventos del outbox de un tipo, en orden, ya validados contra el AsyncAPI. */
export async function eventsOf(ctx: TestContext, type: string, aggregateId?: string): Promise<Body[]> {
  const result = await ctx.db.pool.query(
    `SELECT subject, envelope FROM outbox_events WHERE type = $1 ${aggregateId ? 'AND aggregate_id = $2' : ''} ORDER BY seq`,
    aggregateId ? [type, aggregateId] : [type],
  );
  return result.rows.map((r) => {
    const errors = ctx.events.validate(r.subject as string, r.envelope);
    expect({ subject: r.subject, errors }).toEqual({ subject: r.subject, errors: [] });
    return r.envelope;
  });
}

/** Mandato listo para ejecutar: pagador y beneficiario activos, fondos en el libro mayor [DOBLE] y la primera fecha ya vencida. */
export async function dueMandate(
  ctx: TestContext,
  options: { funds?: number; amount?: number; kind?: 'pay_obligation' | 'pay_commission'; beneficiary?: string; mode?: 'test' | 'live'; payer?: string } = {},
): Promise<{ payer: string; beneficiary: string; mandateId: string; amount: number }> {
  const payer = options.payer ?? newMerchant();
  const beneficiary = options.beneficiary ?? newMerchant();
  const mode = options.mode ?? 'test';
  const amount = options.amount ?? 100_000;
  await setMerchantStatus(ctx, payer, 'active');
  await setMerchantStatus(ctx, beneficiary, 'active');
  if (options.funds !== undefined) ctx.ledger.fund(mode, `merchant:${payer}:available`, options.funds);
  const today = new Date(ctx.clock.now.getTime() - 4 * 3600_000).toISOString().slice(0, 10);
  const res = await createMandate(ctx, payer, mandateBody(beneficiary, { amount_minor: amount, kind: options.kind ?? 'pay_obligation' }, { start_date: today, day_of_month: Number(today.slice(8)) > 28 ? 28 : Number(today.slice(8)) }), uniqueKey(), mode);
  expect({ status: res.status, body: res.body }).toMatchObject({ status: 201 });
  return { payer, beneficiary, mandateId: res.body.id as string, amount };
}
