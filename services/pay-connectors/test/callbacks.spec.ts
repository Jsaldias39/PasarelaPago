import request from 'supertest';
import { signedHeaders, generateSecret } from '@pay/webhook-signature';
import { SERVICE_CONFIG, type ServiceConfig } from '../src/config';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { ScheduledCallback, SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import type { ConnectorRegistry } from '../src/domain/registry';
import { asPayments, chargeBody, createTestApp, post, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';

const SECRET_ENV = 'PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET';
const SECRET = process.env[SECRET_ENV] as string;

let t: TestApp;
let bank: SimulatedBank;
let mock: MockConnector;
let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
  validateEvent = await loadEventValidator();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  t.clock.advance(61_000); // ventana nueva del límite de velocidad
});

type Signed = { headers: Record<string, string>; rawBody: Buffer };
const deliver = (signed: Signed, path = '/callbacks/mock') => request(t.app.getHttpServer()).post(path).set(signed.headers).set('content-type', 'application/json').send(signed.rawBody);
const sign = (callback: ScheduledCallback) => mock.signCallback(callback, t.clock.now());
const dueFor = (chargeId: string) => bank.dueCallbacks(t.clock.now()).filter((c) => c.reference === chargeId);

async function charge(amount = 10000): Promise<{ id: string; due: ScheduledCallback[] }> {
  const response = await post(t.app, '/charges', chargeBody({ amount_minor: amount }, t.clock), asPayments, uniqueKey());
  expect(response.status).toBe(201);
  const due = bank.dueCallbacks(t.clock.now());
  return { id: response.body.id as string, due: due.filter((c) => c.reference === response.body.id) };
}
const statusOf = async (id: string) => (await t.db.pool.query('SELECT provider_status FROM connector_charges WHERE id = $1', [id])).rows[0].provider_status as string;
const count = async (table: string) => (await t.db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
const statusEvents = () => outboxEvents(t.db.pool, 'connector.transaction.status_changed');

describe('POST /callbacks/mock — camino feliz', () => {
  it('callback firmado y aprobado: 200 applied, el cobro queda pagado y se publica UN evento válido', async () => {
    const { id, due } = await charge();
    expect(due).toHaveLength(1);
    const response = await deliver(await sign(due[0] as ScheduledCallback));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'applied', charge_id: id });
    t.contract.assertResponse({ method: 'POST', path: '/callbacks/mock', status: 200, body: response.body });
    expect(await statusOf(id)).toBe('captured');
    const events = await statusEvents();
    expect(events).toHaveLength(1);
    expect(validateEvent(MESSAGES.status, events[0]?.envelope)).toEqual([]);
    expect(events[0]?.envelope.data).toMatchObject({ status: 'captured', observed_via: 'callback', kind: 'charge', connector: 'simulator', amount_minor: 10000, currency: 'BOB' });
    expect(events[0]?.envelope.merchantid).toBe('mc_clinicasantacruz1');
  });

  it('el callback `declined`/`failed` informado por el proveedor deja el cobro fallido con código estable', async () => {
    const { id } = await charge(10008);
    const failed = await sign({ dueAt: t.clock.now(), eventId: 'evt_fail0001', reference: id, status: 'failed', occurredAt: t.clock.now(), amountMinor: 10008n, failureCode: 'card_declined' });
    const response = await deliver(failed);
    expect(response.body.result).toBe('applied');
    const row = (await t.db.pool.query('SELECT provider_status, failure_code FROM connector_charges WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ provider_status: 'failed', failure_code: 'card_declined' });
    const [event] = await statusEvents();
    expect(validateEvent(MESSAGES.status, event?.envelope)).toEqual([]);
    expect(event?.envelope.data).toMatchObject({ status: 'failed', failure_code: 'validation_failed' }); // el catálogo de eventos no tiene `card_declined` (PROPUESTAS.md)
  });
});

describe('duplicados, desorden y contradicciones', () => {
  it('duplicado (centavos 03): el mismo hecho 3 veces ⇒ applied, duplicate, duplicate y UN solo evento', async () => {
    const { id, due } = await charge(10003);
    expect(due).toHaveLength(3);
    const results: string[] = [];
    for (const cb of due) results.push((await deliver(await sign(cb))).body.result);
    expect(results).toEqual(['applied', 'duplicate', 'duplicate']);
    expect(await statusEvents()).toHaveLength(1);
    expect(await count('connector_callback_events')).toBe(1);
    expect(await statusOf(id)).toBe('captured');
  });

  it('fuera de orden (centavos 04): `captured` y después `authorized` ⇒ applied, stale; el estado no retrocede', async () => {
    const { id, due } = await charge(10004);
    expect(due.map((c) => c.status)).toEqual(['captured', 'authorized']);
    const results: string[] = [];
    for (const cb of due) results.push((await deliver(await sign(cb))).body.result);
    expect(results).toEqual(['applied', 'stale']);
    expect(await statusOf(id)).toBe('captured');
    expect(await statusEvents()).toHaveLength(1);
    const stale = (await t.db.pool.query("SELECT status, result FROM connector_callback_events WHERE result = 'stale'")).rows;
    expect(stale).toEqual([{ status: 'authorized', result: 'stale' }]);
  });

  it('contradicción: `failed` después de `captured` ⇒ 200 contradiction, el estado NO cambia y no hay evento nuevo', async () => {
    const { id, due } = await charge();
    await deliver(await sign(due[0] as ScheduledCallback));
    const late = await deliver(await sign({ dueAt: t.clock.now(), eventId: 'evt_late0001', reference: id, status: 'failed', occurredAt: t.clock.now(), amountMinor: 10000n, failureCode: 'card_declined' }));
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ result: 'contradiction', charge_id: id });
    expect(await statusOf(id)).toBe('captured');
    expect(await statusEvents()).toHaveLength(1);
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM connector_callback_events WHERE result = 'contradiction'")).rows[0].n).toBe(1);
  });

  it('referencia que no es nuestra ⇒ 200 contradiction sin cobro, registrada para conciliación', async () => {
    const response = await deliver(await sign({ dueAt: t.clock.now(), eventId: 'evt_ghost001', reference: 'ch_ghostghostghost1', status: 'captured', occurredAt: t.clock.now(), amountMinor: 500n }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result: 'contradiction', charge_id: null });
    t.contract.assertResponse({ method: 'POST', path: '/callbacks/mock', status: 200, body: response.body });
    expect(await statusEvents()).toHaveLength(0);
    expect(await count('connector_callback_events')).toBe(1);
  });

  it('importe distinto del cobrado ⇒ contradiction: nunca se da por pagado un cobro con otro monto', async () => {
    const { id } = await charge();
    const response = await deliver(await sign({ dueAt: t.clock.now(), eventId: 'evt_amount01', reference: id, status: 'captured', occurredAt: t.clock.now(), amountMinor: 9999n }));
    expect(response.body.result).toBe('contradiction');
    expect(await statusOf(id)).toBe('pending');
    expect(await statusEvents()).toHaveLength(0);
  });

  it('un callback del conector equivocado no toca el cobro de otro', async () => {
    const { id } = await charge();
    await t.db.pool.query("UPDATE connector_charges SET connector = 'bank_transfer' WHERE id = $1", [id]);
    const response = await deliver(await sign({ dueAt: t.clock.now(), eventId: 'evt_cross001', reference: id, status: 'captured', occurredAt: t.clock.now(), amountMinor: 10000n }));
    expect(response.body).toEqual({ result: 'contradiction', charge_id: null });
    expect(await statusOf(id)).toBe('pending');
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: el MISMO callback entregado 12 veces a la vez ⇒ 1 applied, 11 duplicate, 1 evento', async () => {
    await t.reset();
    const { id, due } = await charge();
    const signed = await sign(due[0] as ScheduledCallback);
    const responses = await Promise.all(Array.from({ length: 12 }, () => deliver(signed)));
    const results = responses.map((r) => r.body.result as string);
    expect(results.filter((r) => r === 'applied')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(11);
    expect(await statusEvents()).toHaveLength(1);
    expect(await statusOf(id)).toBe('captured');
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: dos eventos DISTINTOS con el mismo estado a la vez ⇒ un solo avance', async () => {
    await t.reset();
    const { id } = await charge();
    const mk = (eventId: string) => sign({ dueAt: t.clock.now(), eventId, reference: id, status: 'captured', occurredAt: t.clock.now(), amountMinor: 10000n });
    const [a, b] = await Promise.all([mk('evt_conc_a'), mk('evt_conc_b')]);
    const [ra, rb] = await Promise.all([deliver(a), deliver(b)]);
    expect([ra.body.result, rb.body.result].sort()).toEqual(['applied', 'duplicate']);
    expect(await statusEvents()).toHaveLength(1);
  });
});

