import { SERVICE_CONFIG, type ServiceConfig } from '../src/config';
import { SIMULATED_BANK, MockPumpService } from '../src/core/mock-pump.service';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { asPayments, asSettlement, chargeBody, createTestApp, get, intentId, post, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';

let t: TestApp;
let bank: SimulatedBank;
let pump: MockPumpService;
let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  pump = t.app.get(MockPumpService);
  validateEvent = await loadEventValidator();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  bank.setDown(false);
});

const create = (over: Record<string, unknown> = {}, key: string | null = uniqueKey()) => post(t.app, '/charges', chargeBody(over, t.clock), asPayments, key);
const rowOf = async (id: string) => (await t.db.pool.query('SELECT * FROM connector_charges WHERE id = $1', [id])).rows[0];

describe('POST /charges', () => {
  it('QR aprobado: cobro del contrato, con el payload del QR, ruteado al simulador en sandbox', async () => {
    const response = await create();
    expect(response.status).toBe(201);
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 201, body: response.body });
    expect(response.body).toMatchObject({ object: 'charge', connector: 'mock', mode: 'sandbox', method: 'qr', amount_minor: 10000, currency: 'BOB', status: 'requires_action', failure_code: null });
    expect(response.body.next_action.type).toBe('display_qr');
    expect(response.body.next_action.payload).toMatch(/^000201.*6304[0-9A-F]{4}$/);
    expect(response.body.provider_reference).toMatch(/^SIM-\d{6}$/);
    expect(t.qr.issued).toEqual([{ chargeId: response.body.id, amountMinor: 10000n }]);
    const row = await rowOf(response.body.id);
    expect(row).toMatchObject({ connector: 'mock', ambiguous: false, provider_status: 'pending', routing_version: 1, routing_rule: 'qr' });
  });

  it('sin Idempotency-Key ⇒ 400 idempotency_key_required y no se crea nada', async () => {
    const response = await create({}, null);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('idempotency_key_required');
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 400, body: response.body });
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(0);
  });

  it('la misma clave y el mismo cuerpo devuelven el MISMO cobro y no llaman otra vez al proveedor', async () => {
    const key = uniqueKey();
    const body = chargeBody({}, t.clock);
    const first = await post(t.app, '/charges', body, asPayments, key);
    const again = await post(t.app, '/charges', body, asPayments, key);
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(t.qr.issued).toHaveLength(1);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
  });

  it('la misma clave con OTRO cuerpo ⇒ 422 idempotency_key_reused', async () => {
    const key = uniqueKey();
    await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, key);
    const other = await post(t.app, '/charges', chargeBody({ amount_minor: 20000 }, t.clock), asPayments, key);
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('idempotency_key_reused');
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 422, body: other.body });
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: 20 pedidos simultáneos con la misma clave crean UN solo cobro y UN solo QR', async () => {
    await t.reset();
    const key = uniqueKey();
    const body = chargeBody({}, t.clock);
    const responses = await Promise.all(Array.from({ length: 20 }, () => post(t.app, '/charges', body, asPayments, key)));
    const ok = responses.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    for (const r of responses.filter((x) => x.status !== 201)) expect(r.body.code).toBe('idempotency_request_in_progress');
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
    expect(t.qr.issued.filter((q) => q.chargeId === ok[0]?.body.id)).toHaveLength(1);
  });

  it.each([
    ['campo desconocido', { surprise: 1 }, 'surprise'],
    ['moneda que no es BOB', { currency: 'USD' }, 'currency'],
    ['importe cero', { amount_minor: 0 }, 'amount_minor'],
    ['importe decimal', { amount_minor: 10.5 }, 'amount_minor'],
    ['importe como texto', { amount_minor: '100' }, 'amount_minor'],
    ['medio inexistente', { method: 'cash' }, 'method'],
    ['vence en el pasado', { expires_at: '2020-01-01T00:00:00.000Z' }, 'expires_at'],
    ['vencimiento ilegible', { expires_at: 'mañana' }, 'expires_at'],
    ['intento mal formado', { payment_intent_id: 'xx' }, 'payment_intent_id'],
    ['comercio mal formado', { merchant_id: 'mc_' }, 'merchant_id'],
    ['token de tarjeta con QR', { card_token: 'tok_abcdefghij12' }, 'card_token'],
    ['conector preferido inexistente', { preferred_connector: 'paypal' }, 'preferred_connector'],
    ['descripción de 201 caracteres', { description: 'x'.repeat(201) }, 'description'],
  ])('validación: %s ⇒ 422 con el campo señalado', async (_name, over, field) => {
    const response = await create(over as Record<string, unknown>);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
    expect(response.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 422, body: response.body });
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(0);
  });

  it('un cuerpo que no es un objeto ⇒ 422', async () => {
    const response = await post(t.app, '/charges', [1, 2, 3]);
    expect(response.status).toBe(422);
    expect(response.body.errors).toEqual([{ field: '/', code: 'not_an_object' }]);
  });

  it('un solo cobro vivo por intento: otro cobro del mismo intento ⇒ 409 hasta que el primero se anule', async () => {
    const intent = intentId();
    const first = await create({ payment_intent_id: intent, amount_minor: 10008 });
    const second = await create({ payment_intent_id: intent });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('invalid_state_transition');
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 409, body: second.body });
    await post(t.app, `/charges/${first.body.id}/cancel`, undefined);
    const third = await create({ payment_intent_id: intent, amount_minor: 10008 });
    expect(third.status).toBe(201);
    expect(third.body.id).not.toBe(first.body.id);
  });

  it('rechazo síncrono (centavos 01): el cobro nace `failed` con `card_declined`, y el intento puede reintentarse', async () => {
    const intent = intentId();
    const declined = await create({ payment_intent_id: intent, amount_minor: 10001, method: 'card' });
    expect(declined.status).toBe(201);
    expect(declined.body).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
    expect(declined.body.next_action).toBeUndefined();
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 201, body: declined.body });
    const retry = await create({ payment_intent_id: intent, amount_minor: 10000, method: 'card' });
    expect(retry.status).toBe(201);
    expect(retry.body.status).toBe('requires_action');
    expect(retry.body.next_action.type).toBe('redirect_to_card_form');
  });

  it('transferencia bancaria: instrucciones con una referencia única; el simulador de tarjeta/QR no interviene', async () => {
    const response = await create({ method: 'bank_transfer' });
    expect(response.status).toBe(201);
    expect(response.body.connector).toBe('bank_transfer');
    expect(response.body.next_action).toMatchObject({ type: 'bank_transfer_instructions' });
    expect(response.body.next_action.reference).toMatch(/^TR[A-Z2-7]{10}$/);
    expect(response.body.provider_reference).toBe(response.body.next_action.reference);
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 201, body: response.body });
  });

  it('nunca guarda ni devuelve el token de tarjeta', async () => {
    const response = await create({ method: 'card', card_token: 'tok_abcdefghij12345' });
    expect(response.status).toBe(201);
    expect(JSON.stringify(response.body)).not.toContain('tok_abcdefghij12345');
    const rows = await t.db.pool.query('SELECT row_to_json(c)::text AS j FROM connector_charges c');
    expect(rows.rows[0].j).not.toContain('tok_abcdefghij12345');
  });
});

