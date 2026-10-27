import { loadContract, type ContractValidator } from '@pay/testing';
import { HttpConnectorsClient } from '../src/settlement/http-clients';
import { RailAmbiguousError, RailUnavailableError } from '../src/settlement/errors';
import type { PayoutOrder } from '../src/settlement/ports';
import { type SettlementTestContext, createSettlementContext, key, merchantId, repoPath } from './helpers/app';
import { type Behavior, ConnectorsServer, problem, transfer } from './helpers/connectors-server';
import { ref } from './helpers/scenarios';

let contract: ContractValidator;
let server: ConnectorsServer;
let client: HttpConnectorsClient;
beforeAll(async () => {
  contract = await loadContract(repoPath('contracts/openapi/internal-connectors-v1.yaml'));
});
beforeEach(async () => {
  server = new ConnectorsServer(contract);
  await server.start();
  client = new HttpConnectorsClient(server.url, 300, 'mock');
});
afterEach(async () => {
  const violations = server.violations;
  await server.stop();
  expect(violations).toEqual([]);
});

const order: PayoutOrder = { payoutId: 'po_abcdefghijklmnop', mode: 'test', businessRef: 'po_abcdefghijklmnop:payout', attempt: 1, merchantId: 'mc_abcdefghijk', amountMinor: 9000, currency: 'BOB' };
const REF = 'po_abcdefghijklmnop:payout:1';

const html502: Behavior = { kind: 'raw', status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1>nginx</body></html>' };
const empty502: Behavior = { kind: 'raw', status: 502, body: '' };

describe('POST /transfers — solo es definitivo lo que el contrato declara definitivo', () => {
  it('correcto: pagado, en tránsito y pendiente; lo que se envía cumple el contrato y la clave es estable', async () => {
    server.on('POST /transfers', transfer('paid', REF));
    expect(await client.createTransfer(order, 'payout-po_abcdefghijklmnop')).toEqual({ state: 'paid', reference: REF });
    server.on('POST /transfers', transfer('in_transit', REF));
    expect(await client.createTransfer(order, 'payout-po_abcdefghijklmnop')).toEqual({ state: 'in_transit', reference: REF });
    server.on('POST /transfers', transfer('pending', REF));
    expect(await client.createTransfer(order, 'payout-po_abcdefghijklmnop')).toEqual({ state: 'in_transit', reference: REF });
    for (const r of server.requests) {
      expect(contract.validateRequest({ method: 'POST', path: '/transfers', body: r.body })).toEqual([]);
      expect(r.headers['x-service-id']).toBe('pay-settlement');
      expect(r.headers['idempotency-key']).toBe('payout-po_abcdefghijklmnop');
      expect(r.body).toEqual({ business_ref: 'po_abcdefghijklmnop:payout', attempt: 1, connector: 'mock', amount_minor: 9000, currency: 'BOB', destination_ref: 'mc_abcdefghijk' });
    }
  });

  it('un rechazo con prueba: Transfer `failed` con `failure_code` ⇒ no se pagó', async () => {
    server.on('POST /transfers', transfer('failed', REF));
    expect(await client.createTransfer(order, 'k-1234567')).toEqual({ state: 'failed', code: 'rejected_by_bank' });
  });

  it('DEFINITIVO: 502 application/problem+json connector_unavailable ⇒ RailUnavailableError (la única forma de anular)', async () => {
    server.on('POST /transfers', problem(502, 'connector_unavailable'));
    await expect(client.createTransfer(order, 'k-1234567')).rejects.toBeInstanceOf(RailUnavailableError);
  });

  it.each<[string, Behavior]>([
    ['502 con el HTML de un proxy', html502],
    ['502 vacío', empty502],
    ['502 problem+json con OTRO código', problem(502, 'internal_error')],
    ['502 con el código correcto pero SIN content-type problem+json', { kind: 'raw', status: 502, contentType: 'application/json', body: '{"code":"connector_unavailable"}' }],
    ['503', { kind: 'raw', status: 503, body: 'Service Unavailable' }],
    ['504', { kind: 'raw', status: 504, contentType: 'text/html', body: '<h1>Gateway Timeout</h1>' }],
    ['500 del conector', problem(500, 'internal_error')],
    ['429', { kind: 'raw', status: 429, body: '' }],
    ['409: ese business_ref ya tiene una transferencia pagada', problem(409, 'invalid_state_transition')],
    ['422 (no prueba que no se ejecutó)', problem(422, 'validation_failed')],
    ['404 genérico de una ruta desconocida (el contrato de POST no lo declara: lo fabrica un proxy)', { kind: 'raw', status: 404, contentType: 'application/problem+json', body: JSON.stringify({ code: 'resource_not_found', status: 404 }) }],
    ['200 con cuerpo ilegible', { kind: 'raw', status: 200, contentType: 'application/json', body: '{"id":' }],
    ['200 con JSON que no es una Transfer', { kind: 'raw', status: 200, contentType: 'application/json', body: '{"ok":true}' }],
    ['200 con un id de transferencia mal formado', { kind: 'raw', status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', object: 'transfer', reference: REF, status: 'paid' }) }],
    ['200 `failed` SIN failure_code (no prueba nada)', { kind: 'raw', status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'tr_abcdefghijkl', object: 'transfer', reference: REF, status: 'failed', failure_code: null }) }],
    ['200 con un estado desconocido', { kind: 'raw', status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'tr_abcdefghijkl', object: 'transfer', reference: REF, status: 'quizas' }) }],
    ['corte de socket', { kind: 'cut' }],
    ['tiempo agotado (el conector no responde)', { kind: 'hang' }],
  ])('AMBIGUO: %s ⇒ RailAmbiguousError (el hold se mantiene)', async (_name, behavior) => {
    server.on('POST /transfers', behavior);
    await expect(client.createTransfer(order, 'k-1234567')).rejects.toBeInstanceOf(RailAmbiguousError);
  });

  it('nadie escucha en esa dirección (conexión rechazada) también es ambiguo: no se sabe si la orden salió antes del corte', async () => {
    const dead = new HttpConnectorsClient('http://127.0.0.1:9', 300, 'mock');
    await expect(dead.createTransfer(order, 'k-1234567')).rejects.toBeInstanceOf(RailAmbiguousError);
  });
});