describe('autenticación: toda falla es 401 SIN EFECTO', () => {
  const mutate: Array<[string, (s: Signed, id: string) => Signed | Promise<Signed>]> = [
    ['sin cabeceras de firma', (s) => ({ ...s, headers: {} })],
    ['sin webhook-id', (s) => ({ ...s, headers: { ...s.headers, 'webhook-id': '' } })],
    ['firma basura', (s) => ({ ...s, headers: { ...s.headers, 'webhook-signature': 'v1,AAAA' } })],
    ['firmado con otro secreto', (s) => ({ ...s, headers: signedHeaders({ id: 'msg_x', timestamp: Math.floor(t.clock.now().getTime() / 1000), payload: s.rawBody.toString('utf8'), secrets: [generateSecret()] }) })],
    ['cuerpo alterado después de firmar', (s) => ({ ...s, rawBody: Buffer.from(s.rawBody.toString('utf8').replace('captured', 'failed')) })],
    ['timestamp vencido (> 5 min)', (s) => ({ ...s, headers: signedHeaders({ id: 'msg_x', timestamp: Math.floor(t.clock.now().getTime() / 1000) - 3600, payload: s.rawBody.toString('utf8'), secrets: [SECRET] }) })],
    ['timestamp del futuro', (s) => ({ ...s, headers: signedHeaders({ id: 'msg_x', timestamp: Math.floor(t.clock.now().getTime() / 1000) + 3600, payload: s.rawBody.toString('utf8'), secrets: [SECRET] }) })],
    ['cuerpo vacío', (s) => ({ ...s, rawBody: Buffer.alloc(0) })],
  ];

  it.each(mutate)('%s ⇒ 401 y no se guarda ni se publica nada', async (_name, change) => {
    const { id, due } = await charge();
    const response = await deliver(await change(await sign(due[0] as ScheduledCallback), id));
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
    t.contract.assertResponse({ method: 'POST', path: '/callbacks/mock', status: 401, body: response.body });
    expect(await count('connector_callback_events')).toBe(0);
    expect(await count('outbox_events')).toBe(0);
    expect(await statusOf(id)).toBe('pending');
  });

  it('firmado bien pero con cuerpo ilegible ⇒ 400 bad_request (no 401: la autenticación pasó) y sin efecto', async () => {
    const payload = '<<<no es json>>>';
    const headers = signedHeaders({ id: 'msg_bad1', timestamp: Math.floor(t.clock.now().getTime() / 1000), payload, secrets: [SECRET] });
    const response = await deliver({ headers, rawBody: Buffer.from(payload) });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('bad_request');
    expect(response.headers['content-type']).toContain('application/problem+json');
    t.contract.assertResponse({ method: 'POST', path: '/callbacks/mock', status: 400, body: response.body });
    expect(await count('connector_callback_events')).toBe(0);
  });

  it.each([
    ['sin id', { reference: 'ch_aaaaaaaaaaaaaa1', status: 'captured', occurred_at: '2026-01-01T00:00:00Z' }],
    ['estado inexistente', { id: 'e1', reference: 'ch_aaaaaaaaaaaaaa1', status: 'paid', occurred_at: '2026-01-01T00:00:00Z' }],
    ['referencia que no es un cobro', { id: 'e1', reference: 'otra-cosa', status: 'captured', occurred_at: '2026-01-01T00:00:00Z' }],
    ['fecha ilegible', { id: 'e1', reference: 'ch_aaaaaaaaaaaaaa1', status: 'captured', occurred_at: 'ayer' }],
    ['importe decimal', { id: 'e1', reference: 'ch_aaaaaaaaaaaaaa1', status: 'captured', occurred_at: '2026-01-01T00:00:00Z', amount_minor: 10.5 }],
    ['id de 201 caracteres', { id: 'x'.repeat(201), reference: 'ch_aaaaaaaaaaaaaa1', status: 'captured', occurred_at: '2026-01-01T00:00:00Z' }],
  ])('JSON firmado pero inválido (%s) ⇒ 400', async (_name, body) => {
    const payload = JSON.stringify(body);
    const headers = signedHeaders({ id: 'msg_bad2', timestamp: Math.floor(t.clock.now().getTime() / 1000), payload, secrets: [SECRET] });
    const response = await deliver({ headers, rawBody: Buffer.from(payload) });
    expect(response.status).toBe(400);
    expect(await count('connector_callback_events')).toBe(0);
  });

  it('sin secreto configurado el conector rechaza todo (fail-closed)', async () => {
    const { due } = await charge();
    const signed = await sign(due[0] as ScheduledCallback);
    const saved = process.env[SECRET_ENV];
    delete process.env[SECRET_ENV];
    try {
      expect((await deliver(signed)).status).toBe(401);
    } finally {
      process.env[SECRET_ENV] = saved;
    }
    expect(await count('connector_callback_events')).toBe(0);
  });

  it('rotación sin corte: con dos secretos vigentes valen los dos; al retirar el viejo, deja de valer', async () => {
    const saved = process.env[SECRET_ENV];
    const fresh = generateSecret();
    try {
      process.env[SECRET_ENV] = `${SECRET},${fresh}`;
      const a = await charge();
      expect((await deliver(await sign(a.due[0] as ScheduledCallback))).status).toBe(200); // firmado con el primero
      const b = await charge();
      const payload = JSON.stringify({ id: 'evt_rot0001', type: 'charge.status', reference: b.id, status: 'captured', occurred_at: t.clock.now().toISOString(), amount_minor: 10000 });
      const withNew = signedHeaders({ id: 'evt_rot0001', timestamp: Math.floor(t.clock.now().getTime() / 1000), payload, secrets: [fresh] });
      expect((await deliver({ headers: withNew, rawBody: Buffer.from(payload) })).status).toBe(200); // firmado con el nuevo

      process.env[SECRET_ENV] = fresh; // se retira el viejo
      const c = await charge();
      const signedOld = await sign(c.due[0] as ScheduledCallback); // mock.signCallback firma con lo vigente: el nuevo
      expect((await deliver(signedOld)).status).toBe(200);
      const oldPayload = JSON.stringify({ id: 'evt_rot0002', type: 'charge.status', reference: c.id, status: 'captured', occurred_at: t.clock.now().toISOString(), amount_minor: 10000 });
      const oldHeaders = signedHeaders({ id: 'evt_rot0002', timestamp: Math.floor(t.clock.now().getTime() / 1000), payload: oldPayload, secrets: [SECRET] });
      expect((await deliver({ headers: oldHeaders, rawBody: Buffer.from(oldPayload) })).status).toBe(401);
    } finally {
      process.env[SECRET_ENV] = saved;
    }
  });

  it('conector desconocido o no cargado en este modo ⇒ 404 resource_not_found', async () => {
    const { due } = await charge();
    const signed = await sign(due[0] as ScheduledCallback);
    for (const path of ['/callbacks/paypal', '/callbacks/mercantil_qr', '/callbacks/..%2Fadmin']) {
      const response = await deliver(signed, path);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('resource_not_found');
      t.contract.assertResponse({ method: 'POST', path: '/callbacks/mock', status: 404, body: response.body });
    }
  });

  it('`bank_transfer` está cargado pero el banco no notifica: todo callback es 401', async () => {
    const { due } = await charge();
    expect((await deliver(await sign(due[0] as ScheduledCallback), '/callbacks/bank_transfer')).status).toBe(401);
  });
});

