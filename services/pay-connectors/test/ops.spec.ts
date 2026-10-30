import { SERVICE_CONFIG, type ServiceConfig } from '../src/config';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { HealthService } from '../src/core/health.service';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { PollerService } from '../src/core/poller.service';
import { asPayments, asSettlement, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';

let t: TestApp;
let bank: SimulatedBank;
let poller: PollerService;
let health: HealthService;
let config: { poller: { minAgeMs: number; baseBackoffMs: number; maxBackoffMs: number; batchSize: number }; health: { downAfterFailures: number } };
let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  poller = t.app.get(PollerService);
  health = t.app.get(HealthService);
  config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as unknown as typeof config;
  validateEvent = await loadEventValidator();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const create = async (over: Record<string, unknown> = {}) => {
  const response = await post(t.app, '/charges', chargeBody(over, t.clock), asPayments, uniqueKey());
  return response;
};
const row = async (id: string) => (await t.db.pool.query('SELECT * FROM connector_charges WHERE id = $1', [id])).rows[0];
const statusEvents = () => outboxEvents(t.db.pool, 'connector.transaction.status_changed');

describe('poller de estado (REQ-P4-5)', () => {
  it('callback perdido: antes de T no consulta; pasado T consulta, aplica `captured` y publica UN evento `status_inquiry`', async () => {
    const { body } = await create({ amount_minor: 10005 });
    expect(await poller.tick()).toEqual({ examined: 0, changed: 0, failed: 0 }); // todavía no cumplió T
    t.clock.advance(config.poller.minAgeMs + 1000);
    expect(await poller.tick()).toEqual({ examined: 1, changed: 1, failed: 0 });
    expect((await row(body.id)).provider_status).toBe('captured');
    const events = await statusEvents();
    expect(events).toHaveLength(1);
    expect(validateEvent(MESSAGES.status, events[0]?.envelope)).toEqual([]);
    expect(events[0]?.envelope.data).toMatchObject({ status: 'captured', observed_via: 'status_inquiry' });
    // Ya es terminal: ni se vuelve a consultar ni se vuelve a publicar.
    t.clock.advance(3_600_000);
    expect(await poller.tick()).toEqual({ examined: 0, changed: 0, failed: 0 });
    expect(await statusEvents()).toHaveLength(1);
  });

  it('proveedor caído: backoff exponencial con tope, sin perder el cobro', async () => {
    const { body } = await create({ amount_minor: 10005 });
    const previousMax = config.poller.maxBackoffMs;
    config.poller.maxBackoffMs = 100_000;
    try {
      bank.setDown(true);
      const delays: number[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        t.clock.advance(config.poller.minAgeMs + 1000 + (attempt === 0 ? 0 : 200_000));
        const summary = await poller.tick();
        expect(summary).toEqual({ examined: 1, changed: 0, failed: 1 });
        delays.push((await row(body.id)).next_poll_at.getTime() - t.clock.now().getTime());
        expect(await poller.tick()).toEqual({ examined: 0, changed: 0, failed: 0 }); // el siguiente turno todavía no llegó
      }
      expect(delays).toEqual([60_000, 100_000, 100_000]); // 30 s·2¹, 30 s·2² = 120 s → tope 100 s, tope
      expect((await row(body.id)).poll_attempts).toBe(3);
      bank.setDown(false);
      t.clock.advance(200_000);
      expect(await poller.tick()).toEqual({ examined: 1, changed: 1, failed: 0 });
      expect((await row(body.id)).provider_status).toBe('captured');
    } finally {
      config.poller.maxBackoffMs = previousMax;
    }
  });

  it('QR que nadie paga (centavos 08): al llegar `expires_at` el poller lo da por vencido', async () => {
    const { body } = await create({ amount_minor: 10008 });
    t.clock.advance(1_800_000);
    await poller.tick();
    expect((await row(body.id)).provider_status).toBe('pending');
    t.clock.advance(1_800_001);
    expect(await poller.tick()).toMatchObject({ changed: 1 });
    expect((await row(body.id)).provider_status).toBe('expired');
    const [event] = await statusEvents();
    expect(event?.envelope.data).toMatchObject({ status: 'expired', observed_via: 'status_inquiry' });
  });

  it('cobro que nunca llegó al proveedor se da por vencido localmente al expirar', async () => {
    bank.setDown(true);
    const failed = await create();
    expect(failed.status).toBe(502);
    bank.setDown(false);
    const id = (await t.db.pool.query('SELECT id FROM connector_charges')).rows[0].id as string;
    t.clock.advance(3_700_000);
    expect(await poller.tick()).toMatchObject({ examined: 1, changed: 1 });
    expect((await row(id)).provider_status).toBe('expired');
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: tres pollers a la vez sobre 6 cobros vencidos consultan cada cobro UNA vez', async () => {
    await t.reset();
    for (let i = 0; i < 6; i += 1) expect((await create({ amount_minor: 10005 })).status).toBe(201);
    t.clock.advance(config.poller.minAgeMs + 1000);
    const summaries = await Promise.all([poller.tick(), poller.tick(), poller.tick()]);
    expect(summaries.reduce((n, s) => n + s.examined, 0)).toBe(6);
    expect(summaries.reduce((n, s) => n + s.changed, 0)).toBe(6);
    const polls = await t.db.pool.query("SELECT subject_id AS charge_id, count(*)::int AS n FROM connector_api_attempts WHERE operation = 'get_status' GROUP BY subject_id");
    expect(polls.rows).toHaveLength(6);
    expect(polls.rows.every((r) => r.n === 1)).toBe(true);
    expect(await statusEvents()).toHaveLength(6);
  });
});

describe('salud de los conectores (P4.H2.M2)', () => {
  it('GET /connectors/health: un registro por conector cargado, con el contrato', async () => {
    const response = await get(t.app, '/connectors/health');
    expect(response.status).toBe(200);
    t.contract.assertResponse({ method: 'GET', path: '/connectors/health', status: 200, body: response.body });
    expect(response.body.data.map((h: { connector: string }) => h.connector).sort()).toEqual(['bank_transfer', 'mock']);
    expect(response.body.data.every((h: { mode: string; status: string }) => h.mode === 'sandbox' && h.status === 'up')).toBe(true);
    expect((await get(t.app, '/connectors/health', asSettlement)).status).toBe(200);
  });

  it('fallos consecutivos: degraded → down (sale del ruteo, evento `degraded`); un éxito: up + evento `recovered`', async () => {
    bank.setDown(true);
    await health.probeAll();
    expect((await get(t.app, '/connectors/health')).body.data.find((h: { connector: string }) => h.connector === 'mock').status).toBe('degraded');
    expect(await outboxEvents(t.db.pool, 'connector.health.degraded')).toHaveLength(0); // un fallo aislado no saca al conector

    await health.probeAll();
    await health.probeAll();
    const down = (await get(t.app, '/connectors/health')).body;
    t.contract.assertResponse({ method: 'GET', path: '/connectors/health', status: 200, body: down });
    expect(down.data.find((h: { connector: string }) => h.connector === 'mock').status).toBe('down');
    const degraded = await outboxEvents(t.db.pool, 'connector.health.degraded');
    expect(degraded).toHaveLength(1);
    expect(validateEvent(MESSAGES.degraded, degraded[0]?.envelope)).toEqual([]);
    expect(degraded[0]?.envelope.data).toMatchObject({ connector: 'mock', reason: 'unreachable', consecutive_failures: 3 });
    expect(degraded[0]?.envelope.merchantid).toBeUndefined();

    // Caído y sin otro conector para el medio: el cobro se rechaza con connector_unavailable, sin tocar al proveedor.
    const refused = await create();
    expect(refused.status).toBe(502);
    expect(refused.body.code).toBe('connector_unavailable');
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(0);

    // Más fallos mientras sigue caído no repiten el evento.
    await health.probeAll();
    expect(await outboxEvents(t.db.pool, 'connector.health.degraded')).toHaveLength(1);

    bank.setDown(false);
    await health.probeAll();
    const recovered = await outboxEvents(t.db.pool, 'connector.health.recovered');
    expect(recovered).toHaveLength(1);
    expect(validateEvent(MESSAGES.recovered, recovered[0]?.envelope)).toEqual([]);
    expect((await get(t.app, '/connectors/health')).body.data.find((h: { connector: string }) => h.connector === 'mock').status).toBe('up');
    expect((await create()).status).toBe(201);
  });

  it('un éxito intercalado reinicia la cuenta de fallos', async () => {
    bank.setDown(true);
    await health.probeAll();
    await health.probeAll();
    bank.setDown(false);
    await health.probeAll();
    bank.setDown(true);
    await health.probeAll();
    expect((await get(t.app, '/connectors/health')).body.data.find((h: { connector: string }) => h.connector === 'mock').status).toBe('degraded');
    expect(await outboxEvents(t.db.pool, 'connector.health.degraded')).toHaveLength(0);
  });

  it('el umbral es configurable', async () => {
    const previous = config.health.downAfterFailures;
    config.health.downAfterFailures = 1;
    try {
      bank.setDown(true);
      await health.probeAll();
      expect((await get(t.app, '/connectors/health')).body.data.find((h: { connector: string }) => h.connector === 'mock').status).toBe('down');
    } finally {
      config.health.downAfterFailures = previous;
    }
  });
});