describe('timeout ambiguo (centavos 07) y caída (centavos 06)', () => {
  it('el timeout se reintenta con la MISMA referencia: un solo cobro en el proveedor', async () => {
    const response = await create({ amount_minor: 10007 });
    expect(response.status).toBe(201);
    expect(response.body.status).toBe('succeeded'); // el proveedor ya lo había cobrado cuando se perdió la primera respuesta
    const lines = bank.statement({ from: new Date(0), to: new Date(Date.now() + 86_400_000) }).filter((l) => l.ourReference === response.body.id);
    expect(lines).toHaveLength(1);
    const attempts = await t.db.pool.query("SELECT outcome FROM connector_api_attempts WHERE charge_id = $1 AND operation = 'create_charge' ORDER BY id", [response.body.id]);
    expect(attempts.rows.map((r) => r.outcome)).toEqual(['timeout', 'ok']);
  });

  it('si el timeout persiste ⇒ 502 sin cambiar de conector; reintentar con la misma clave retoma el MISMO cobro', async () => {
    const config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as { timeoutRetries: number };
    const previous = config.timeoutRetries;
    config.timeoutRetries = 0;
    try {
      const key = uniqueKey();
      const body = chargeBody({ amount_minor: 10007 }, t.clock);
      const first = await post(t.app, '/charges', body, asPayments, key);
      expect(first.status).toBe(502);
      expect(first.body.code).toBe('connector_unavailable');
      t.contract.assertResponse({ method: 'POST', path: '/charges', status: 502, body: first.body });
      const stuck = (await t.db.pool.query('SELECT id, ambiguous, provider_reference FROM connector_charges')).rows[0];
      expect(stuck).toMatchObject({ ambiguous: true, provider_reference: null });

      const retry = await post(t.app, '/charges', body, asPayments, key);
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(stuck.id);
      expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
    } finally {
      config.timeoutRetries = previous;
    }
  });

  it('caída del simulador (centavos 06): 502 connector_unavailable y el proveedor no recibe nada', async () => {
    const response = await create({ amount_minor: 10006 });
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('connector_unavailable');
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 502, body: response.body });
    const id = (await t.db.pool.query('SELECT id FROM connector_charges')).rows[0].id;
    expect(bank.statement({ from: new Date(0), to: new Date(Date.now() + 86_400_000) }).filter((l) => l.ourReference === id)).toEqual([]);
    expect(t.qr.issued).toEqual([]);
  });

  it('proveedor caído al cobrar: 502 sin efecto; al volver, la MISMA clave completa el MISMO cobro', async () => {
    const key = uniqueKey();
    const body = chargeBody({}, t.clock);
    bank.setDown(true);
    const down = await post(t.app, '/charges', body, asPayments, key);
    expect(down.status).toBe(502);
    const stuck = (await t.db.pool.query('SELECT id, ambiguous, provider_reference FROM connector_charges')).rows[0];
    expect(stuck).toMatchObject({ ambiguous: false, provider_reference: null }); // sin llamada en vuelo: es seguro probar otro conector
    bank.setDown(false);
    const retry = await post(t.app, '/charges', body, asPayments, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(stuck.id);
    expect(retry.body.provider_reference).toMatch(/^SIM-/);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
  });
});