describe('política de endpoint (red de origen, activo, ventana de repetición)', () => {
  const register = (over: Record<string, unknown> = {}) =>
    t.db.pool.query('INSERT INTO connector_callback_endpoints (connector, callback_path, active, allowed_source_cidrs, replay_window_seconds) VALUES ($1, $2, $3, $4::jsonb, $5)', [
      'mock',
      over.path ?? '/callbacks/mock',
      over.active ?? true,
      JSON.stringify(over.cidrs ?? null),
      over.window ?? null,
    ]);

  it('IP de origen fuera de las redes registradas ⇒ 401 sin efecto; dentro ⇒ 200', async () => {
    const { id, due } = await charge();
    await register({ cidrs: ['10.0.0.0/8'] });
    expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(401);
    expect(await statusOf(id)).toBe('pending');
    await t.db.pool.query('TRUNCATE connector_callback_endpoints');
    await register({ cidrs: ['127.0.0.1/32'] });
    expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(200);
  });

  it('endpoint desactivado, o ruta no registrada, ⇒ 401', async () => {
    const { due } = await charge();
    await register({ active: false });
    expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(401);
    await t.db.pool.query('TRUNCATE connector_callback_endpoints');
    await register({ path: '/callbacks/otro' });
    expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(401);
    expect(await count('connector_callback_events')).toBe(0);
  });

  it('lista de redes con una entrada inválida ⇒ fail-closed (401)', async () => {
    const { due } = await charge();
    await register({ cidrs: ['127.0.0.1/32', 'no-es-una-red'] });
    expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(401);
  });

  it('ventana de repetición: un callback firmado hace 2 min con ventana de 60 s ⇒ 401', async () => {
    const { due } = await charge();
    await register({ window: 60 });
    const old = await mock.signCallback(due[0] as ScheduledCallback, new Date(t.clock.now().getTime() - 120_000));
    expect((await deliver(old)).status).toBe(401);
    expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(200);
  });
});

describe('límite de velocidad', () => {
  it('pasado el tope por minuto ⇒ 429 rate_limited; en la ventana siguiente vuelve a aceptar', async () => {
    const config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as { callbackRatePerMinute: number };
    const previous = config.callbackRatePerMinute;
    config.callbackRatePerMinute = 3;
    try {
      const { due } = await charge();
      const signed = await sign(due[0] as ScheduledCallback);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await deliver(signed)).status);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      const limited = await deliver(signed);
      t.contract.assertResponse({ method: 'POST', path: '/callbacks/mock', status: 429, body: limited.body });
      t.clock.advance(61_000);
      expect((await deliver(await sign(due[0] as ScheduledCallback))).status).toBe(200);
    } finally {
      config.callbackRatePerMinute = previous;
    }
  });
});
