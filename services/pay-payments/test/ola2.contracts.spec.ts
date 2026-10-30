import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { loadContract, type ContractValidator } from '@pay/testing';
import { ConnectorsClient } from '../src/clients/connectors.client';
import { HttpClient } from '../src/clients/http';
import { refundsRepo } from '../src/persistence/refunds.repo';
import { ASYNCAPI_PAYMENTS, CONTRACTS } from './doubles/contracts';
import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { asMerchant, EDGE, httpApp } from './helpers/http';
import { eventsOf, key, MC, MC2, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

/** Adaptación a los contratos de la ola 2 (docs/trabajo/ola-2/CONTRATOS.md §3 y §5). */
let stack: Stack;
let app: INestApplication;
let publicContract: ContractValidator;
let validators: Map<string, EventValidator>;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };

beforeAll(async () => {
  stack = await startStack({ env: { REFUND_WAIT_MS: '1500' } });
  app = await httpApp(stack);
  publicContract = await loadContract(CONTRACTS.publicV1);
  validators = await loadEventValidators();
  await seedMerchant(stack, MC);
  await seedMerchant(stack, MC2);
});
afterAll(async () => {
  await app.close();
  await stack.stop();
});
afterEach(() => {
  stack.connectors.scenario = 'ok';
  stack.risk.mode = 'allow';
  stack.connectors.bankAccount = null;
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

const http = () => request(app.getHttpServer());
const post = (merchant: string, body: unknown, mode: 'test' | 'live' = 'test', k = key()) => http().post('/payment_intents').set(asMerchant(merchant, mode)).set('idempotency-key', k).send(body as object);
const settled = (id: string, status: string) => waitFor(async () => ((await statusOf(stack, id)) === status ? true : undefined), 20_000, `${id} → ${status}`);
async function succeededIntent(merchant = MC, mode: 'test' | 'live' = 'test'): Promise<string> {
  const id = (await post(merchant, QR, mode)).body.id as string;
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
  await settled(id, 'succeeded');
  stack.ledger.setBalance(`merchant:${merchant}:available`, 50000);
  return id;
}

describe('1 · GET /refunds/{id} (public-v1)', () => {
  it('correcto: devuelve el reembolso conforme al contrato; límite: pendiente y fallido; inválido: ajeno, de otro modo, id roto y servicio no permitido', async () => {
    const intentId = await succeededIntent();
    const created = await http().post(`/payment_intents/${intentId}/refunds`).set(asMerchant(MC)).set('idempotency-key', key()).send({ amount_minor: 2500, reason: 'requested_by_customer' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const got = await http().get(`/refunds/${id}`).set(asMerchant(MC));
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, object: 'refund', payment_intent: intentId, status: 'succeeded', amount_minor: 2500 });
    expect(publicContract.validateResponse({ method: 'GET', path: `/refunds/${id}`, status: 200, body: got.body })).toEqual([]);

    // límite: uno fallido (el conector lo rechazó) también se consulta, con su motivo
    stack.connectors.scenario = 'refund_fails';
    const failed = (await http().post(`/payment_intents/${intentId}/refunds`).set(asMerchant(MC)).set('idempotency-key', key()).send({ amount_minor: 100 })).body;
    const failedGot = await http().get(`/refunds/${failed.id}`).set(asMerchant(MC));
    expect(failedGot.body).toMatchObject({ status: 'failed' });
    expect(publicContract.validateResponse({ method: 'GET', path: `/refunds/${failed.id}`, status: 200, body: failedGot.body })).toEqual([]);

    // inválido: otro comercio y otro modo ven un 404 idéntico al de un id inexistente; un id roto es 404; otro servicio es 403
    const ghost = await http().get('/refunds/re_doesnotexist000').set(asMerchant(MC));
    for (const headers of [asMerchant(MC2), asMerchant(MC, 'live')]) {
      const foreign = await http().get(`/refunds/${id}`).set(headers);
      expect(foreign.status).toBe(404);
      expect({ ...foreign.body, instance: undefined }).toEqual({ ...ghost.body, instance: undefined });
    }
    expect((await http().get('/refunds/x').set(asMerchant(MC))).status).toBe(404);
    expect((await http().get(`/refunds/${id}`).set({ 'x-service-id': 'pay-risk', 'x-merchant-id': MC, 'x-pay-mode': 'test' })).status).toBe(403);
    expect((await http().get(`/refunds/${id}`).set(EDGE).set('x-merchant-id', MC)).status).toBe(403); // sin X-Pay-Mode
  });
});

describe('2 · risk_denied y payment_declined', () => {
  it('riesgo `deny` → risk_denied; rechazo del proveedor (422 al crear el cargo) y `card_declined` del conector → payment_declined; los eventos cumplen el AsyncAPI', async () => {
    stack.risk.mode = 'deny';
    const denied = (await post(MC, QR)).body;
    expect(denied).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
    stack.risk.mode = 'allow';
    stack.connectors.scenario = 'decline';
    const declined = (await post(MC, QR)).body;
    expect(declined).toMatchObject({ status: 'failed', last_error: { code: 'payment_declined' } });
    stack.connectors.scenario = 'ok';
    const later = (await post(MC, QR)).body.id as string;
    await stack.orchestrator.signalCharge(later, { status: 'failed', failureCode: 'card_declined' });
    await settled(later, 'failed');
    for (const [id, code] of [[denied.id, 'risk_denied'], [declined.id, 'payment_declined'], [later, 'payment_declined']] as const) {
      const failedEvent = (await eventsOf(stack, id as string)).find((e) => e.type === 'payment_intent.failed')!;
      expect((failedEvent.envelope.data as Record<string, unknown>).failure_code).toBe(code);
      expect(validators.get('payment_intent.failed')?.(failedEvent.envelope)).toEqual([]);
    }
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: denied })).toEqual([]);
  });
});