describe('GET /charges/{id} y /status', () => {
  it('lee un cobro: contrato, y un id mal formado o ajeno es 404', async () => {
    const created = await create();
    const found = await get(t.app, `/charges/${created.body.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual(created.body);
    t.contract.assertResponse({ method: 'GET', path: `/charges/${created.body.id}`, status: 200, body: found.body });
    for (const id of ['ch_unknownunknown1', 'xx', 'ch_UPPER12345678']) {
      const missing = await get(t.app, `/charges/${id}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('resource_not_found');
      t.contract.assertResponse({ method: 'GET', path: `/charges/${id}`, status: 404, body: missing.body });
    }
  });

  it('pay-settlement también puede leer', async () => {
    const created = await create();
    expect((await get(t.app, `/charges/${created.body.id}`, asSettlement)).status).toBe(200);
  });

  it('callback perdido (centavos 05): sin refresh sigue pendiente; con refresh=true el proveedor revela `captured` y se publica el evento', async () => {
    const created = await create({ amount_minor: 10005 });
    expect(await pump.tick()).toEqual([]); // el simulador no entrega nada
    const before = await get(t.app, `/charges/${created.body.id}/status`);
    expect(before.body).toMatchObject({ charge_id: created.body.id, status: 'requires_action', stale: false, connector: 'mock', mode: 'sandbox' });
    t.contract.assertResponse({ method: 'GET', path: `/charges/${created.body.id}/status`, status: 200, body: before.body });

    const refreshed = await get(t.app, `/charges/${created.body.id}/status?refresh=true`);
    expect(refreshed.body).toMatchObject({ status: 'succeeded', stale: false });
    t.contract.assertResponse({ method: 'GET', path: `/charges/${created.body.id}/status`, status: 200, body: refreshed.body });

    const [event] = await outboxEvents(t.db.pool, 'connector.transaction.status_changed');
    expect(validateEvent(MESSAGES.status, event?.envelope)).toEqual([]);
    expect((event?.envelope.data as Record<string, unknown>)).toMatchObject({ status: 'captured', observed_via: 'status_inquiry', kind: 'charge', connector: 'simulator', amount_minor: 10005 });
    // Una segunda consulta no repite el evento.
    await get(t.app, `/charges/${created.body.id}/status?refresh=true`);
    expect(await outboxEvents(t.db.pool, 'connector.transaction.status_changed')).toHaveLength(1);
  });

  it('proveedor sin respuesta durante refresh ⇒ último estado conocido con stale:true', async () => {
    const created = await create({ amount_minor: 10005 });
    bank.setDown(true);
    const response = await get(t.app, `/charges/${created.body.id}/status?refresh=true`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'requires_action', stale: true });
  });

  it('refresh con un valor que no es booleano ⇒ 422; cobro inexistente ⇒ 404', async () => {
    const created = await create();
    const bad = await get(t.app, `/charges/${created.body.id}/status?refresh=yes`);
    expect(bad.status).toBe(422);
    expect((await get(t.app, '/charges/ch_unknownunknown1/status')).status).toBe(404);
  });
});

