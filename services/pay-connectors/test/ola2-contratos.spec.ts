import request from 'supertest';
import { loadConfig, SANDBOX_BANK_ACCOUNT } from '../src/config';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { HealthService } from '../src/core/health.service';
import { SIMULATED_BANK, MockPumpService } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import { ConnectorTimeoutError, type ProviderRefundRequest } from '../src/domain/connector';
import type { ConnectorRegistry } from '../src/domain/registry';
import { SERVICE_CONFIG, type ServiceConfig } from '../src/config';
import { asPayments, asSettlement, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';

let t: TestApp;
let bank: SimulatedBank;
let pump: MockPumpService;
let mock: MockConnector;
let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;
let seq = 0;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  pump = t.app.get(MockPumpService);
  mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
  validateEvent = await loadEventValidator();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const refundId = () => `re_${process.pid}${String((seq += 1)).padStart(6, '0')}abc`;
const paid = async (amount = 10000): Promise<string> => {
  const created = await post(t.app, '/charges', chargeBody({ amount_minor: amount }, t.clock), asPayments, uniqueKey());
  await pump.tick();
  return created.body.id as string;
};
const refund = (chargeId: string, body: Record<string, unknown>, key: string | null = uniqueKey()) => post(t.app, `/charges/${chargeId}/refunds`, body, asPayments, key);
const getRefund = (id: string, query = '') => get(t.app, `/refunds/${id}${query}`, asPayments);
const txEvents = () => outboxEvents(t.db.pool, 'connector.transaction.status_changed');

describe('refund_id opcional en el pedido de reembolso', () => {
  it('se guarda, vuelve en `ConnectorRefund`, se copia al evento y la consulta lo repite', async () => {
    const id = await paid();
    const re = refundId();
    const response = await refund(id, { amount_minor: 3000, refund_id: re });
    expect(response.status).toBe(201);
    expect(response.body.refund_id).toBe(re);
    t.contract.assertResponse({ method: 'POST', path: `/charges/${id}/refunds`, status: 201, body: response.body });
    const [event] = (await txEvents()).filter((e) => (e.envelope.data as Record<string, unknown>).kind === 'refund');
    expect(validateEvent(MESSAGES.status, event?.envelope)).toEqual([]);
    expect(event?.envelope.data).toMatchObject({ kind: 'refund', refund_id: re, connector_transaction_id: response.body.id, connector: 'mock' });
    expect(event?.envelope.subject).toBe(response.body.id);
    expect((await getRefund(response.body.id)).body.refund_id).toBe(re);
  });

  it('sin `refund_id` va nulo (y en el evento también)', async () => {
    const id = await paid();
    const response = await refund(id, { amount_minor: 1000 });
    expect(response.body.refund_id).toBeNull();
    const [event] = (await txEvents()).filter((e) => (e.envelope.data as Record<string, unknown>).kind === 'refund');
    expect((event?.envelope.data as Record<string, unknown>).refund_id).toBeNull();
  });

  it.each(['re_', 'cr_abcdefghij12', 'RE_ABCDEFGHIJ12', 12345, ''])('refund_id inválido (%p) ⇒ 422', async (bad) => {
    const id = await paid();
    const response = await refund(id, { amount_minor: 1000, refund_id: bad });
    expect(response.status).toBe(422);
    expect(response.body.errors).toEqual([{ field: 'refund_id', code: 'invalid' }]);
  });

  it('el mismo `refund_id` con OTRA Idempotency-Key no genera un segundo reembolso (409); con la misma clave devuelve el original', async () => {
    const id = await paid();
    const re = refundId();
    const key = uniqueKey();
    const first = await refund(id, { amount_minor: 2000, refund_id: re }, key);
    const second = await refund(id, { amount_minor: 2000, refund_id: re }, uniqueKey());
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('invalid_state_transition');
    expect((await refund(id, { amount_minor: 2000, refund_id: re }, key)).body).toEqual(first.body);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_refunds')).rows[0].n).toBe(1);
  });
});

describe('GET /refunds/{id} (regla 11: la consulta autoritativa de un reembolso pending)', () => {
  it('reembolso resuelto: el contrato, `stale: false`, y `refresh` no vuelve a preguntar al proveedor', async () => {
    const id = await paid();
    const created = await refund(id, { amount_minor: 4000 });
    const found = await getRefund(created.body.id);
    expect(found.status).toBe(200);
    t.contract.assertResponse({ method: 'GET', path: `/refunds/${created.body.id}`, status: 200, body: found.body });
    expect(found.body).toMatchObject({ id: created.body.id, object: 'connector_refund', charge_id: id, amount_minor: 4000, status: 'succeeded', stale: false });
    const before = (await t.db.pool.query("SELECT count(*)::int AS n FROM connector_api_attempts WHERE operation = 'get_refund'")).rows[0].n;
    expect((await getRefund(created.body.id, '?refresh=true')).body.status).toBe('succeeded');
    expect((await t.db.pool.query("SELECT count(*)::int AS n FROM connector_api_attempts WHERE operation = 'get_refund'")).rows[0].n).toBe(before);
  });

  describe('reembolso AMBIGUO (el proveedor lo ejecutó y la respuesta se perdió)', () => {
    const withLostResponse = async (run: (id: string, cr: string) => Promise<void>) => {
      const original = mock.refund.bind(mock);
      const config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as { timeoutRetries: number };
      config.timeoutRetries = 0;
      mock.refund = async (request: ProviderRefundRequest, now: Date) => {
        await original(request, now); // el proveedor reembolsa…
        throw new ConnectorTimeoutError(); // …y la respuesta se pierde
      };
      try {
        const id = await paid();
        const ambiguous = await refund(id, { amount_minor: 5000, refund_id: refundId() });
        expect(ambiguous.status).toBe(500);
        const cr = (await t.db.pool.query('SELECT id FROM connector_refunds')).rows[0].id as string;
        await run(id, cr);
      } finally {
        mock.refund = original;
        config.timeoutRetries = 2;
      }
    };

    it('sin `refresh` devuelve lo último que se sabe (pending); con `refresh=true` el proveedor confirma, queda `succeeded` y se publica UN evento; repetir no lo repite', async () => {
      await withLostResponse(async (_id, cr) => {
        const quiet = await getRefund(cr);
        expect(quiet.body).toMatchObject({ status: 'pending', stale: false });
        expect((await txEvents()).filter((e) => (e.envelope.data as Record<string, unknown>).kind === 'refund')).toHaveLength(0);

        const resolved = await getRefund(cr, '?refresh=true');
        expect(resolved.status).toBe(200);
        expect(resolved.body).toMatchObject({ id: cr, status: 'succeeded', stale: false });
        t.contract.assertResponse({ method: 'GET', path: `/refunds/${cr}`, status: 200, body: resolved.body });
        await getRefund(cr, '?refresh=true');
        const events = (await txEvents()).filter((e) => (e.envelope.data as Record<string, unknown>).kind === 'refund');
        expect(events).toHaveLength(1);
        expect(validateEvent(MESSAGES.status, events[0]?.envelope)).toEqual([]);
        expect(events[0]?.envelope.data).toMatchObject({ status: 'captured', observed_via: 'status_inquiry', connector_transaction_id: cr });
      });
    });

    it('proveedor sin respuesta durante `refresh` ⇒ `stale: true`, la fila y la reserva NO se tocan (no es un fallo)', async () => {
      await withLostResponse(async (id, cr) => {
        bank.setDown(true);
        const response = await getRefund(cr, '?refresh=true');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ status: 'pending', stale: true });
        bank.setDown(false);
        expect((await t.db.pool.query('SELECT status, may_have_reached_provider AS flag FROM connector_refunds')).rows).toEqual([{ status: 'pending', flag: true }]);
        expect((await refund(id, { amount_minor: 6000 })).status).toBe(422); // la reserva de 5000 sigue en pie (5000 + 6000 > 10000)
      });
    });

    it('conector que no sabe consultar reembolsos ⇒ `stale: true` con lo último que se sabe', async () => {
      await withLostResponse(async (_id, cr) => {
        const original = mock.getRefund.bind(mock);
        (mock as { getRefund?: unknown }).getRefund = undefined;
        try {
          expect((await getRefund(cr, '?refresh=true')).body).toMatchObject({ status: 'pending', stale: true });
        } finally {
          mock.getRefund = original;
        }
      });
    });

    it('el proveedor responde `not_found` de forma explícita ⇒ sigue `pending` (sin `stale`), la fila NO se borra ni pasa a `failed`', async () => {
      const original = mock.refund.bind(mock);
      const config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as { timeoutRetries: number };
      config.timeoutRetries = 0;
      mock.refund = async () => {
        throw new ConnectorTimeoutError(); // la respuesta se pierde y el proveedor NUNCA lo recibió
      };
      try {
        const id = await paid();
        expect((await refund(id, { amount_minor: 5000 })).status).toBe(500);
        const cr = (await t.db.pool.query('SELECT id FROM connector_refunds')).rows[0].id as string;
        const response = await getRefund(cr, '?refresh=true');
        expect(response.body).toMatchObject({ status: 'pending', stale: false });
        expect((await t.db.pool.query('SELECT status FROM connector_refunds')).rows).toEqual([{ status: 'pending' }]);
      } finally {
        mock.refund = original;
        config.timeoutRetries = 2;
      }
    });

    it('proveedor caído ANTES de enviar: la fila quedó `failed` con motivo; la consulta lo informa (ni se borra ni vuelve a preguntar)', async () => {
      const id = await paid();
      bank.setDown(true);
      const down = await refund(id, { amount_minor: 5000 });
      expect(down.status).toBe(502);
      bank.setDown(false);
      const cr = (await t.db.pool.query('SELECT id FROM connector_refunds')).rows[0].id as string;
      const response = await getRefund(cr, '?refresh=true');
      expect(response.body).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable', stale: false });
      t.contract.assertResponse({ method: 'GET', path: `/refunds/${cr}`, status: 200, body: response.body });
    });
  });

  it('404 solo cuando ESTE servicio no lo tiene; un id mal formado tampoco existe; `refresh` inválido ⇒ 422', async () => {
    for (const id of ['cr_unknownunknown1', 'cr_x', 'ch_aaaaaaaaaaaaaaaa', 'CR_UNKNOWNUNKNOWN1']) {
      const response = await getRefund(id);
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('resource_not_found');
      t.contract.assertResponse({ method: 'GET', path: '/refunds/cr_unknownunknown1', status: 404, body: response.body });
    }
    const id = await paid();
    const created = await refund(id, { amount_minor: 1000 });
    expect((await getRefund(created.body.id, '?refresh=yes')).status).toBe(422);
  });

  it('solo pay-payments puede consultar: pay-settlement y sin identidad ⇒ 403', async () => {
    const id = await paid();
    const created = await refund(id, { amount_minor: 1000 });
    expect((await get(t.app, `/refunds/${created.body.id}`, asSettlement)).status).toBe(403);
    expect((await request(t.app.getHttpServer()).get(`/refunds/${created.body.id}`)).status).toBe(403);
  });
});

