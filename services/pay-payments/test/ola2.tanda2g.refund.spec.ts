import type { INestApplication } from '@nestjs/common';
import { loadContract, type ContractValidator } from '@pay/testing';
import request from 'supertest';
import { refundsRepo } from '../src/persistence/refunds.repo';
import { CONTRACTS } from './doubles/contracts';
import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { asMerchant, httpApp } from './helpers/http';
import { eventsOf, key, MC, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/**
 * P3.H2.M5 · E3 contra dobles: «reembolso parcial con retención y fallo del conector» (PLAN-MAESTRO).
 * Retención en DOS fases (retener → devolver en el conector → confirmar). La retención se ANULA solo ante un fallo DEFINITIVO que el contrato
 * declara (4xx con su cuerpo, `502 connector_unavailable` exacto); un resultado AMBIGUO (500, 502 sin el cuerpo exacto, timeout) no es un fallo:
 * se conserva la retención, se escala y se reintenta con la MISMA clave hasta que haya una respuesta.
 */
let stack: Stack;
let app: INestApplication;
let publicContract: ContractValidator;
let validators: Map<string, EventValidator>;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  stack = await startStack({ env: { REFUND_WAIT_MS: '800', CONNECTORS_TIMEOUT_MS: '1500', ACTIVITY_TIMEOUT_MS: '9000' } });
  app = await httpApp(stack);
  publicContract = await loadContract(CONTRACTS.publicV1);
  validators = await loadEventValidators();
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});
afterEach(() => {
  stack.connectors.scenario = 'ok';
  stack.connectors.server.routeDelays.length = 0;
  stack.ledger.failNext = 0;
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

async function succeededIntent(available = 20000): Promise<string> {
  const id = (await http().post('/payment_intents').set(asMerchant(MC)).set('idempotency-key', key()).send(QR)).body.id as string;
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
  await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'cobro exitoso');
  stack.ledger.setBalance(`merchant:${MC}:available`, available);
  return id;
}
const refund = (intentId: string, amount: number, k = key()) => http().post(`/payment_intents/${intentId}/refunds`).set(asMerchant(MC)).set('idempotency-key', k).send({ amount_minor: amount, reason: 'requested_by_customer' });
const holdOf = (refundId: string) => [...stack.ledger.holds.values()].find((h) => h.business_ref === `${refundId}:refund`);
const available = () => stack.ledger.balance(`merchant:${MC}:available`);
const voids = () => stack.ledger.server.callsTo('POST', /^\/holds\/hd_[a-z0-9]+\/void$/).length;
const posts = () => stack.ledger.server.callsTo('POST', /^\/holds\/hd_[a-z0-9]+\/post$/);
const escalated = (intentId: string, kind: string) => waitFor(async () => (Number((await stack.db.pool.query('SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = $2', [intentId, kind])).rows[0].n) > 0 ? true : undefined), 30_000, `escalado ${kind}`);
const refundStatus = async (id: string) => (await refundsRepo.byId(stack.deps.pool, id))?.status;
const refundTypes = async (id: string) => (await eventsOf(stack, id)).map((e) => e.type);

describe('E3 · nivel CORRECTO: reembolso parcial con retención en dos fases', () => {
  it('retiene → devuelve en el conector → confirma la retención (en ese orden); saldo, cupo, lectura y eventos son los del contrato', async () => {
    const id = await succeededIntent();
    const holdsBefore = stack.ledger.server.callsTo('POST', /^\/holds$/).length;
    const created = await refund(id, 4000);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ object: 'refund', status: 'succeeded', amount_minor: 4000, payment_intent: id, failure_code: null });
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents/{id}/refunds', status: 201, body: created.body })).toEqual([]);
    const refundId = created.body.id as string;

    // Dos fases, en orden: la retención se crea ANTES de hablar con el conector y se confirma DESPUÉS de que éste respondió.
    const holdCall = stack.ledger.server.callsTo('POST', /^\/holds$/).slice(holdsBefore).find((c) => JSON.stringify(c.body).includes(`${refundId}:refund`))!;
    const connectorCall = stack.connectors.server.callsTo('POST', /^\/charges\/ch_[a-z0-9]+\/refunds$/).find((c) => String(c.headers['idempotency-key']).startsWith(refundId))!;
    const postCall = posts().find((c) => c.at >= connectorCall.at)!;
    expect(holdCall.at).toBeLessThanOrEqual(connectorCall.at);
    expect(connectorCall.at).toBeLessThanOrEqual(postCall.at);
    expect(holdOf(refundId)).toMatchObject({ status: 'posted', amount_minor: 4000 });
    expect(available()).toBe(16000);

    const read = await http().get(`/refunds/${refundId}`).set(asMerchant(MC));
    expect(read.status).toBe(200);
    expect(publicContract.validateResponse({ method: 'GET', path: '/refunds/{id}', status: 200, body: read.body })).toEqual([]);
    const events = await eventsOf(stack, refundId);
    expect(events.map((e) => e.type)).toEqual(['refund.created', 'refund.succeeded']);
    for (const e of events) expect(validators.get(e.type)?.(e.envelope)).toEqual([]);
  });

  it('el cupo es exacto: 4000 + 6000 agotan el cobro, 1 más se rechaza con 422 sin tocar ni el ledger ni el conector', async () => {
    const id = await succeededIntent();
    expect((await refund(id, 4000)).body.status).toBe('succeeded');
    expect((await refund(id, 6000)).body.status).toBe('succeeded');
    const holds = stack.ledger.server.callsTo('POST', /^\/holds$/).length;
    const connector = stack.connectors.server.callsTo('POST', /\/refunds$/).length;
    const over = await refund(id, 1);
    expect(over.status).toBe(422);
    expect(over.body.errors).toEqual([{ field: 'amount_minor', code: 'exceeds_refundable' }]);
    expect(stack.ledger.server.callsTo('POST', /^\/holds$/).length).toBe(holds);
    expect(stack.connectors.server.callsTo('POST', /\/refunds$/).length).toBe(connector);
    expect(available()).toBe(10000);
  });
});