describe('GET /transfers/{business_ref:attempt} — solo `404 transfer_not_found` prueba inexistencia', () => {
  it('correcto: consulta por business_ref:attempt (no por payout_id) y entiende los cuatro estados', async () => {
    for (const [status, expected] of [
      ['paid', { state: 'paid', reference: REF }],
      ['in_transit', { state: 'in_transit', reference: REF }],
      ['pending', { state: 'in_transit', reference: REF }],
      ['failed', { state: 'failed', code: 'rejected_by_bank' }],
    ] as const) {
      server.on('GET /transfers/{reference}', transfer(status, REF));
      expect(await client.queryTransfer(order)).toEqual(expected);
    }
    for (const r of server.requests) {
      expect(r.path).toBe(`/transfers/${REF}`);
      expect(r.path).not.toContain('payout_id');
    }
  });

  it('PRUEBA de inexistencia: 404 problem+json transfer_not_found', async () => {
    server.on('GET /transfers/{reference}', problem(404, 'transfer_not_found'));
    expect(await client.queryTransfer(order)).toEqual({ state: 'not_found' });
  });

  it.each<[string, Behavior]>([
    ['404 genérico resource_not_found (ruta desconocida)', problem(404, 'resource_not_found')],
    ['404 sin cuerpo', { kind: 'raw', status: 404, body: '' }],
    ['404 con el HTML de un proxy', { kind: 'raw', status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' }],
    ['404 con el código correcto pero SIN content-type problem+json', { kind: 'raw', status: 404, contentType: 'application/json', body: '{"code":"transfer_not_found"}' }],
    ['404 problem+json sin código', { kind: 'raw', status: 404, contentType: 'application/problem+json', body: '{"status":404}' }],
    ['502', html502],
    ['503', { kind: 'raw', status: 503, body: '' }],
    ['500 del conector', problem(500, 'internal_error')],
    ['200 ilegible', { kind: 'raw', status: 200, contentType: 'application/json', body: 'no es json' }],
    ['corte de socket', { kind: 'cut' }],
    ['tiempo agotado', { kind: 'hang' }],
  ])('AMBIGUO: %s ⇒ RailAmbiguousError (no se anula, no se paga de nuevo)', async (_name, behavior) => {
    server.on('GET /transfers/{reference}', behavior);
    await expect(client.queryTransfer(order)).rejects.toBeInstanceOf(RailAmbiguousError);
  });
});

describe('el doble de conectores cumple el contrato (si no, los demás resultados no valen)', () => {
  it('rechaza una respuesta que se aparta del contrato en vez de dejarla pasar', async () => {
    server.on('GET /transfers/{reference}', { kind: 'contract', status: 200, body: { id: 'tr_abcdefghijkl', object: 'transfer', status: 'paid' } });
    await expect(client.queryTransfer(order)).rejects.toBeInstanceOf(RailAmbiguousError); // 599 del doble: nunca un «pagado» inventado
    expect(server.violations).toHaveLength(1); // el doble se negó a enviarla
    server.violations.length = 0;
    expect(contract.operations()).toEqual(expect.arrayContaining(['POST /transfers', 'GET /transfers/{reference}']));
  });
});

describe('de punta a punta con el cliente HTTP real: el hold solo se mueve con evidencia', () => {
  let ctx: SettlementTestContext;
  afterEach(async () => ctx.close());

  async function setup(amount = 9_000) {
    ctx = await createSettlementContext({ connectorsPort: client });
    const m = merchantId();
    ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release' });
    return m;
  }
  const pay = (m: string, amount = 9_000) =>
    ctx.as('pay-schedules').post('/payouts', { merchant_id: m, amount_minor: amount, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key());
  const only = async () => (await ctx.db.pool.query('SELECT id, status, step, hold_business_ref FROM settlement_payouts')).rows[0];

  it('502 de un proxy después de enviar: el hold queda vivo, el pago en tránsito; la consulta dice «pagado» ⇒ post', async () => {
    const m = await setup();
    server.on('POST /transfers', html502);
    const res = await pay(m);
    expect(res.body.status).toBe('in_transit');
    expect(ctx.ledger.count('voidHold')).toBe(0);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`)).toBe(0); // retenido
    const { id } = await only();
    server.on('GET /transfers/{reference}', transfer('paid', `${id}:payout:1`));
    await ctx.payouts.recover();
    expect((await only()).status).toBe('paid');
    expect(ctx.ledger.count('postHold')).toBe(1);
    expect(ctx.ledger.count('voidHold')).toBe(0);
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1); // no se volvió a pagar
  });

  it('504 y la consulta dice `transfer_not_found` ⇒ recién ahí se anula el hold y el saldo vuelve', async () => {
    const m = await setup();
    server.on('POST /transfers', { kind: 'raw', status: 504, contentType: 'text/html', body: '<h1>Gateway Timeout</h1>' });
    expect((await pay(m)).body.status).toBe('in_transit');
    server.on('GET /transfers/{reference}', problem(404, 'transfer_not_found'));
    await ctx.payouts.recover();
    expect((await only()).status).toBe('failed');
    expect(ctx.ledger.count('voidHold')).toBe(1);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`)).toBe(9_000);
  });

  it('la consulta devuelve un 404 GENÉRICO: no prueba nada ⇒ el hold sigue vivo, no se paga de nuevo y se escala a una persona (una sola vez)', async () => {
    const m = await setup();
    server.on('POST /transfers', empty502);
    expect((await pay(m)).body.status).toBe('in_transit');
    server.on('GET /transfers/{reference}', problem(404, 'resource_not_found'));
    expect(await ctx.payouts.recover()).toEqual({ advanced: 0, failed: 0 });
    expect(await ctx.payouts.recover()).toEqual({ advanced: 0, failed: 0 });
    expect((await only()).status).toBe('in_transit');
    expect(ctx.ledger.count('voidHold')).toBe(0);
    expect(ctx.ledger.count('postHold')).toBe(0);
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    const escalations = await ctx.db.pool.query("SELECT subject, detail FROM settlement_audit WHERE action = 'payout.needs_attention'");
    expect(escalations.rows).toEqual([{ subject: (await only()).id, detail: { reason: 'RailAmbiguousError' } }]);
  });

  it('502 problem+json connector_unavailable: definitivo, se anula de inmediato', async () => {
    const m = await setup();
    server.on('POST /transfers', problem(502, 'connector_unavailable'));
    const res = await pay(m);
    expect(res.body).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });
    expect(ctx.ledger.count('voidHold')).toBe(1);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`)).toBe(9_000);
  });

  it.each<[string, Behavior]>([
    ['tiempo agotado', { kind: 'hang' }],
    ['corte de socket', { kind: 'cut' }],
  ])('%s al ordenar: ambiguo, con el hold vivo', async (_name, behavior) => {
    const m = await setup();
    server.on('POST /transfers', behavior);
    expect((await pay(m)).body.status).toBe('in_transit');
    expect(ctx.ledger.count('voidHold')).toBe(0);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`)).toBe(0);
  });
});

