import request from 'supertest';
import { SERVICE_CONFIG, type ServiceConfig } from '../src/config';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { asPayments, asSettlement, createTestApp, post, uniqueKey, type TestApp } from './support/app';

let t: TestApp;
let bank: SimulatedBank;
let seq = 0;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const businessRef = () => `po_${process.pid}${String((seq += 1)).padStart(5, '0')}:payout`;
const body = (over: Record<string, unknown> = {}) => ({ business_ref: businessRef(), attempt: 1, connector: 'mock', amount_minor: 250000, currency: 'BOB', destination_ref: 'dest_comercio_0001', ...over });
const order = (b: Record<string, unknown>, key: string | null = uniqueKey()) => post(t.app, '/transfers', b, asSettlement, key);
const getTransfer = (reference: string) => request(t.app.getHttpServer()).get(`/transfers/${encodeURIComponent(reference)}`).set(asSettlement);
const rows = async () => (await t.db.pool.query('SELECT business_ref, attempt, status, provider_reference, failure_code FROM connector_transfers ORDER BY business_ref, attempt')).rows;

describe('POST /transfers', () => {
  it('transferencia pagada: contrato, referencia `business_ref:attempt` y consulta posterior', async () => {
    const b = body();
    const response = await order(b);
    expect(response.status).toBe(201);
    t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 201, body: response.body });
    expect(response.body).toMatchObject({ object: 'transfer', reference: `${b.business_ref}:1`, connector: 'mock', mode: 'sandbox', amount_minor: 250000, currency: 'BOB', status: 'paid', failure_code: null });
    const found = await getTransfer(`${b.business_ref}:1`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual(response.body);
    t.contract.assertResponse({ method: 'GET', path: `/transfers/${b.business_ref}:1`, status: 200, body: found.body });
  });

  it('el mismo par business_ref+attempt devuelve la MISMA transferencia (200) con otra clave y no paga dos veces', async () => {
    const b = body();
    const first = await order(b);
    const again = await order(b);
    expect(again.status).toBe(200);
    t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 200, body: again.body });
    expect(again.body).toEqual(first.body);
    expect(await rows()).toHaveLength(1);
    const sends = await t.db.pool.query("SELECT count(*)::int AS n FROM connector_api_attempts WHERE operation = 'create_transfer'");
    expect(sends.rows[0].n).toBe(1); // el proveedor recibió UNA sola orden
  });

  it('la misma Idempotency-Key repite la respuesta guardada', async () => {
    const b = body();
    const key = uniqueKey();
    const first = await order(b, key);
    const again = await order(b, key);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotency-replayed']).toBe('true');
  });

  it('mismo attempt con OTRO contenido ⇒ 422 idempotency_key_reused', async () => {
    const b = body();
    await order(b);
    for (const change of [{ amount_minor: 250001 }, { destination_ref: 'dest_otro' }, { connector: 'bank_transfer' }]) {
      const response = await order({ ...b, ...change });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('idempotency_key_reused');
      t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 422, body: response.body });
    }
    expect(await rows()).toHaveLength(1);
  });

  it('attempt nuevo tras una transferencia pagada ⇒ 409 invalid_state_transition', async () => {
    const b = body();
    await order(b);
    const second = await order({ ...b, attempt: 2 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('invalid_state_transition');
    t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 409, body: second.body });
    expect(await rows()).toHaveLength(1);
  });

  it('un attempt que no es el siguiente ⇒ 409; el 1 es el primero', async () => {
    const response = await order(body({ attempt: 2 }));
    expect(response.status).toBe(409);
    expect(response.body.detail).toContain('1');
    expect(await rows()).toHaveLength(0);
  });

  it('fallida por el banco (centavos 01): `failed` con failure_code; el siguiente attempt sí se acepta y se paga; después, 409', async () => {
    const b = body({ amount_minor: 250001 });
    const failed = await order(b);
    expect(failed.status).toBe(201);
    expect(failed.body).toMatchObject({ status: 'failed', failure_code: 'rejected_by_bank' });
    const retry = await order({ ...b, attempt: 2, amount_minor: 250000 });
    expect(retry.status).toBe(201);
    expect(retry.body).toMatchObject({ status: 'paid', reference: `${b.business_ref}:2` });
    expect((await order({ ...b, attempt: 3, amount_minor: 250000 })).status).toBe(409);
    // El intento fallido sigue consultable y no cambia.
    expect((await getTransfer(`${b.business_ref}:1`)).body.status).toBe('failed');
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM connector_transfers WHERE status = 'paid'")).rows[0].n).toBe(1);
  });

  it('en tránsito (centavos 02): no admite otro attempt; la consulta lo lleva a `paid` cuando el banco lo confirma', async () => {
    const b = body({ amount_minor: 250002 });
    const created = await order(b);
    expect(created.body.status).toBe('in_transit');
    expect((await order({ ...b, attempt: 2 })).status).toBe(409);
    expect((await getTransfer(`${b.business_ref}:1`)).body.status).toBe('in_transit');
    t.clock.advance(5000);
    const paid = await getTransfer(`${b.business_ref}:1`);
    expect(paid.body.status).toBe('paid');
    t.contract.assertResponse({ method: 'GET', path: `/transfers/${b.business_ref}:1`, status: 200, body: paid.body });
    expect((await rows())[0]).toMatchObject({ status: 'paid' });
  });

  it('atascada (centavos 08): sigue en tránsito aunque pase el tiempo', async () => {
    const b = body({ amount_minor: 250008 });
    await order(b);
    t.clock.advance(86_400_000);
    expect((await getTransfer(`${b.business_ref}:1`)).body.status).toBe('in_transit');
  });

  describe.each([
    ['timeout', 250007],
    ['un proxy contesta 502 con HTML', 250017],
    ['el socket se corta', 250027],
  ])('AMBIGUA — la orden se ejecuta y %s', (_name, amount) => {
    it('con reintentos: se reintenta con la MISMA referencia y el proveedor devuelve la transferencia ya ejecutada (un solo pago)', async () => {
      const b = body({ amount_minor: amount });
      const response = await order(b);
      expect(response.status).toBe(201);
      expect(response.body.status).toBe('paid');
      const attempts = await t.db.pool.query("SELECT outcome FROM connector_api_attempts WHERE operation = 'create_transfer' ORDER BY id");
      expect(attempts.rows.map((r) => r.outcome)).toEqual(['timeout', 'ok']);
      expect(await rows()).toHaveLength(1);
    });

    it('sin reintentos: responde 500 (jamás `connector_unavailable`), deja el registro, y la consulta autoritativa dice `paid`; reordenar no paga dos veces', async () => {
      const config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as { timeoutRetries: number };
      config.timeoutRetries = 0;
      try {
        const b = body({ amount_minor: amount });
        const ambiguous = await order(b);
        expect(ambiguous.status).toBe(500);
        expect(ambiguous.body.code).toBe('internal_error');
        expect(ambiguous.body.code).not.toBe('connector_unavailable');
        t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 500, body: ambiguous.body });
        const stuck = await rows();
        expect(stuck).toHaveLength(1);
        expect(stuck[0]).toMatchObject({ status: 'pending', provider_reference: null });
        const attempts = await t.db.pool.query("SELECT outcome FROM connector_api_attempts WHERE operation = 'create_transfer' ORDER BY id");
        expect(attempts.rows.map((r) => r.outcome)).toEqual(['timeout']);

        const resolved = await getTransfer(`${b.business_ref}:1`);
        expect(resolved.status).toBe(200);
        expect(resolved.body.status).toBe('paid');

        // Volver a ordenar el mismo par devuelve lo ya pagado.
        const again = await order(b);
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(resolved.body.id);
        expect(await rows()).toHaveLength(1);
      } finally {
        config.timeoutRetries = 2;
      }
    });
  });

  it('proveedor caído ANTES de enviar: 502 `connector_unavailable` (definitivo), no queda registro y el mismo attempt se puede reintentar', async () => {
    const b = body();
    bank.setDown(true);
    const down = await order(b);
    expect(down.status).toBe(502);
    expect(down.body.code).toBe('connector_unavailable');
    t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 502, body: down.body });
    expect(await rows()).toHaveLength(0);
    const notFound = await getTransfer(`${b.business_ref}:1`);
    expect(notFound.status).toBe(404);
    bank.setDown(false);
    const retry = await order(b);
    expect(retry.status).toBe(201);
    expect(retry.body.status).toBe('paid');
  });

  it('caída del simulador por importe (centavos 06) ⇒ 502 definitivo', async () => {
    const response = await order(body({ amount_minor: 250006 }));
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('connector_unavailable');
    expect(await rows()).toHaveLength(0);
  });

  it.each([
    ['campo desconocido', { surprise: 1 }, 'surprise'],
    ['business_ref demasiado corto', { business_ref: 'ab' }, 'business_ref'],
    ['business_ref con caracteres no admitidos', { business_ref: 'po x/y' }, 'business_ref'],
    ['attempt cero', { attempt: 0 }, 'attempt'],
    ['attempt decimal', { attempt: 1.5 }, 'attempt'],
    ['conector inexistente', { connector: 'paypal' }, 'connector'],
    ['importe cero', { amount_minor: 0 }, 'amount_minor'],
    ['importe decimal', { amount_minor: 10.5 }, 'amount_minor'],
    ['moneda que no es BOB', { currency: 'USD' }, 'currency'],
    ['destino vacío', { destination_ref: '' }, 'destination_ref'],
    ['destino de 101 caracteres', { destination_ref: 'x'.repeat(101) }, 'destination_ref'],
    ['conector no cargado (mercantil_qr)', { connector: 'mercantil_qr' }, 'connector'],
    ['conector sin transferencias (bank_transfer)', { connector: 'bank_transfer' }, 'connector'],
  ])('validación: %s ⇒ 422', async (_name, over, field) => {
    const response = await order(body(over as Record<string, unknown>));
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
    expect(response.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 422, body: response.body });
    expect(await rows()).toHaveLength(0);
  });

  it('sin Idempotency-Key ⇒ 400; un cuerpo que no es objeto ⇒ 422; pay-payments no puede ordenar transferencias', async () => {
    const noKey = await order(body(), null);
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('idempotency_key_required');
    t.contract.assertResponse({ method: 'POST', path: '/transfers', status: 400, body: noKey.body });
    expect((await order([1] as unknown as Record<string, unknown>)).status).toBe(422);
    expect((await post(t.app, '/transfers', body(), asPayments)).status).toBe(403);
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: 10 pedidos simultáneos del mismo par (claves distintas) ⇒ UNA transferencia y UN pago', async () => {
    await t.reset();
    const b = body();
    const responses = await Promise.all(Array.from({ length: 10 }, () => order(b)));
    expect(responses.every((r) => r.status === 201 || r.status === 200)).toBe(true);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.id)).size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: 'paid' });
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: attempt 1 y attempt 2 de la misma operación a la vez ⇒ solo uno prospera', async () => {
    await t.reset();
    const b = body();
    const [a, c] = await Promise.all([order(b), order({ ...b, attempt: 2 })]);
    expect([a.status, c.status].sort()).toEqual([201, 409]);
    expect(await rows()).toHaveLength(1);
  });
});