describe('E3 · nivel LÍMITE: fallo DEFINITIVO del conector ⇒ la retención se anula (una vez) y el reembolso queda failed', () => {
  it.each([
    ['422 declarado por el contrato (rechazo del proveedor)', 'refund_fails' as const, 'validation_failed'],
    ['`502 connector_unavailable` con el cuerpo EXACTO (el conector garantiza que no envió nada)', 'refund_down' as const, 'connector_unavailable'],
  ])('%s', async (_name, scenario, code) => {
    const id = await succeededIntent();
    stack.connectors.scenario = scenario;
    const voidsBefore = voids();
    const result = await refund(id, 3000);
    expect(result.body).toMatchObject({ status: 'failed', failure_code: code });
    expect(holdOf(result.body.id as string)?.status).toBe('voided');
    expect(voids() - voidsBefore).toBe(1); // anulada UNA vez
    expect(posts().filter((c) => c.path.includes(holdOf(result.body.id as string)!.id))).toHaveLength(0); // y NUNCA se confirmó
    expect(available()).toBe(20000); // el saldo del comercio queda intacto
    expect(await refundTypes(result.body.id as string)).toEqual(['refund.created', 'refund.failed']);
    expect(validators.get('refund.failed')?.((await eventsOf(stack, result.body.id as string))[1]!.envelope)).toEqual([]);
    stack.connectors.scenario = 'ok';
    expect((await refund(id, 10000)).body.status).toBe('succeeded'); // el cupo del fallido vuelve: se puede reembolsar el total
  });

  it('sin saldo (rechazo definitivo del ledger): failed insufficient_funds SIN llamar al conector y sin retención', async () => {
    const id = await succeededIntent(1000);
    const connector = stack.connectors.server.callsTo('POST', /\/refunds$/).length;
    const result = await refund(id, 4000);
    expect(result.body).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds' });
    expect(stack.connectors.server.callsTo('POST', /\/refunds$/).length).toBe(connector);
    expect(available()).toBe(1000);
  });
});