describe('extracto del conector con payment_intent_id (contrato de la ola 2)', () => {
  const line = (over: object) => ({ provider_reference: 'BNK-1', our_reference: 'ch_abcdefghijkl', charge_id: 'ch_abcdefghijkl', direction: 'credit', amount_minor: 10000, currency: 'BOB', value_date: '2026-10-20', booked_at: '2026-10-20T14:30:00.000Z', description: null, ...over });

  it('el cliente HTTP real entrega la línea con su payment_intent_id (la respuesta cumple el contrato) y la normalización lo conserva', async () => {
    server.on('GET /statements', { kind: 'contract', status: 200, body: { object: 'list', has_more: false, next_cursor: null, data: [line({ payment_intent_id: 'pi_abcdefghijkl' }), line({ provider_reference: 'BNK-2', payment_intent_id: null })] } });
    const { parseStatement } = await import('../src/settlement/statement-parsers');
    const lines = parseStatement(await client.getStatement({ connector: 'mock', from: '2026-10-19T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z', format: 'json' }));
    expect(lines.map((l) => [l.provider_reference, l.payment_intent_id ?? null])).toEqual([['BNK-1', 'pi_abcdefghijkl'], ['BNK-2', null]]);
    expect(lines[0].our_reference).toBe('ch_abcdefghijkl');
  });

  it('el cliente HTTP real entrega también `merchant_id` (la respuesta cumple el contrato) y la normalización lo conserva', async () => {
    server.on('GET /statements', { kind: 'contract', status: 200, body: { object: 'list', has_more: false, next_cursor: null, data: [line({ payment_intent_id: 'pi_abcdefghijkl', merchant_id: 'mc_abcdefghijk' }), line({ provider_reference: 'BNK-2', merchant_id: null })] } });
    const { parseStatement } = await import('../src/settlement/statement-parsers');
    const query = { connector: 'mock', from: '2026-10-19T00:00:00.000Z', to: '2026-10-27T00:00:00.000Z', format: 'json' } as const;
    expect((parseStatement(await client.getStatement(query))).map((l) => l.merchant_id ?? null)).toEqual(['mc_abcdefghijk', null]);
  });
});