describe('GET /transfers/{reference}', () => {
  it('sin registro ⇒ 404 problem+json con code `transfer_not_found` (y solo así)', async () => {
    const response = await getTransfer('po_inexistente:payout:1');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.code).toBe('transfer_not_found');
    t.contract.assertResponse({ method: 'GET', path: '/transfers/po_inexistente:payout:1', status: 404, body: response.body });
  });

  it('el proveedor confirma que NO tiene registro de una orden pendiente ⇒ 404 transfer_not_found y se limpia la fila', async () => {
    const b = body();
    await t.db.pool.query(
      "INSERT INTO connector_transfers (id, business_ref, attempt, caller, connector, mode, amount_minor, currency, destination_ref) VALUES ('tr_ghostghostghost1', $1, 1, 'pay-settlement', 'mock', 'sandbox', 1000, 'BOB', 'dest')",
      [b.business_ref],
    );
    const response = await getTransfer(`${b.business_ref}:1`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('transfer_not_found');
    expect(await rows()).toHaveLength(0);
  });

  it('proveedor sin respuesta ⇒ el último estado conocido (no terminal), nunca un 404', async () => {
    const b = body({ amount_minor: 250002 });
    await order(b);
    bank.setDown(true);
    const response = await getTransfer(`${b.business_ref}:1`);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('in_transit');
  });

  it.each([
    ['sin attempt', 'po_x:payout'],
    ['attempt no numérico', 'po_x:payout:uno'],
    ['attempt cero', 'po_x:payout:0'],
    ['caracteres no admitidos', 'po x:1'],
    ['demasiado corta', 'a:'],
  ])('referencia mal formada (%s) ⇒ 400 bad_request', async (_name, reference) => {
    const response = await getTransfer(reference);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('bad_request');
    t.contract.assertResponse({ method: 'GET', path: `/transfers/${reference}`, status: 400, body: response.body });
  });

  it('una ruta desconocida NO se parece a transfer_not_found (404 genérico resource_not_found)', async () => {
    const response = await request(t.app.getHttpServer()).get('/transferencias/po_x:payout:1').set(asSettlement);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('resource_not_found');
  });
});
