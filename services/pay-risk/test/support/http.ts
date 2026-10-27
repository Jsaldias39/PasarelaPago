import request, { type Test } from 'supertest';
import type { ContractValidator } from '@pay/testing';
import { bearer } from '../doubles/operator-auth.double';
import type { TestContext } from './app';

let sequence = 0;
export const uniqueKey = (): string => `idem-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const id = (prefix: string): string => {
  let body = '';
  for (let i = 0; i < 16; i += 1) body += ALPHABET[Math.floor(Math.random() * 32)];
  return `${prefix}_${body}`;
};
export const newIntent = (): string => id('pi');
export const newMerchant = (): string => id('mc');

/** Nombre SINTÉTICO que no figura en ninguna lista. */
export const CLEAN_NAME = 'Zyxwvut Qwerty Holdings SRL';
/** Entrada pública de la lista OFAC de 2019 del Watchman de pruebas (una organización, no una persona). Ver docs/spikes/watchman.md. */
export const SANCTIONED_ORG = 'Hizballah';
/** Misma organización con una letra cambiada: puntúa por debajo del umbral de rechazo de las pruebas. */
export const SANCTIONED_ORG_TYPO = 'Hizbolla';

export interface AssessmentBody {
  merchant_id?: string;
  payment_intent_id?: string;
  amount_minor?: number;
  currency?: string;
  method?: string;
  payer_fingerprint?: string;
  screening?: { name: string } | null;
  [key: string]: unknown;
}

export function assessmentBody(overrides: AssessmentBody = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    merchant_id: newMerchant(),
    payment_intent_id: newIntent(),
    amount_minor: 10_000,
    currency: 'BOB',
    method: 'qr',
    screening: { name: CLEAN_NAME },
    ...overrides,
  };
  if (body.screening === null) delete body.screening;
  return body;
}

/** Llamada como `pay-payments` (el único servicio autorizado). */
export const post = (ctx: TestContext, body: object, key = uniqueKey(), service = 'pay-payments'): Test =>
  request(ctx.server).post('/assessments').set('x-service-id', service).set('idempotency-key', key).send(body);

export const getAssessment = (ctx: TestContext, assessmentId: string, service = 'pay-payments'): Test =>
  request(ctx.server).get(`/assessments/${assessmentId}`).set('x-service-id', service);

export function verified(contract: ContractValidator, method: 'get' | 'post', path: string, res: request.Response, status: number): any {
  expect({ status: res.status, body: res.body }).toMatchObject({ status });
  contract.assertResponse({ method, path, status: res.status, body: res.body });
  return res.body;
}

/** Llamada de back-office como `pay-backoffice` con la credencial del [DOBLE] de operadores. */
export const bo = (ctx: TestContext, method: 'get' | 'post', path: string, as = 'op-risk'): Test =>
  request(ctx.server)[method](path).set('x-service-id', 'pay-backoffice').set('authorization', bearer(as));

export async function publishRules(ctx: TestContext, body: object = {}): Promise<any> {
  const res = await bo(ctx, 'post', '/rule_sets').send(body);
  return verified(ctx.ruleSetsContract, 'post', '/rule_sets', res, 201);
}

export const rows = async (ctx: TestContext, sql: string, params: unknown[] = []) => (await ctx.db.pool.query(sql, params)).rows;