describe('eventos: `mock`, ids ch_/cr_ y `card_declined`', () => {
  it('el evento de un cobro cita `ch_…` (connector_transaction_id y subject), conector `mock`, y valida contra el AsyncAPI', async () => {
    const created = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    await pump.tick();
    const [event] = await txEvents();
    expect(validateEvent(MESSAGES.status, event?.envelope)).toEqual([]);
    expect(event?.envelope.subject).toBe(created.body.id);
    expect(event?.envelope.data).toMatchObject({ connector_transaction_id: created.body.id, connector: 'mock', kind: 'charge' });
    expect(JSON.stringify(event?.envelope)).not.toMatch(/"simulator"|"ct_/);
  });

  it('los eventos de salud usan `mock` (subject y data)', async () => {
    bank.setDown(true);
    for (let i = 0; i < 3; i += 1) await t.app.get(HealthService).probeAll();
    bank.setDown(false);
    const [degraded] = await outboxEvents(t.db.pool, 'connector.health.degraded');
    expect(validateEvent(MESSAGES.degraded, degraded?.envelope)).toEqual([]);
    expect(degraded?.envelope.subject).toBe('mock');
    expect((degraded?.envelope.data as Record<string, unknown>).connector).toBe('mock');
  });

  it('un callback `failed` con `card_declined` publica `failure_code: card_declined` (válido contra el AsyncAPI)', async () => {
    const created = await post(t.app, '/charges', chargeBody({ amount_minor: 10008 }, t.clock), asPayments, uniqueKey());
    const signed = await mock.signCallback({ dueAt: t.clock.now(), eventId: 'evt_cd000001', reference: created.body.id, status: 'failed', occurredAt: t.clock.now(), amountMinor: 10008n, failureCode: 'card_declined' }, t.clock.now());
    const response = await request(t.app.getHttpServer()).post('/callbacks/mock').set(signed.headers).set('content-type', 'application/json').send(signed.rawBody.toString('utf8'));
    expect(response.body.result).toBe('applied');
    const [event] = await txEvents();
    expect(validateEvent(MESSAGES.status, event?.envelope)).toEqual([]);
    expect(event?.envelope.data).toMatchObject({ status: 'failed', failure_code: 'card_declined' });
  });
});

describe('transferencia bancaria: datos de la cuenta en las instrucciones', () => {
  it('con la cuenta configurada, las instrucciones traen banco, titular y número (contrato) además de la referencia', async () => {
    const response = await post(t.app, '/charges', chargeBody({ method: 'bank_transfer' }, t.clock), asPayments, uniqueKey());
    expect(response.status).toBe(201);
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 201, body: response.body });
    expect(response.body.next_action).toEqual({
      type: 'bank_transfer_instructions',
      reference: response.body.provider_reference,
      bank_name: 'BANCO SIMULADO (SANDBOX)',
      account_holder: 'ALOVIDA PAY (SANDBOX)',
      account_number: 'SANDBOX-0000-0001',
    });
    // La consulta devuelve lo mismo (la referencia y la cuenta no cambian).
    expect((await get(t.app, `/charges/${response.body.id}`)).body.next_action).toEqual(response.body.next_action);
  });

  it('sin cuenta configurada (T-03) NO se inventa ninguna: las instrucciones salen solo con la referencia', async () => {
    const bare = await createTestApp({ config: { bankTransferAccount: undefined } });
    try {
      const response = await post(bare.app, '/charges', chargeBody({ method: 'bank_transfer' }, bare.clock), asPayments, uniqueKey());
      expect(response.status).toBe(201);
      expect(Object.keys(response.body.next_action).sort()).toEqual(['reference', 'type']);
      bare.contract.assertResponse({ method: 'POST', path: '/charges', status: 201, body: response.body });
    } finally {
      await bare.close();
    }
  });

  describe('configuración de la cuenta (BANK_TRANSFER_*) en tres niveles', () => {
    const base = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' };
    const sandbox = { ...base, PAY_MODE: 'sandbox' };
    const live = { ...base, PAY_MODE: 'live' };
    const full = { BANK_TRANSFER_BANK_NAME: 'Banco X', BANK_TRANSFER_ACCOUNT_HOLDER: 'Empresa SA', BANK_TRANSFER_ACCOUNT_NUMBER: '1234-5678' };
    const synthetic = { bankName: 'BANCO SIMULADO (SANDBOX)', accountHolder: 'ALOVIDA PAY (SANDBOX)', accountNumber: 'SANDBOX-0000-0001' };
    const without = (...names: string[]) => Object.fromEntries(Object.entries(full).filter(([name]) => !names.includes(name)));

    // Nivel correcto
    it('sandbox sin ninguna variable: arranca con la cuenta SINTÉTICA declarada (lleva el rótulo SANDBOX)', () => {
      expect(loadConfig({ ...sandbox }).bankTransferAccount).toEqual(synthetic);
      expect(SANDBOX_BANK_ACCOUNT).toEqual(synthetic);
      for (const value of Object.values(synthetic)) expect(value).toMatch(/SANDBOX/);
    });

    it('sandbox con las tres, o live con las tres: se usan tal cual', () => {
      const expected = { bankName: 'Banco X', accountHolder: 'Empresa SA', accountNumber: '1234-5678' };
      expect(loadConfig({ ...sandbox, ...full }).bankTransferAccount).toEqual(expected);
      expect(loadConfig({ ...live, ...full }).bankTransferAccount).toEqual(expected);
    });

    it('live sin ninguna: NO se inventa cuenta (T-03)', () => {
      expect(loadConfig({ ...live }).bankTransferAccount).toBeUndefined();
      expect(loadConfig({ ...live, BANK_TRANSFER_BANK_NAME: '  ', BANK_TRANSFER_ACCOUNT_HOLDER: '' }).bankTransferAccount).toBeUndefined();
    });

    // Nivel límite
    it('sandbox parcial: la variable que falta (o viene vacía) toma el valor sintético; las dadas se respetan', () => {
      for (const missing of Object.keys(full)) {
        const account = loadConfig({ ...sandbox, ...without(missing) }).bankTransferAccount;
        expect(account).toBeDefined();
        const [field, synth] = { BANK_TRANSFER_BANK_NAME: ['bankName', synthetic.bankName], BANK_TRANSFER_ACCOUNT_HOLDER: ['accountHolder', synthetic.accountHolder], BANK_TRANSFER_ACCOUNT_NUMBER: ['accountNumber', synthetic.accountNumber] }[missing] as [keyof typeof synthetic, string];
        expect(account?.[field]).toBe(synth);
      }
      expect(loadConfig({ ...sandbox, BANK_TRANSFER_ACCOUNT_NUMBER: '   ' }).bankTransferAccount?.accountNumber).toBe(synthetic.accountNumber);
    });

    it('los límites de longitud: 100 caracteres pasan, 101 no; número de 4 y 40 pasan, 3 y 41 no', () => {
      expect(loadConfig({ ...sandbox, BANK_TRANSFER_BANK_NAME: 'x'.repeat(100) }).bankTransferAccount?.bankName).toHaveLength(100);
      expect(loadConfig({ ...sandbox, BANK_TRANSFER_ACCOUNT_NUMBER: '1234' }).bankTransferAccount?.accountNumber).toBe('1234');
      expect(loadConfig({ ...sandbox, BANK_TRANSFER_ACCOUNT_NUMBER: 'A'.repeat(40) }).bankTransferAccount?.accountNumber).toHaveLength(40);
      expect(() => loadConfig({ ...sandbox, BANK_TRANSFER_ACCOUNT_NUMBER: '123' })).toThrow(/BANK_TRANSFER_ACCOUNT_NUMBER/);
      expect(() => loadConfig({ ...sandbox, BANK_TRANSFER_ACCOUNT_NUMBER: 'A'.repeat(41) })).toThrow(/BANK_TRANSFER_ACCOUNT_NUMBER/);
    });

    // Nivel inválido
    it('live con la cuenta a medias (una o dos de las tres) NO arranca', () => {
      for (const missing of Object.keys(full)) expect(() => loadConfig({ ...live, ...without(missing) })).toThrow(/los tres o ninguno/);
      for (const keep of Object.keys(full)) expect(() => loadConfig({ ...live, [keep]: (full as Record<string, string>)[keep] })).toThrow(/los tres o ninguno/);
    });

    it('valores inválidos fallan al arrancar en los dos modos', () => {
      for (const env of [sandbox, live]) {
        expect(() => loadConfig({ ...env, ...full, BANK_TRANSFER_ACCOUNT_NUMBER: '12' })).toThrow(/BANK_TRANSFER_ACCOUNT_NUMBER/);
        expect(() => loadConfig({ ...env, ...full, BANK_TRANSFER_ACCOUNT_NUMBER: '1234; DROP TABLE' })).toThrow(/BANK_TRANSFER_ACCOUNT_NUMBER/);
        expect(() => loadConfig({ ...env, ...full, BANK_TRANSFER_BANK_NAME: 'x'.repeat(101) })).toThrow(/BANK_TRANSFER_BANK_NAME/);
      }
      expect(() => loadConfig({ ...sandbox, BANK_TRANSFER_ACCOUNT_HOLDER: 'x'.repeat(101) })).toThrow(/BANK_TRANSFER_ACCOUNT_HOLDER/);
    });

    it('live con el rótulo del simulador en la cuenta NO arranca (una cuenta de mentira no se muestra como real)', () => {
      expect(() => loadConfig({ ...live, ...full, BANK_TRANSFER_BANK_NAME: 'BANCO SIMULADO (SANDBOX)' })).toThrow(/PAY_MODE=live no admite.*BANK_TRANSFER_BANK_NAME/);
      expect(() => loadConfig({ ...live, ...full, BANK_TRANSFER_ACCOUNT_NUMBER: 'SANDBOX-0000-0001' })).toThrow(/BANK_TRANSFER_ACCOUNT_NUMBER/);
    });
  });
});