describe('POST /charges/{id}/cancel', () => {
  it('anula un cobro pendiente; repetirlo (otra clave) es idempotente; el intento queda libre', async () => {
    const created = await create({ amount_minor: 10008 });
    const canceled = await post(t.app, `/charges/${created.body.id}/cancel`, undefined);
    expect(canceled.status).toBe(200);
    expect(canceled.body.status).toBe('canceled');
    t.contract.assertResponse({ method: 'POST', path: `/charges/${created.body.id}/cancel`, status: 200, body: canceled.body });
    const again = await post(t.app, `/charges/${created.body.id}/cancel`, undefined);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('canceled');
    const events = await outboxEvents(t.db.pool, 'connector.transaction.status_changed');
    expect(events).toHaveLength(1);
    expect(validateEvent(MESSAGES.status, events[0]?.envelope)).toEqual([]);
  });

  it('un cobro ya pagado no se anula ⇒ 409 invalid_state_transition', async () => {
    const created = await create();
    await pump.tick();
    const response = await post(t.app, `/charges/${created.body.id}/cancel`, undefined);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('invalid_state_transition');
    t.contract.assertResponse({ method: 'POST', path: `/charges/${created.body.id}/cancel`, status: 409, body: response.body });
  });

  it('sin Idempotency-Key ⇒ 400; cobro inexistente ⇒ 404', async () => {
    const created = await create();
    const noKey = await post(t.app, `/charges/${created.body.id}/cancel`, undefined, asPayments, null);
    expect(noKey.status).toBe(400);
    expect((await post(t.app, '/charges/ch_unknownunknown1/cancel', undefined)).status).toBe(404);
  });
});