describe('3 · ledger_transfer_id cita tx_ (asiento) o hd_ (retención), nunca tf_', () => {
  it('payment_intent.succeeded → tx_, refund.succeeded → hd_, dispute.lost → tx_; no queda código que fabrique tf_', async () => {
    const intentId = await succeededIntent();
    const refund = (await http().post(`/payment_intents/${intentId}/refunds`).set(asMerchant(MC)).set('idempotency-key', key()).send({ amount_minor: 1000 })).body;
    const { dispute } = await stack.service.openDispute({ paymentIntentId: intentId, openedKey: 'ola2-ids' });
    await stack.service.resolveDispute(dispute.id, 'lost');
    await waitFor(async () => ((await eventsOf(stack, dispute.id)).some((e) => e.type === 'dispute.lost') ? true : undefined), 20_000, 'dispute.lost');
    const idOf = async (subject: string, type: string) => ((await eventsOf(stack, subject)).find((e) => e.type === type)!.envelope.data as Record<string, string>).ledger_transfer_id;
    const succeeded = await idOf(intentId, 'payment_intent.succeeded');
    const refunded = await idOf(refund.id, 'refund.succeeded');
    const lost = await idOf(dispute.id, 'dispute.lost');
    expect(succeeded).toMatch(/^tx_[a-z0-9]{10,40}$/);
    expect(refunded).toMatch(/^hd_[a-z0-9]{10,40}$/);
    expect(lost).toMatch(/^tx_[a-z0-9]{10,40}$/);
    // …y son los ids que el ledger devolvió, tal cual (no una traducción).
    expect(succeeded).toBe((await stack.db.pool.query('SELECT ledger_transfer_id FROM payment_intents WHERE id = $1', [intentId])).rows[0].ledger_transfer_id);
    expect(refunded).toBe((await refundsRepo.byId(stack.deps.pool, refund.id))?.ledgerHoldId);
    for (const [subject, type] of [[intentId, 'payment_intent.succeeded'], [refund.id, 'refund.succeeded'], [dispute.id, 'dispute.lost']] as const) {
      expect(validators.get(type)?.((await eventsOf(stack, subject)).find((e) => e.type === type)!.envelope)).toEqual([]);
    }
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? sources(path.join(dir, n)) : n.endsWith('.ts') ? [path.join(dir, n)] : []));
    const code = sources(path.join(process.cwd(), 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(code).not.toMatch(/transferIdForEvent|`tf_|'tf_/);
  });
});

describe('4 · el conector se emite como `mock` (`simulator` solo se acepta)', () => {
  it('payment_intent.processing lleva `mock`; un `simulator` de un productor sin migrar se normaliza a `mock` al leerlo', async () => {
    const id = await succeededIntent();
    const processing = (await eventsOf(stack, id)).find((e) => e.type === 'payment_intent.processing')!;
    expect((processing.envelope.data as Record<string, unknown>).connector).toBe('mock');
    expect(validators.get('payment_intent.processing')?.(processing.envelope)).toEqual([]);

    const server = createServer((_req, res) => res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'ch_aliasaliasalias', object: 'charge', payment_intent_id: 'pi_aliasalias001', connector: 'simulator', mode: 'sandbox', method: 'qr', amount_minor: 100, currency: 'BOB', status: 'requires_action', created_at: new Date().toISOString(), expires_at: new Date().toISOString() })));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new ConnectorsClient(new HttpClient({ name: 'pay-connectors', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, serviceId: 'pay-payments', timeoutMs: 2000, retries: 0, breaker: { failureThreshold: 50, resetAfterMs: 60_000 } }));
    const out = await client.createCharge({ mode: 'test', paymentIntentId: 'pi_aliasalias001', merchantId: MC, amountMinor: 100, currency: 'BOB', method: 'qr', expiresAt: new Date().toISOString() });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(out.ok && out.value.connector).toBe('mock');
  });
});

describe('5 · refund_id al conector y consulta de estado (GET /refunds/{id}) en vez de esperar para siempre', () => {
  const refundVia = async (intentId: string, amount: number) => (await http().post(`/payment_intents/${intentId}/refunds`).set(asMerchant(MC)).set('idempotency-key', key()).send({ amount_minor: amount })).body as { id: string; status: string };

  it('el conector recibe el re_… del reembolso y pay-payments guarda el cr_… que devolvió', async () => {
    const intentId = await succeededIntent();
    const refund = await refundVia(intentId, 700);
    const call = stack.connectors.server.callsTo('POST', /\/refunds$/).find((c) => (c.body as { refund_id?: string }).refund_id === refund.id);
    expect(call).toBeDefined();
    expect(call?.headers['x-pay-mode']).toBe('test');
    expect((await refundsRepo.byId(stack.deps.pool, refund.id))?.connectorRefundId).toMatch(/^cr_[a-z0-9]{10,40}$/);
  });

  it('`pending` y NINGÚN aviso: la consulta lo resuelve (éxito → confirma la retención; fallo → la anula)', async () => {
    for (const outcome of ['succeeded', 'failed'] as const) {
      const intentId = await succeededIntent();
      stack.connectors.scenario = 'refund_pending';
      const refund = await refundVia(intentId, 1200);
      expect(refund.status).toBe('pending');
      const crId = (await refundsRepo.byId(stack.deps.pool, refund.id))!.connectorRefundId!;
      stack.connectors.setRefundStatus(crId, outcome, outcome === 'failed' ? 'validation_failed' : undefined);
      await waitFor(async () => ((await refundsRepo.byId(stack.deps.pool, refund.id))?.status === outcome ? true : undefined), 30_000, `reembolso ${outcome}`);
      const hold = [...stack.ledger.holds.values()].find((h) => h.business_ref === `${refund.id}:refund`);
      expect(hold?.status).toBe(outcome === 'succeeded' ? 'posted' : 'voided');
      expect(stack.connectors.server.callsTo('GET', /^\/refunds\/cr_/).length).toBeGreaterThan(0);
      stack.connectors.scenario = 'ok';
    }
  });

  it('la consulta `stale` NO es una novedad: sigue pendiente, con la retención puesta y escalado; al poder consultar se resuelve', async () => {
    const intentId = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    stack.connectors.refundInquiryStale = true;
    const refund = await refundVia(intentId, 900);
    const crId = (await refundsRepo.byId(stack.deps.pool, refund.id))!.connectorRefundId!;
    stack.connectors.setRefundStatus(crId, 'succeeded');
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'refund_pending_timeout'", [intentId])).rows[0].n) > 0 ? true : undefined), 20_000, 'escalado');
    await new Promise((r) => setTimeout(r, 2500));
    expect((await refundsRepo.byId(stack.deps.pool, refund.id))?.status).toBe('pending'); // el «succeeded» era un dato viejo del conector
    stack.connectors.refundInquiryStale = false;
    await waitFor(async () => ((await refundsRepo.byId(stack.deps.pool, refund.id))?.status === 'succeeded' ? true : undefined), 30_000, 'resuelto al poder consultar');
    stack.connectors.scenario = 'ok';
  });
});

describe('6 · la cuenta de bank_transfer_instructions la informa el conector', () => {
  const bank = { amount_minor: 20000, currency: 'BOB', payment_method: { type: 'bank_transfer' } };

  it('correcto: con la cuenta del conector el pagador la ve (contrato) aunque no haya BANK_TRANSFER_*', async () => {
    stack.connectors.bankAccount = { bank_name: 'Banco de Prueba (sintético)', account_holder: 'ALOVIDA PRUEBA', account_number: '000-0000000-9' };
    const response = await post(MC, bank);
    expect(response.status).toBe(201);
    expect(response.body.next_action).toMatchObject({ type: 'bank_transfer_instructions', bank_transfer: { bank_name: 'Banco de Prueba (sintético)', account_number: '000-0000000-9' } });
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: response.body })).toEqual([]);
  });

  it('inválido: ni el conector ni la configuración (T-03) → 422 payment_method_unavailable, el cargo se ANULA y el intento queda failed sin asiento', async () => {
    const response = await post(MC, bank);
    expect(response.status).toBe(422);
    expect(response.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'payment_method_unavailable' })]));
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 422, body: response.body })).toEqual([]);
    const row = (await stack.db.pool.query("SELECT id, status, charge_status FROM payment_intents WHERE method = 'bank_transfer' ORDER BY created_at DESC LIMIT 1")).rows[0];
    expect(row.status).toBe('failed');
    expect(stack.connectors.charges.get(stack.connectors.chargeFor(row.id)!.id)?.status).toBe('canceled');
    expect(stack.ledger.postedCount(`${row.id}:capture`)).toBe(0);
  });
});

describe('7 · payment_intent.contradiction_detected (evento interno, mismo commit)', () => {
  it('una contradicción y un resultado ambiguo se publican UNA vez, conformes al AsyncAPI y con el modo del cobro', async () => {
    const id = (await post(MC, QR, 'live')).body.id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    stack.ledger.failNext = 1000;
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await waitFor(async () => ((await eventsOf(stack, id)).some((e) => e.type === 'payment_intent.contradiction_detected') ? true : undefined), 30_000, 'evento de resultado ambiguo');
    stack.ledger.failNext = 0;
    await settled(id, 'succeeded');
    const events = (await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.contradiction_detected');
    expect(events).toHaveLength(1); // los reintentos escalan una vez: el evento es único por hecho
    expect(events[0]?.envelope.data).toMatchObject({ payment_intent_id: id, kind: 'ledger_outcome_unknown', incoming_status: 'ambiguous', mode: 'live' });
    expect(validators.get('payment_intent.contradiction_detected')?.(events[0]?.envelope)).toEqual([]);
    // sin commit no hay evento: la fila y el evento nacen en la misma transacción
    const before = (await eventsOf(stack, id)).length;
    const { contradictionsRepo } = await import('../src/persistence/contradictions.repo');
    await expect(stack.deps.tx(async (db) => { await contradictionsRepo.record(db, { paymentIntentId: id, currentStatus: 'succeeded', incomingStatus: 'failed', sourceEventId: 'prueba-rollback', kind: 'status_conflict', reason: 'x' }); throw new Error('cae antes del commit'); })).rejects.toThrow('cae');
    expect((await eventsOf(stack, id)).length).toBe(before);
    expect((await stack.db.pool.query("SELECT count(*)::int AS n FROM intent_contradictions WHERE source_event_id = 'prueba-rollback'")).rows[0].n).toBe(0);
  });
});

describe('8 · D-28: modo por intento y filtro (comercio, modo) con X-Pay-Mode', () => {
  it('inválido: sin X-Pay-Mode, o con uno que no es test|live (incluido `sandbox`), toda ruta responde 403 y no toca la base', async () => {
    const routes: [string, string][] = [['post', '/payment_intents'], ['get', '/payment_intents'], ['get', '/payment_intents/pi_aaaaaaaaaa'], ['post', '/payment_intents/pi_aaaaaaaaaa/cancel'], ['post', '/payment_intents/pi_aaaaaaaaaa/refunds'], ['get', '/refunds/re_aaaaaaaaaa']];
    for (const [method, url] of routes) for (const mode of [undefined, 'sandbox', 'LIVE', '', 'test,live']) {
      const req = (http() as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set(EDGE).set('x-merchant-id', MC).set('idempotency-key', key());
      const response = await (mode === undefined ? req : req.set('x-pay-mode', mode)).send(method === 'post' ? QR : undefined);
      expect({ method, url, mode, status: response.status }).toEqual({ method, url, mode, status: 403 });
    }
    const internal = (mode?: string) => { const r = http().post('/intents').set({ 'x-service-id': 'pay-schedules' }).set('idempotency-key', key()); return (mode ? r.set('x-pay-mode', mode) : r).send({}); };
    expect((await internal()).status).toBe(403);
    expect((await internal('sandbox')).status).toBe(403);
    expect((await internal('test')).status).toBe(422); // con modo válido llega a validar el cuerpo
  });

  it('correcto/límite: la misma Idempotency-Key en `test` y en `live` son DOS cobros; cada modo ve, lista, cancela y reembolsa solo los suyos', async () => {
    const k = key();
    const test = await post(MC, QR, 'test', k);
    const live = await post(MC, QR, 'live', k);
    expect(test.body.id).not.toBe(live.body.id);
    expect((await post(MC, QR, 'live', k)).headers['idempotency-replayed']).toBe('true');
    const row = (id: string) => stack.db.pool.query('SELECT mode FROM payment_intents WHERE id = $1', [id]).then((r) => r.rows[0]?.mode);
    expect([await row(test.body.id), await row(live.body.id)]).toEqual(['test', 'live']);

    expect((await http().get(`/payment_intents/${live.body.id}`).set(asMerchant(MC, 'test'))).status).toBe(404);
    expect((await http().get(`/payment_intents/${live.body.id}`).set(asMerchant(MC, 'live'))).status).toBe(200);
    const listTest = await http().get('/payment_intents?limit=100').set(asMerchant(MC, 'test'));
    const listLive = await http().get('/payment_intents?limit=100').set(asMerchant(MC, 'live'));
    expect(listTest.body.data.map((i: { id: string }) => i.id)).toContain(test.body.id);
    expect(listTest.body.data.map((i: { id: string }) => i.id)).not.toContain(live.body.id);
    expect(listLive.body.data.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([live.body.id]));
    expect(await Promise.all(listLive.body.data.map((i: { id: string }) => row(i.id)))).toEqual(listLive.body.data.map(() => 'live'));
    expect((await http().post(`/payment_intents/${live.body.id}/cancel`).set(asMerchant(MC, 'test')).set('idempotency-key', key()).send({})).status).toBe(404);
    expect((await http().post(`/payment_intents/${live.body.id}/refunds`).set(asMerchant(MC, 'test')).set('idempotency-key', key()).send({ amount_minor: 1 })).status).toBe(404);
  });

  it('el modo viaja a ledger y conectores (X-Pay-Mode) y a todos los eventos', async () => {
    const id = await succeededIntent(MC, 'live');
    const mine = (calls: { headers: Record<string, unknown>; body: unknown }[]) => calls.filter((c) => JSON.stringify(c.body ?? '').includes(id) || JSON.stringify(c.body ?? '').includes(`${id}:capture`));
    const connectorCalls = mine(stack.connectors.server.callsTo('POST', /^\/charges$/));
    const ledgerCalls = mine(stack.ledger.server.callsTo('POST', /^\/transactions$/));
    expect(connectorCalls.length).toBeGreaterThan(0);
    expect(ledgerCalls.length).toBeGreaterThan(0);
    for (const call of [...connectorCalls, ...ledgerCalls]) expect(call.headers['x-pay-mode']).toBe('live');
    for (const status of stack.connectors.server.callsTo('GET', /\/charges\/ch_[a-z0-9]+\/status$/)) expect(['test', 'live']).toContain(status.headers['x-pay-mode']);
    for (const event of await eventsOf(stack, id)) {
      expect((event.envelope.data as Record<string, unknown>).mode).toBe('live');
      expect({ type: event.type, errors: validators.get(event.type)?.(event.envelope) }).toEqual({ type: event.type, errors: [] });
    }
    const refund = (await http().post(`/payment_intents/${id}/refunds`).set(asMerchant(MC, 'live')).set('idempotency-key', key()).send({ amount_minor: 300 })).body;
    const refundCall = stack.connectors.server.callsTo('POST', /\/refunds$/).find((c) => (c.body as { refund_id?: string }).refund_id === refund.id);
    expect(refundCall?.headers['x-pay-mode']).toBe('live');
    const hold = stack.ledger.server.callsTo('POST', /^\/holds$/).find((c) => (c.body as { business_ref: string }).business_ref === `${refund.id}:refund`);
    expect(hold?.headers['x-pay-mode']).toBe('live');
    for (const event of await eventsOf(stack, refund.id)) expect((event.envelope.data as Record<string, unknown>).mode).toBe('live');
  });

  it('el cobro por mandato respeta el modo: el GET de otro modo es 404', async () => {
    stack.ledger.setBalance(`merchant:${MC}:available`, 100000);
    const mandate = `md_ola2${Date.now().toString(36)}`;
    const created = await http().post('/intents').set({ 'x-service-id': 'pay-schedules', 'x-pay-mode': 'live' }).set('idempotency-key', key()).send({ source: { kind: 'mandate', id: mandate, period: '2026-10' }, kind: 'obligation', payer_merchant_id: MC, beneficiary_merchant_id: MC2, amount_minor: 1000, currency: 'BOB', payment_method: { type: 'wallet' } });
    expect(created.status).toBe(201);
    expect((await http().get(`/intents/${created.body.id}`).set({ 'x-service-id': 'pay-schedules', 'x-pay-mode': 'test' })).status).toBe(404);
    expect((await http().get(`/intents/${created.body.id}`).set({ 'x-service-id': 'pay-schedules', 'x-pay-mode': 'live' })).status).toBe(200);
  });
});

describe('9 · los dobles validan contra los YAML de contracts/ y no contra copias', () => {
  it('toda ruta de contrato que usan las pruebas apunta a la carpeta contracts/ del repositorio y existe', () => {
    const root = path.join(process.cwd(), '../../contracts');
    for (const file of [...Object.values(CONTRACTS), ASYNCAPI_PAYMENTS]) {
      expect(path.resolve(file).startsWith(path.resolve(root) + path.sep)).toBe(true);
      expect(existsSync(file)).toBe(true);
    }
    const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? sources(path.join(dir, n)) : n.endsWith('.ts') ? [path.join(dir, n)] : []));
    const text = sources(path.join(process.cwd(), 'test')).filter((f) => !f.endsWith('ola2.contracts.spec.ts')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/docs\/trabajo\/ola-[01]\/P\d\/[^'"`]*\.ya?ml/);
    expect(text).not.toMatch(/internal-risk-rule-sets/);
  });
});