describe('configuración de pay-mockbank (MOCKBANK_URL, capa sandbox)', () => {
  const base = { DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' };

  it('correcto: sin la variable el banco es el de proceso; con una URL http(s) válida se usa pay-mockbank y el timeout tiene su valor por defecto', () => {
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox' })).toMatchObject({ mockbankTimeoutMs: 5000 });
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox' }).mockbankUrl).toBeUndefined();
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox', MOCKBANK_URL: 'http://127.0.0.1:3112' }).mockbankUrl).toBe('http://127.0.0.1:3112');
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox', MOCKBANK_URL: 'https://mockbank.sandbox.invalid', MOCKBANK_TIMEOUT_MS: '1500' })).toMatchObject({ mockbankUrl: 'https://mockbank.sandbox.invalid', mockbankTimeoutMs: 1500 });
  });

  it('límite: timeout mínimo 1 ms; vacío = sin banco externo', () => {
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox', MOCKBANK_TIMEOUT_MS: '1' }).mockbankTimeoutMs).toBe(1);
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox', MOCKBANK_URL: '' }).mockbankUrl).toBeUndefined();
  });

  it('inválido: URL mal formada o de otro esquema, timeout 0/negativo/decimal ⇒ no arranca; bajo live NINGUNA de las dos variables puede estar definida', () => {
    for (const url of ['no es una url', 'ftp://127.0.0.1/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect(() => loadConfig({ ...base, PAY_MODE: 'sandbox', MOCKBANK_URL: url })).toThrow(/MOCKBANK_URL inválida/);
    }
    for (const ms of ['0', '-5', '1.5', 'abc']) expect(() => loadConfig({ ...base, PAY_MODE: 'sandbox', MOCKBANK_TIMEOUT_MS: ms })).toThrow(/MOCKBANK_TIMEOUT_MS inválido/);
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', MOCKBANK_URL: 'http://127.0.0.1:3112' })).toThrow(/PAY_MODE=live no admite.*MOCKBANK_URL/);
    expect(() => loadConfig({ ...base, PAY_MODE: 'live', MOCKBANK_TIMEOUT_MS: '500' })).toThrow(/PAY_MODE=live no admite.*MOCKBANK_TIMEOUT_MS/);
  });
});

describe('connector.transfer.status_changed', () => {
  const order = (over: Record<string, unknown> = {}, key: string | null = uniqueKey()) =>
    post(t.app, '/transfers', { business_ref: `po_ev${process.pid}${String((seq += 1)).padStart(5, '0')}:payout`, attempt: 1, connector: 'mock', amount_minor: 250000, currency: 'BOB', destination_ref: 'dest_comercio_0001', ...over }, asSettlement, key);
  const events = () => outboxEvents(t.db.pool, 'connector.transfer.status_changed');

  it('pagada: UN evento válido contra el AsyncAPI, sin `merchantid`, con `reference` y `transfer_id`; repetir el pedido no lo repite', async () => {
    const b = { business_ref: `po_paid${process.pid}${(seq += 1)}:payout` };
    const created = await order(b);
    expect(created.body.status).toBe('paid');
    await order(b); // mismo par: 200, sin evento nuevo
    const list = await events();
    expect(list).toHaveLength(1);
    expect(validateEvent(MESSAGES.transfer, list[0]?.envelope)).toEqual([]);
    expect(list[0]?.envelope.merchantid).toBeUndefined();
    expect(list[0]?.envelope.subject).toBe(created.body.id);
    expect(list[0]?.envelope.data).toMatchObject({ transfer_id: created.body.id, reference: created.body.reference, connector: 'mock', status: 'paid', amount_minor: 250000, currency: 'BOB', failure_code: null });
  });

  it('fallida por el banco: el evento trae `failure_code` (prueba de que NO se pagó)', async () => {
    await order({ amount_minor: 250001 });
    const [event] = await events();
    expect(validateEvent(MESSAGES.transfer, event?.envelope)).toEqual([]);
    expect(event?.envelope.data).toMatchObject({ status: 'failed', failure_code: 'rejected_by_bank' });
  });

  it('banco caído ANTES de enviar: `failed` con `connector_unavailable` también se anuncia', async () => {
    bank.setDown(true);
    expect((await order()).status).toBe(502);
    bank.setDown(false);
    const [event] = await events();
    expect(validateEvent(MESSAGES.transfer, event?.envelope)).toEqual([]);
    expect(event?.envelope.data).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });
  });

  it('en tránsito → pagada: un evento por cambio de estado, en orden, y la consulta que no cambia nada no publica', async () => {
    const b = { business_ref: `po_transit${process.pid}${(seq += 1)}:payout`, amount_minor: 250002 };
    await order(b);
    const reference = `${b.business_ref}:1`;
    await get(t.app, `/transfers/${encodeURIComponent(reference)}`, asSettlement); // sigue en tránsito: nada nuevo
    expect((await events()).map((e) => (e.envelope.data as Record<string, unknown>).status)).toEqual(['in_transit']);
    t.clock.advance(5000);
    await get(t.app, `/transfers/${encodeURIComponent(reference)}`, asSettlement);
    await get(t.app, `/transfers/${encodeURIComponent(reference)}`, asSettlement);
    const list = await events();
    expect(list.map((e) => (e.envelope.data as Record<string, unknown>).status)).toEqual(['in_transit', 'paid']);
    for (const e of list) expect(validateEvent(MESSAGES.transfer, e.envelope)).toEqual([]);
  });

  it('ambiguo (timeout, la orden se ejecutó): no se anuncia nada hasta que la consulta autoritativa lo resuelve, y entonces UN evento `paid`', async () => {
    const config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as { timeoutRetries: number };
    config.timeoutRetries = 0;
    try {
      const b = { business_ref: `po_amb${process.pid}${(seq += 1)}:payout`, amount_minor: 250007 };
      expect((await order(b)).status).toBe(500);
      expect(await events()).toHaveLength(0);
      await get(t.app, `/transfers/${encodeURIComponent(`${b.business_ref}:1`)}`, asSettlement);
      const list = await events();
      expect(list).toHaveLength(1);
      expect(list[0]?.envelope.data).toMatchObject({ status: 'paid', observed_via: 'status_inquiry' });
    } finally {
      config.timeoutRetries = 2;
    }
  });
});

