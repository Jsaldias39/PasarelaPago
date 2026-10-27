import request from 'supertest';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { IdempotencyStore } from '@pay/idempotency';
import { SIMULATED_BANK, MockPumpService } from '../src/core/mock-pump.service';
import { deploymentModeOf, parsePayMode } from '../src/core/pay-mode';
import { RoutingService } from '../src/core/routing.service';
import { TransfersService } from '../src/core/transfers.service';
import { REGISTRY } from '../src/core/tokens';
import type { ConnectorRegistry } from '../src/domain/registry';
import { asPayments, asSettlement, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';

// D-28 (X-Pay-Mode): el modo de la CLAVE lo fija pay-edge. Aquí: exigirlo, que coincida con el despliegue y el conector, guardarlo, filtrar por él.
let t: TestApp;
let bank: SimulatedBank;
let mock: MockConnector;
let seq = 0;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const count = async (table: string) => (await t.db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
const noEffect = async () => {
  for (const table of ['connector_charges', 'connector_refunds', 'connector_transfers', 'idempotency_keys', 'outbox_events', 'connector_api_attempts']) expect(await count(table)).toBe(0);
};
const transferBody = () => ({ business_ref: `po_mode${process.pid}${String((seq += 1)).padStart(5, '0')}:payout`, attempt: 1, connector: 'mock', amount_minor: 250000, currency: 'BOB', destination_ref: 'dest_comercio_0001' });

/** Las 8 operaciones donde el contrato exige el modo, listas para llamarse con cualquier cabecera `x-pay-mode`. */
const REQUIRED_OPS: Array<{ op: string; caller: 'pay-payments' | 'pay-settlement'; send: (headers: Record<string, string>) => request.Test }> = [
  { op: 'POST /charges', caller: 'pay-payments', send: (h) => request(t.app.getHttpServer()).post('/charges').set(h).set('idempotency-key', uniqueKey()).send(chargeBody({}, t.clock)) },
  { op: 'GET /charges/{id}', caller: 'pay-payments', send: (h) => request(t.app.getHttpServer()).get('/charges/ch_unknownunknown1').set(h) },
  { op: 'GET /charges/{id}/status', caller: 'pay-payments', send: (h) => request(t.app.getHttpServer()).get('/charges/ch_unknownunknown1/status').set(h) },
  { op: 'POST /charges/{id}/cancel', caller: 'pay-payments', send: (h) => request(t.app.getHttpServer()).post('/charges/ch_unknownunknown1/cancel').set(h).set('idempotency-key', uniqueKey()) },
  { op: 'POST /charges/{id}/refunds', caller: 'pay-payments', send: (h) => request(t.app.getHttpServer()).post('/charges/ch_unknownunknown1/refunds').set(h).set('idempotency-key', uniqueKey()).send({ amount_minor: 100 }) },
  { op: 'GET /refunds/{id}', caller: 'pay-payments', send: (h) => request(t.app.getHttpServer()).get('/refunds/cr_unknownunknown1').set(h) },
  { op: 'POST /transfers', caller: 'pay-settlement', send: (h) => request(t.app.getHttpServer()).post('/transfers').set(h).set('idempotency-key', uniqueKey()).send(transferBody()) },
  { op: 'GET /transfers/{reference}', caller: 'pay-settlement', send: (h) => request(t.app.getHttpServer()).get('/transfers/po_x:payout:1').set(h) },
];
const headersFor = (caller: string, mode?: string): Record<string, string> => ({ 'x-service-id': caller, ...(mode !== undefined && { 'x-pay-mode': mode }) });

describe('parsePayMode y modo de despliegue (nivel unitario: correcto, límite, inválido)', () => {
  it('correcto: test y live', () => {
    expect(parsePayMode('test')).toBe('test');
    expect(parsePayMode('live')).toBe('live');
    expect(deploymentModeOf('test')).toBe('sandbox');
    expect(deploymentModeOf('live')).toBe('live');
  });

  it.each([undefined, '', ' test', 'test ', 'TEST', 'Live', 'test,live', 'sandbox', 'prod', 'production', '1', 'null', ['test'], ['test', 'live']] as Array<string | string[] | undefined>)(
    'inválido (%p) ⇒ 403 forbidden, jamás un valor por defecto',
    (value) => {
      expect(() => parsePayMode(value)).toThrow(expect.objectContaining({ code: 'forbidden', status: 403 }));
    },
  );
});

describe('las 8 operaciones exigen X-Pay-Mode ∈ {test, live}', () => {
  for (const o of REQUIRED_OPS) {
    describe(o.op, () => {
      it.each([
        ['ausente', undefined],
        ['vacío', ''],
        ['en mayúsculas', 'TEST'],
        ['con otro valor', 'prod'],
        ['el del despliegue (sandbox)', 'sandbox'],
        ['dos valores', 'test,live'],
      ])('%s ⇒ 403 forbidden y SIN efecto', async (_name, value) => {
        const response = await o.send(headersFor(o.caller, value));
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('forbidden');
        t.contract.assertResponse({ method: o.op.split(' ')[0] as string, path: (o.op.split(' ')[1] as string).replace('{id}', 'ch_unknownunknown1').replace('{reference}', 'po_x:payout:1'), status: 403, body: response.body });
        await noEffect();
      });

      it('`live` contra un despliegue sandbox ⇒ 403 forbidden y SIN efecto (nunca se cae en live)', async () => {
        const response = await o.send(headersFor(o.caller, 'live'));
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('forbidden');
        await noEffect();
      });

      it('`test` contra un despliegue sandbox pasa la compuerta de modo (no es 403)', async () => {
        expect((await o.send(headersFor(o.caller, 'test'))).status).not.toBe(403);
      });
    });
  }

  it('el modo no se toma del cuerpo ni de la consulta', async () => {
    const response = await request(t.app.getHttpServer()).post('/charges?mode=test').set(headersFor('pay-payments')).set('idempotency-key', uniqueKey()).send({ ...chargeBody({}, t.clock), mode: 'test' });
    expect(response.status).toBe(403);
    await noEffect();
  });
});

describe('extractos y salud: el contrato declara el modo opcional', () => {
  const range = () => `from=${new Date(Date.now() - 60_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`;
  it('ausente ⇒ funciona; inválido o de otro despliegue ⇒ 403', async () => {
    expect((await request(t.app.getHttpServer()).get('/connectors/health').set(headersFor('pay-payments'))).status).toBe(200);
    expect((await request(t.app.getHttpServer()).get(`/statements?connector=mock&${range()}`).set(headersFor('pay-settlement'))).status).toBe(200);
    for (const mode of ['live', 'prod', '', 'TEST']) {
      expect((await request(t.app.getHttpServer()).get('/connectors/health').set(headersFor('pay-payments', mode))).status).toBe(403);
      expect((await request(t.app.getHttpServer()).get(`/statements?connector=mock&${range()}`).set(headersFor('pay-settlement', mode))).status).toBe(403);
    }
    expect((await request(t.app.getHttpServer()).get('/connectors/health').set(headersFor('pay-payments', 'test'))).status).toBe(200);
  });
});

describe('despliegue live: el modo de la petición tiene que ser live', () => {
  it('`test` contra un despliegue live ⇒ 403 en las 8 operaciones y sin efecto; `live` pasa la compuerta', async () => {
    const live = await createTestApp({ config: { mode: 'live' } });
    try {
      const attempts: Array<[string, request.Test, request.Test]> = [
        ['POST /charges', request(live.app.getHttpServer()).post('/charges').set(headersFor('pay-payments', 'test')).set('idempotency-key', uniqueKey()).send(chargeBody({}, live.clock)), request(live.app.getHttpServer()).post('/charges').set(headersFor('pay-payments', 'live')).set('idempotency-key', uniqueKey()).send(chargeBody({}, live.clock))],
        ['POST /transfers', request(live.app.getHttpServer()).post('/transfers').set(headersFor('pay-settlement', 'test')).set('idempotency-key', uniqueKey()).send(transferBody()), request(live.app.getHttpServer()).post('/transfers').set(headersFor('pay-settlement', 'live')).set('idempotency-key', uniqueKey()).send(transferBody())],
        ['GET /charges/{id}', request(live.app.getHttpServer()).get('/charges/ch_unknownunknown1').set(headersFor('pay-payments', 'test')), request(live.app.getHttpServer()).get('/charges/ch_unknownunknown1').set(headersFor('pay-payments', 'live'))],
        ['GET /refunds/{id}', request(live.app.getHttpServer()).get('/refunds/cr_unknownunknown1').set(headersFor('pay-payments', 'test')), request(live.app.getHttpServer()).get('/refunds/cr_unknownunknown1').set(headersFor('pay-payments', 'live'))],
        ['GET /transfers/{reference}', request(live.app.getHttpServer()).get('/transfers/po_x:payout:1').set(headersFor('pay-settlement', 'test')), request(live.app.getHttpServer()).get('/transfers/po_x:payout:1').set(headersFor('pay-settlement', 'live'))],
      ];
      for (const [op, withTest, withLive] of attempts) {
        const denied = await withTest;
        expect({ op, status: denied.status, code: denied.body.code }).toEqual({ op, status: 403, code: 'forbidden' });
        const passed = await withLive;
        expect({ op, passes: passed.status !== 403 }).toEqual({ op, passes: true });
      }
      // La clave `live` llegó al enrutador: sin conectores reales en este despliegue, el cobro no se pierde ni se inventa.
      expect((await live.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(0);
    } finally {
      await live.close();
    }
  });
});

describe('el modo del pedido se guarda y filtra TODA lectura por (id, modo)', () => {
  const insertLive = async () => {
    // Filas del OTRO modo (live) en una base de pruebas: lo que quedaría si un despliegue atendiera los dos modos.
    const chargeId = 'ch_livelivelivelive1';
    await t.db.pool.query(
      `INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, amount_minor, currency, provider_status,
                                      provider_reference, routing_version, expires_at, next_poll_at)
       VALUES ($1, 'pay-payments', 'k-live-0000000001', 'pi_livelivelive01', 'mc_clinicasantacruz1', 'live', 'mock', 'live', 'qr', 10000, 'BOB', 'captured', 'LIVE-0001', 1, now() + interval '1 hour', now())`,
      [chargeId],
    );
    await t.db.pool.query(
      `INSERT INTO connector_refunds (id, charge_id, refund_id, pay_mode, caller, idempotency_key, amount_minor, currency, status, provider_reference)
       VALUES ('cr_livelivelivelive1', $1, 're_livelivelive01', 'live', 'pay-payments', 'k-live-refund-0001', 1000, 'BOB', 'pending', NULL)`,
      [chargeId],
    );
    await t.db.pool.query(
      `INSERT INTO connector_transfers (id, business_ref, attempt, pay_mode, caller, connector, connector_mode, amount_minor, currency, destination_ref, status, provider_reference, may_have_reached_provider)
       VALUES ('tr_livelivelivelive1', 'po_live_0001:payout', 1, 'live', 'pay-settlement', 'mock', 'live', 5000, 'BOB', 'dest', 'paid', 'LIVE-T-1', true)`,
    );
    return chargeId;
  };

  it('un id (cobro, reembolso, transferencia) del OTRO modo da 404, igual que uno inexistente; el control del mismo modo sí se lee', async () => {
    const liveCharge = await insertLive();
    const mine = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    expect(mine.status).toBe(201);
    expect((await get(t.app, `/charges/${mine.body.id}`)).status).toBe(200); // control

    const notThere: Array<[string, request.Test]> = [
      ['GET /charges/{id}', request(t.app.getHttpServer()).get(`/charges/${liveCharge}`).set(asPayments)],
      ['GET /charges/{id}/status', request(t.app.getHttpServer()).get(`/charges/${liveCharge}/status?refresh=true`).set(asPayments)],
      ['POST /charges/{id}/cancel', request(t.app.getHttpServer()).post(`/charges/${liveCharge}/cancel`).set(asPayments).set('idempotency-key', uniqueKey())],
      ['POST /charges/{id}/refunds', request(t.app.getHttpServer()).post(`/charges/${liveCharge}/refunds`).set(asPayments).set('idempotency-key', uniqueKey()).send({ amount_minor: 100 })],
      ['GET /refunds/{id}', request(t.app.getHttpServer()).get('/refunds/cr_livelivelivelive1?refresh=true').set(asPayments)],
    ];
    for (const [op, req] of notThere) {
      const response = await req;
      expect({ op, status: response.status, code: response.body.code }).toEqual({ op, status: 404, code: 'resource_not_found' });
    }
    const transfer = await get(t.app, `/transfers/${encodeURIComponent('po_live_0001:payout:1')}`, asSettlement);
    expect(transfer.status).toBe(404);
    expect(transfer.body.code).toBe('transfer_not_found');
    // Nada del otro modo cambió.
    expect((await t.db.pool.query("SELECT provider_status FROM connector_charges WHERE id = $1", [liveCharge])).rows[0].provider_status).toBe('captured');
    expect((await t.db.pool.query("SELECT status FROM connector_refunds WHERE id = 'cr_livelivelivelive1'")).rows[0].status).toBe('pending');
    expect((await t.db.pool.query("SELECT status FROM connector_transfers WHERE id = 'tr_livelivelivelive1'")).rows[0].status).toBe('paid');
  });

  it('cada registro guarda el modo de SU pedido (cobro, reembolso, transferencia) y el del conector va aparte', async () => {
    const charge = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    await t.app.get(MockPumpService).tick();
    const refund = await post(t.app, `/charges/${charge.body.id}/refunds`, { amount_minor: 1000 }, asPayments, uniqueKey());
    const transfer = await post(t.app, '/transfers', transferBody(), asSettlement, uniqueKey());
    expect((await t.db.pool.query('SELECT pay_mode, connector_mode FROM connector_charges WHERE id = $1', [charge.body.id])).rows[0]).toEqual({ pay_mode: 'test', connector_mode: 'sandbox' });
    expect((await t.db.pool.query('SELECT pay_mode FROM connector_refunds WHERE id = $1', [refund.body.id])).rows[0]).toEqual({ pay_mode: 'test' });
    expect((await t.db.pool.query('SELECT pay_mode, connector_mode FROM connector_transfers WHERE id = $1', [transfer.body.id])).rows[0]).toEqual({ pay_mode: 'test', connector_mode: 'sandbox' });
    expect(charge.body.mode).toBe('sandbox'); // la API sigue mostrando el modo del CONECTOR
  });

  it('la base impide combinar una clave `live` con un conector `sandbox` (y al revés)', async () => {
    const bad = (payMode: string, connectorMode: string) =>
      t.db.pool.query(
        `INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, amount_minor, currency, routing_version, expires_at, next_poll_at)
         VALUES ($1, 'pay-payments', $2, $3, 'mc_clinicasantacruz1', $4, 'mock', $5, 'qr', 100, 'BOB', 1, now(), now())`,
        [`ch_mix${payMode}${connectorMode}abcdef`.slice(0, 22), `k-${payMode}${connectorMode}00000001`, `pi_mix${payMode}${connectorMode}00`.slice(0, 22), payMode, connectorMode],
      );
    await expect(bad('live', 'sandbox')).rejects.toMatchObject({ code: '23514' });
    await expect(bad('test', 'live')).rejects.toMatchObject({ code: '23514' });
    await expect(bad('test', 'sandbox')).resolves.toBeDefined();
    await expect(bad('live', 'live')).resolves.toBeDefined();
  });

  it('el ruteo solo ofrece conectores del modo de la clave: `live` no llega a `mock`', async () => {
    const routing = t.app.get(RoutingService);
    const forTest = await routing.choose({ method: 'qr', amountMinor: 100n, payMode: 'test' });
    const forLive = await routing.choose({ method: 'qr', amountMinor: 100n, payMode: 'live' });
    expect(forTest.candidates).toContain('mock');
    expect(forLive.candidates).toEqual([]);
  });

  it('una transferencia `live` hacia un conector `mock` ⇒ 403 aunque se salte la compuerta HTTP, y sin efecto', async () => {
    await expect(t.app.get(TransfersService).create('pay-settlement', 'live', uniqueKey(), transferBody())).resolves.toMatchObject({ status: 403 });
    expect(await count('connector_transfers')).toBe(0);
  });
});

describe('la misma Idempotency-Key en test y en live son dos operaciones distintas', () => {
  it('la clave se guarda por (llamador, modo)', async () => {
    const key = uniqueKey();
    expect((await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, key)).status).toBe(201);
    const scopes = (await t.db.pool.query('SELECT scope FROM idempotency_keys WHERE key = $1', [key])).rows;
    expect(scopes).toEqual([{ scope: 'pay-payments|test' }]);
    // Con el mismo llamador y la misma clave, el modo `live` es otra operación: ni repite la respuesta de `test` ni choca con su cuerpo.
    const store = t.app.get(IdempotencyStore);
    const live = await store.execute({ scope: 'pay-payments|live', key, requestHash: 'otro-cuerpo' }, async () => ({ status: 201, body: { id: 'otro' } }));
    expect(live.replayed).toBe(false);
    expect(live.body).toEqual({ id: 'otro' });
  });

  it('la base admite la misma (caller, idempotency_key) en los dos modos y rechaza repetirla dentro de uno', async () => {
    const insert = (mode: string, connectorMode: string, id: string, intent: string) =>
      t.db.pool.query(
        `INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, amount_minor, currency, routing_version, expires_at, next_poll_at)
         VALUES ($1, 'pay-payments', 'same-key-000000001', $2, 'mc_clinicasantacruz1', $3, 'mock', $4, 'qr', 100, 'BOB', 1, now(), now())`,
        [id, intent, mode, connectorMode],
      );
    await insert('test', 'sandbox', 'ch_samekeytestaaaaaa1', 'pi_sameintentaaaaaa1');
    await expect(insert('live', 'live', 'ch_samekeylivebbbbbb1', 'pi_sameintentaaaaaa1')).resolves.toBeDefined(); // mismo intento y misma clave, otro modo
    await expect(insert('test', 'sandbox', 'ch_samekeytestcccccc1', 'pi_sameintentcccccc1')).rejects.toMatchObject({ code: '23505' }); // misma clave y mismo modo
  });
});

describe('los callbacks no traen X-Pay-Mode: el modo sale del registro del cobro', () => {
  const deliver = async (reference: string, amount: bigint, eventId: string, extra: Record<string, string> = {}) => {
    const signed = await mock.signCallback({ dueAt: t.clock.now(), eventId, reference, status: 'captured', occurredAt: t.clock.now(), amountMinor: amount }, t.clock.now());
    return request(t.app.getHttpServer()).post('/callbacks/mock').set(signed.headers).set(extra).set('content-type', 'application/json').send(signed.rawBody.toString('utf8'));
  };

  it('un callback de un cobro `test` con la cabecera `X-Pay-Mode: live` la ignora: se aplica y queda con el modo del cobro', async () => {
    const created = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    bank.dueCallbacks(t.clock.now());
    const response = await deliver(created.body.id, 10000n, 'evt_mode0001', { 'x-pay-mode': 'live' });
    expect(response.status).toBe(200);
    expect(response.body.result).toBe('applied');
    expect((await t.db.pool.query("SELECT pay_mode FROM connector_callback_events WHERE provider_event_id = 'evt_mode0001'")).rows[0].pay_mode).toBe('test');
  });

  it('un callback de un cobro `live` (registro) queda con modo `live` aunque no traiga cabecera, y uno de una referencia ajena queda sin modo', async () => {
    await t.db.pool.query(
      `INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, amount_minor, currency, provider_reference, routing_version, expires_at, next_poll_at)
       VALUES ('ch_livecallbackaaaaa1', 'pay-payments', 'k-live-callback-001', 'pi_livecallback001', 'mc_clinicasantacruz1', 'live', 'mock', 'live', 'qr', 7000, 'BOB', 'LIVE-9', 1, now() + interval '1 hour', now())`,
    );
    expect((await deliver('ch_livecallbackaaaaa1', 7000n, 'evt_mode0002')).body.result).toBe('applied');
    expect((await deliver('ch_ghostghostghost12', 100n, 'evt_mode0003')).body.result).toBe('contradiction');
    const rows = (await t.db.pool.query("SELECT provider_event_id, pay_mode FROM connector_callback_events ORDER BY provider_event_id")).rows;
    expect(rows).toEqual([
      { provider_event_id: 'evt_mode0002', pay_mode: 'live' },
      { provider_event_id: 'evt_mode0003', pay_mode: null },
    ]);
  });

  it('el callback sigue siendo público y sin identidad ni modo: su autenticación es la firma', async () => {
    const created = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    const response = await deliver(created.body.id, 10000n, 'evt_mode0004');
    expect(response.status).toBe(200);
  });
});