describe('POST /charges/{id}/refunds', () => {
  const paid = async (amount = 10000) => {
    const created = await create({ amount_minor: amount });
    await pump.tick();
    return created.body.id as string;
  };

  it('reembolso parcial y total: contrato, evento `kind: refund`, y no se puede reembolsar más de lo cobrado', async () => {
    const id = await paid();
    const first = await post(t.app, `/charges/${id}/refunds`, { amount_minor: 3000, reason: 'cliente' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ object: 'connector_refund', charge_id: id, amount_minor: 3000, currency: 'BOB', status: 'succeeded', failure_code: null });
    t.contract.assertResponse({ method: 'POST', path: `/charges/${id}/refunds`, status: 201, body: first.body });
    expect((await post(t.app, `/charges/${id}/refunds`, { amount_minor: 7000 })).status).toBe(201);
    const over = await post(t.app, `/charges/${id}/refunds`, { amount_minor: 1 });
    expect(over.status).toBe(422);
    expect(over.body.errors).toEqual([{ field: 'amount_minor', code: 'exceeds_refundable' }]);
    t.contract.assertResponse({ method: 'POST', path: `/charges/${id}/refunds`, status: 422, body: over.body });

    const events = (await outboxEvents(t.db.pool, 'connector.transaction.status_changed')).filter((e) => (e.envelope.data as Record<string, unknown>).kind === 'refund');
    expect(events).toHaveLength(2);
    for (const e of events) expect(validateEvent(MESSAGES.status, e.envelope)).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: 5 reembolsos simultáneos de Bs 30 sobre Bs 100 ⇒ exactamente 3 prosperan', async () => {
    await t.reset();
    const id = await paid();
    const responses = await Promise.all(Array.from({ length: 5 }, () => post(t.app, `/charges/${id}/refunds`, { amount_minor: 3000 })));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(3);
    expect(responses.filter((r) => r.status === 422)).toHaveLength(2);
    const total = await t.db.pool.query("SELECT COALESCE(SUM(amount_minor), 0)::int AS n FROM connector_refunds WHERE status = 'succeeded'");
    expect(total.rows[0].n).toBe(9000);
  });

  it('la misma clave devuelve el mismo reembolso y no reembolsa dos veces', async () => {
    const id = await paid();
    const key = uniqueKey();
    const first = await post(t.app, `/charges/${id}/refunds`, { amount_minor: 4000 }, asPayments, key);
    const again = await post(t.app, `/charges/${id}/refunds`, { amount_minor: 4000 }, asPayments, key);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_refunds')).rows[0].n).toBe(1);
  });

  it('cobro no pagado ⇒ 409; inexistente ⇒ 404; cuerpo inválido ⇒ 422; sin clave ⇒ 400', async () => {
    const pending = await create({ amount_minor: 10008 });
    const notPaid = await post(t.app, `/charges/${pending.body.id}/refunds`, { amount_minor: 100 });
    expect(notPaid.status).toBe(409);
    expect(notPaid.body.code).toBe('invalid_state_transition');
    expect((await post(t.app, '/charges/ch_unknownunknown1/refunds', { amount_minor: 100 })).status).toBe(404);
    const id = await paid();
    for (const body of [{}, { amount_minor: 0 }, { amount_minor: 1.5 }, { amount_minor: 100, extra: 1 }]) {
      expect((await post(t.app, `/charges/${id}/refunds`, body)).status).toBe(422);
    }
    expect((await post(t.app, `/charges/${id}/refunds`, { amount_minor: 100 }, asPayments, null)).status).toBe(400);
  });

  it('proveedor caído ⇒ 502 sin efecto (la reserva se libera) y al volver la misma clave lo completa', async () => {
    const id = await paid();
    const key = uniqueKey();
    bank.setDown(true);
    const down = await post(t.app, `/charges/${id}/refunds`, { amount_minor: 10000 }, asPayments, key);
    expect(down.status).toBe(502);
    expect(down.body.code).toBe('connector_unavailable');
    expect((await t.db.pool.query("SELECT status, failure_code FROM connector_refunds")).rows[0]).toEqual({ status: 'failed', failure_code: 'connector_unavailable' });
    bank.setDown(false);
    const retry = await post(t.app, `/charges/${id}/refunds`, { amount_minor: 10000 }, asPayments, key);
    expect(retry.status).toBe(201);
    expect(retry.body.status).toBe('succeeded');
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_refunds')).rows[0].n).toBe(1);
  });
});
