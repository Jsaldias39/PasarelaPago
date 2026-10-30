import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InternalPaymentsController } from '../src/payments/internal.controller';
import { PaymentsController } from '../src/payments/payments.controller';
import { refundsRepo } from '../src/persistence/refunds.repo';
import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { asMerchant, EDGE, httpApp, routesOf } from './helpers/http';
import { eventsOf, key, MC, seedMerchant, startDirectIntent, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/** Tanda 2b: payment_method_unavailable coherente, llamadas salientes, X-Pay-Mode en todas las rutas y regla 11 con la consulta de reembolsos. */
let stack: Stack;
let app: INestApplication;
let validators: Map<string, EventValidator>;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  // Timeout del conector corto para poder probar una consulta que tarda más que él (resultado AMBIGUO) sin esperar 5 s por intento.
  stack = await startStack({ env: { REFUND_WAIT_MS: '800', CONNECTORS_TIMEOUT_MS: '1500', ACTIVITY_TIMEOUT_MS: '9000' } });
  app = await httpApp(stack);
  validators = await loadEventValidators();
  await seedMerchant(stack, MC);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});
afterEach(() => {
  stack.connectors.scenario = 'ok';
  stack.connectors.refundInquiryStale = false;
  stack.connectors.refundInquiryDelayMs = 0;
  stack.connectors.refundInquiryNotFound = false;
  stack.connectors.chargeStatusNotFound = false;
  stack.connectors.bankAccount = null;
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

const post = (body: unknown, mode: 'test' | 'live' = 'test', k = key()) => http().post('/payment_intents').set(asMerchant(MC, mode)).set('idempotency-key', k).send(body as object);
const settled = (id: string, status: string, timeout = 25_000) => waitFor(async () => ((await statusOf(stack, id)) === status ? true : undefined), timeout, `${id} → ${status}`);
const escalated = (id: string, kind: string, timeout = 25_000) => waitFor(async () => (Number((await stack.db.pool.query('SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = $2', [id, kind])).rows[0].n) > 0 ? true : undefined), timeout, `escalado ${kind}`);
async function succeededIntent(mode: 'test' | 'live' = 'test'): Promise<string> {
  const id = (await post(QR, mode)).body.id as string;
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
  await settled(id, 'succeeded');
  stack.ledger.setBalance(`merchant:${MC}:available`, 100000);
  return id;
}
const refundVia = async (intentId: string, amount: number) => (await http().post(`/payment_intents/${intentId}/refunds`).set(asMerchant(MC)).set('idempotency-key', key()).send({ amount_minor: amount })).body as { id: string; status: string };
const holdOf = (refundId: string) => [...stack.ledger.holds.values()].find((h) => h.business_ref === `${refundId}:refund`);
const refundStatus = async (id: string) => (await refundsRepo.byId(stack.deps.pool, id))?.status;

describe('1 · payment_method_unavailable: UN código del catálogo en la respuesta y en el evento, el motivo en `detail`', () => {
  it('el POST da 422 validation_failed con el motivo en detail; la fila, el evento y la lectura posterior dicen validation_failed (el mismo código)', async () => {
    const response = await post({ amount_minor: 20000, currency: 'BOB', payment_method: { type: 'bank_transfer' } });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed'); // código del catálogo
    expect(response.body.detail).toContain('payment_method_unavailable');
    expect(response.body.errors).toEqual([{ field: 'payment_method.type', code: 'payment_method_unavailable' }]); // código de CAMPO documentado
    const row = (await stack.db.pool.query("SELECT id, status, failure_code, failure_reason FROM payment_intents WHERE method = 'bank_transfer' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(row).toMatchObject({ status: 'failed', failure_code: 'validation_failed', failure_reason: 'payment_method_unavailable' });
    const failed = (await eventsOf(stack, row.id)).find((e) => e.type === 'payment_intent.failed')!;
    expect((failed.envelope.data as Record<string, unknown>).failure_code).toBe('validation_failed');
    expect(validators.get('payment_intent.failed')?.(failed.envelope)).toEqual([]);
    const read = await http().get(`/payment_intents/${row.id}`).set(asMerchant(MC));
    expect(read.body.last_error).toMatchObject({ code: 'validation_failed' });
    expect(read.body.last_error.message).toContain('cuenta recaudadora');
    // Ningún lado inventa un código que el catálogo no tiene.
    expect(JSON.stringify([response.body.code, read.body.last_error.code, (failed.envelope.data as Record<string, unknown>).failure_code])).not.toContain('"payment_method_unavailable"');
  });
});

describe('2 · toda llamada saliente lleva X-Service-Id y, hacia ledger y conectores, el X-Pay-Mode del cobro', () => {
  it.each(['test', 'live'] as const)('modo %s: cobro, cancelación, reembolso con consulta, compensación-free y contracargo', async (mode) => {
    for (const d of [stack.risk, stack.connectors, stack.ledger]) d.server.calls.length = 0;
    const paid = await succeededIntent(mode);
    const toCancel = (await post(QR, mode)).body.id as string;
    expect((await http().post(`/payment_intents/${toCancel}/cancel`).set(asMerchant(MC, mode)).set('idempotency-key', key()).send({})).status).toBe(200);
    stack.connectors.scenario = 'refund_pending';
    const refund = (await http().post(`/payment_intents/${paid}/refunds`).set(asMerchant(MC, mode)).set('idempotency-key', key()).send({ amount_minor: 500 })).body;
    stack.connectors.setRefundStatus((await refundsRepo.byId(stack.deps.pool, refund.id))!.connectorRefundId!, 'succeeded');
    await waitFor(async () => ((await refundStatus(refund.id)) === 'succeeded' ? true : undefined), 25_000, 'reembolso resuelto por consulta');
    const { dispute } = await stack.service.openDispute({ paymentIntentId: paid, openedKey: `ola2b-${mode}` });
    await stack.service.resolveDispute(dispute.id, 'lost');
    await waitFor(async () => ((await eventsOf(stack, dispute.id)).some((e) => e.type === 'dispute.lost') ? true : undefined), 25_000, 'contracargo');

    const all = { risk: stack.risk.server.calls, connectors: stack.connectors.server.calls, ledger: stack.ledger.server.calls };
    const seen = new Set<string>();
    for (const [name, calls] of Object.entries(all)) {
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        seen.add(`${name} ${call.method} ${call.path.replace(/\/[a-z]{2}_[a-z0-9]+/g, '/{id}')}`);
        expect({ name, path: call.path, service: call.headers['x-service-id'] }).toEqual({ name, path: call.path, service: 'pay-payments' });
        if (name === 'risk') expect(call.headers['x-pay-mode']).toBeUndefined(); // el contrato de riesgo no declara PayMode: no se inventa
        else expect({ name, path: call.path, mode: call.headers['x-pay-mode'] }).toEqual({ name, path: call.path, mode });
      }
    }
    // El recorrido ejercitó todas las operaciones salientes que existen.
    expect([...seen]).toEqual(expect.arrayContaining([
      'risk POST /assessments', 'connectors POST /charges', 'connectors GET /charges/{id}/status'.replace('GET', 'POST').replace('/status', '/cancel'), 'connectors POST /charges/{id}/refunds', 'connectors GET /refunds/{id}',
      'ledger POST /transactions', 'ledger POST /holds', 'ledger POST /holds/{id}/post',
    ]));
  });
});

describe('3 · TODA ruta exige X-Pay-Mode (los GET de reembolsos incluidos)', () => {
  const sample = (route: string): [string, string] => {
    const [method, ...rest] = route.split(' ');
    return [method!.toLowerCase(), rest.join(' ').replace(/\{\}/g, 'pi_aaaaaaaaaaaa')];
  };
  const publicRoutes = routesOf(PaymentsController as never);
  const internalRoutes = routesOf(InternalPaymentsController as never, 'intents');

  it('el conjunto de rutas incluye los GET de reembolsos y NO hay rutas de disputas (decisión del dueño, D-4)', () => {
    expect(publicRoutes).toEqual(expect.arrayContaining(['GET /refunds/{}', 'GET /payment_intents/{}']));
    expect([...publicRoutes, ...internalRoutes].filter((r) => /dispute/i.test(r))).toEqual([]);
  });

  it.each([...publicRoutes.map((r) => ['pay-edge', r]), ...internalRoutes.map((r) => ['pay-schedules', r])])('%s · %s: sin X-Pay-Mode (o con uno inválido) es 403; con test|live llega al servicio', async (service, route) => {
    const [method, url] = sample(route as string);
    const send = (mode?: string) => {
      const base = (http() as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('x-service-id', service as string).set('x-merchant-id', MC).set('idempotency-key', key());
      return (mode === undefined ? base : base.set('x-pay-mode', mode)).send(method === 'post' ? {} : undefined);
    };
    for (const mode of [undefined, 'sandbox', 'LIVE', '']) expect({ route, mode, status: (await send(mode)).status }).toEqual({ route, mode, status: 403 });
    for (const mode of ['test', 'live']) expect((await send(mode)).status).not.toBe(403);
  });

  it('un GET de disputas no existe (404) con o sin modo', async () => {
    expect((await http().get('/disputes/dp_aaaaaaaaaaaa').set(asMerchant(MC))).status).toBe(404);
    expect((await http().get('/disputes/dp_aaaaaaaaaaaa').set(EDGE)).status).toBe(404);
  });
});

describe('4 · regla 11: una consulta autoritativa `not_found` NO anula nada', () => {
  it('reembolso: GET /refunds/{id} da 404 exacto → el reembolso sigue pending, la retención sigue puesta, se escala (con evento) y el workflow SIGUE vivo', async () => {
    const intentId = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const refund = await refundVia(intentId, 800);
    const crId = (await refundsRepo.byId(stack.deps.pool, refund.id))!.connectorRefundId!;
    stack.connectors.refundInquiryNotFound = true;
    await escalated(intentId, 'refund_not_found_at_connector');
    await new Promise((r) => setTimeout(r, 2500)); // varios ciclos de consulta con 404
    expect(await refundStatus(refund.id)).toBe('pending');
    expect(holdOf(refund.id)?.status).toBe('pending'); // NO se anuló
    const events = (await eventsOf(stack, intentId)).filter((e) => e.type === 'payment_intent.contradiction_detected' && (e.envelope.data as Record<string, unknown>).kind === 'refund_not_found_at_connector');
    expect(events).toHaveLength(1);
    expect(validators.get('payment_intent.contradiction_detected')?.(events[0]!.envelope)).toEqual([]);
    // El workflow no murió: cuando el conector vuelve a conocerlo y dice que se hizo, se confirma.
    stack.connectors.refundInquiryNotFound = false;
    stack.connectors.setRefundStatus(crId, 'succeeded');
    await waitFor(async () => ((await refundStatus(refund.id)) === 'succeeded' ? true : undefined), 25_000, 'reembolso resuelto');
    expect(holdOf(refund.id)?.status).toBe('posted');
  });

  it('cobro: el estado del cargo da 404 exacto mientras espera pago → no vence, no se cancela, no falla; se escala y, al volver el conector, se cobra', async () => {
    const created = (await post(QR)).body.id as string;
    stack.connectors.chargeStatusNotFound = true;
    await escalated(created, 'charge_not_found_at_connector');
    expect(await statusOf(stack, created)).toBe('requires_action');
    expect(stack.connectors.charges.get(stack.connectors.chargeFor(created)!.id)?.status).toBe('requires_action');
    stack.connectors.chargeStatusNotFound = false;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(created)!.id, 'succeeded');
    await settled(created, 'succeeded');
  });

  it('cobro al vencer: con 404 en la consulta final el intento NO se da por vencido ni se cancela el cargo; queda escalado', async () => {
    const id = await startDirectIntent(stack, { id: `pi_ola2b${String(Date.now()).slice(-7)}x1`, expiresInMs: 3000 });
    await settled(id, 'requires_action', 10_000);
    stack.connectors.chargeStatusNotFound = true;
    await escalated(id, 'charge_not_found_at_connector', 30_000);
    expect(await statusOf(stack, id)).toBe('requires_action');
    expect(stack.connectors.charges.get(stack.connectors.chargeFor(id)!.id)?.status).toBe('requires_action');
    expect(stack.connectors.server.callsTo('POST', /\/cancel$/).filter((c) => c.path.includes(stack.connectors.chargeFor(id)!.id))).toHaveLength(0);
  });
});

describe('5 · el workflow de reembolso consulta GET /refunds/{id}: conector lento (stale / timeout) y conector que reconoce el refund_id', () => {
  it('lento pero dentro del plazo: la respuesta tardía igual se aplica', async () => {
    const intentId = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const refund = await refundVia(intentId, 600);
    stack.connectors.refundInquiryDelayMs = 700; // < CONNECTORS_TIMEOUT_MS (1500)
    stack.connectors.setRefundStatus((await refundsRepo.byId(stack.deps.pool, refund.id))!.connectorRefundId!, 'succeeded');
    await waitFor(async () => ((await refundStatus(refund.id)) === 'succeeded' ? true : undefined), 25_000, 'resuelto con la consulta lenta');
  });

  it('más lento que el timeout (AMBIGUO): la consulta falla, el reembolso sigue pending con la retención puesta; al recuperarse el conector se resuelve', async () => {
    const intentId = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const refund = await refundVia(intentId, 650);
    const crId = (await refundsRepo.byId(stack.deps.pool, refund.id))!.connectorRefundId!;
    stack.connectors.refundInquiryDelayMs = 2500; // > CONNECTORS_TIMEOUT_MS
    stack.connectors.setRefundStatus(crId, 'failed', 'validation_failed');
    await escalated(intentId, 'refund_pending_timeout');
    await new Promise((r) => setTimeout(r, 3500));
    expect(await refundStatus(refund.id)).toBe('pending'); // el «failed» no se pudo ver: NO se anula por una duda
    expect(holdOf(refund.id)?.status).toBe('pending');
    stack.connectors.refundInquiryDelayMs = 0;
    await waitFor(async () => ((await refundStatus(refund.id)) === 'failed' ? true : undefined), 25_000, 'resuelto al recuperarse');
    expect(holdOf(refund.id)?.status).toBe('voided');
  });

  it('el conector distingue DOS reembolsos del mismo cobro por su refund_id: cada consulta devuelve el suyo y se resuelven de forma independiente', async () => {
    const intentId = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const first = await refundVia(intentId, 400);
    const second = await refundVia(intentId, 450);
    const crFirst = (await refundsRepo.byId(stack.deps.pool, first.id))!.connectorRefundId!;
    const crSecond = (await refundsRepo.byId(stack.deps.pool, second.id))!.connectorRefundId!;
    expect(crFirst).not.toBe(crSecond);
    const view = async (cr: string) => (await fetch(`${stack.connectors.server.url}/refunds/${cr}?refresh=true`, { headers: { 'x-service-id': 'pay-payments', 'x-pay-mode': 'test' } })).json() as Promise<{ refund_id: string }>;
    expect((await view(crFirst)).refund_id).toBe(first.id);
    expect((await view(crSecond)).refund_id).toBe(second.id);
    stack.connectors.setRefundStatus(crFirst, 'succeeded');
    await waitFor(async () => ((await refundStatus(first.id)) === 'succeeded' ? true : undefined), 25_000, 'primero resuelto');
    expect(await refundStatus(second.id)).toBe('pending'); // el otro no se movió
    expect(holdOf(second.id)?.status).toBe('pending');
    stack.connectors.setRefundStatus(crSecond, 'failed', 'validation_failed');
    await waitFor(async () => ((await refundStatus(second.id)) === 'failed' ? true : undefined), 25_000, 'segundo resuelto');
    expect([holdOf(first.id)?.status, holdOf(second.id)?.status]).toEqual(['posted', 'voided']);
    const calls = stack.connectors.server.callsTo('POST', /\/refunds$/).filter((c) => [first.id, second.id].includes((c.body as { refund_id?: string }).refund_id ?? ''));
    expect(calls.map((c) => (c.body as { refund_id: string }).refund_id).sort()).toEqual([first.id, second.id].sort());
  });
});