describe('E3 · nivel INVÁLIDO/AMBIGUO: lo que no prueba que no se ejecutó NO es un fallo', () => {
  const ambiguous = [
    ['500 genérico', 'refund_ambiguous'],
    ['502 SIN el cuerpo exacto de connector_unavailable', 'refund_502_opaque'],
  ] as const;
  it.each(ambiguous)('%s: reembolso pending, retención CONSERVADA (0 anulaciones), escalado; al volver el conector se completa con UNA sola devolución y UNA retención confirmada', async (_name, scenario) => {
    const id = await succeededIntent();
    stack.connectors.scenario = scenario;
    const voidsBefore = voids();
    const created = await refund(id, 2000);
    const refundId = created.body.id as string;
    expect(created.body.status).toBe('pending');
    await escalated(id, 'refund_outcome_unknown');
    expect(await refundStatus(refundId)).toBe('pending');
    expect(holdOf(refundId)?.status).toBe('pending');
    expect(voids() - voidsBefore).toBe(0);
    expect(available()).toBe(20000);
    const published = (await refundTypes(refundId));
    expect(published).not.toContain('refund.failed');

    stack.connectors.scenario = 'ok';
    await waitFor(async () => ((await refundStatus(refundId)) === 'succeeded' ? true : undefined), 40_000, 'reembolso completado');
    expect(holdOf(refundId)?.status).toBe('posted');
    expect(available()).toBe(18000);
    expect(voids() - voidsBefore).toBe(0);
    const attempts = stack.connectors.server.callsTo('POST', /\/refunds$/).filter((c) => String(c.headers['idempotency-key']).startsWith(refundId));
    expect(attempts.length).toBeGreaterThan(1);
    expect(new Set(attempts.map((c) => c.headers['idempotency-key']))).toEqual(new Set([`${refundId}:refund`])); // siempre la MISMA clave
    expect([...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id)).toHaveLength(1);
    expect((await refundTypes(refundId)).filter((t) => t === 'refund.succeeded')).toHaveLength(1);
  });

  it('timeout con el efecto YA aplicado en el conector (la respuesta llega tarde): ambiguo, retención conservada; al reintentar con la misma clave NO se devuelve dos veces', async () => {
    const id = await succeededIntent();
    stack.connectors.server.routeDelays.push({ method: 'POST', pattern: /^\/charges\/ch_[a-z0-9]+\/refunds$/, ms: 4000 });
    const voidsBefore = voids();
    const created = await refund(id, 2500);
    const refundId = created.body.id as string;
    expect(created.body.status).toBe('pending');
    await escalated(id, 'refund_outcome_unknown');
    expect(holdOf(refundId)?.status).toBe('pending');
    expect(voids() - voidsBefore).toBe(0);
    stack.connectors.server.routeDelays.length = 0;
    await waitFor(async () => ((await refundStatus(refundId)) === 'succeeded' ? true : undefined), 40_000, 'reembolso completado');
    expect([...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id)).toHaveLength(1);
    expect(holdOf(refundId)?.status).toBe('posted');
    expect(available()).toBe(17500);
  });

  it('lo ambiguo que se resuelve en un fallo DEFINITIVO: recién entonces se anula la retención (una vez) y el reembolso falla', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_ambiguous';
    const voidsBefore = voids();
    const created = await refund(id, 1800);
    const refundId = created.body.id as string;
    await escalated(id, 'refund_outcome_unknown');
    expect(voids() - voidsBefore).toBe(0); // mientras es ambiguo, nada se anula
    stack.connectors.scenario = 'refund_fails'; // el conector contesta por fin, y con un rechazo declarado
    await waitFor(async () => ((await refundStatus(refundId)) === 'failed' ? true : undefined), 40_000, 'reembolso fallido');
    expect(holdOf(refundId)?.status).toBe('voided');
    expect(voids() - voidsBefore).toBe(1);
    expect(available()).toBe(20000);
  });

  it('el conector pide un aviso (`pending`) y nunca llega: ni se libera la retención ni se da por fallido; queda a la vista de conciliación', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const voidsBefore = voids();
    const created = await refund(id, 1500);
    await escalated(id, 'refund_pending_timeout');
    expect(await refundStatus(created.body.id as string)).toBe('pending');
    expect(holdOf(created.body.id as string)?.status).toBe('pending');
    expect(voids() - voidsBefore).toBe(0);
  });
});
