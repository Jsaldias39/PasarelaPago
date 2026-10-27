import { MockConnector } from '../src/connectors/mock/mock.connector';
import { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SERVICE_CONFIG, type ServiceConfig } from '../src/config';
import { HealthService } from '../src/core/health.service';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY, QR_PORT } from '../src/core/tokens';
import type { ConnectorRegistry } from '../src/domain/registry';
import { EnvSecretProvider } from '../src/domain/secrets';
import { asPayments, chargeBody, createTestApp, post, uniqueKey, type TestApp } from './support/app';
import { outboxEvents } from './support/events';

let t: TestApp;
let primaryBank: SimulatedBank;
let health: HealthService;
let config: { timeoutRetries: number };

beforeAll(async () => {
  t = await createTestApp();
  // [DOBLE] Un segundo simulador registrado como `mercantil_qr`: ejercita ruteo y conmutación por error mientras el banco
  // real no tenga adaptador. NO es el Banco Mercantil ni se parece a su API (que no conocemos).
  primaryBank = new SimulatedBank({ seed: 7 });
  const registry = t.app.get<ConnectorRegistry>(REGISTRY);
  registry.register(new MockConnector({ code: 'mercantil_qr', bank: primaryBank, secrets: new EnvSecretProvider(), qr: t.app.get(QR_PORT) }));
  health = t.app.get(HealthService);
  config = t.app.get<ServiceConfig>(SERVICE_CONFIG) as unknown as typeof config;
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  primaryBank.setDown(false);
  primaryBank.dueCallbacks(new Date(8.64e15));
});

const create = (over: Record<string, unknown> = {}, key: string | null = uniqueKey()) => post(t.app, '/charges', chargeBody(over, t.clock), asPayments, key);
const connectorOf = async (id: string) => (await t.db.pool.query('SELECT connector, ambiguous, provider_reference FROM connector_charges WHERE id = $1', [id])).rows[0];
const attemptsOf = async (id: string) => (await t.db.pool.query('SELECT connector, outcome FROM connector_api_attempts WHERE charge_id = $1 ORDER BY id', [id])).rows;

describe('ruteo por reglas (P4.H2.M1)', () => {
  it('la regla `qr` prefiere `mercantil_qr` cuando está sano; se registra la versión y la regla aplicadas', async () => {
    const response = await create();
    expect(response.status).toBe(201);
    expect(response.body.connector).toBe('mercantil_qr');
    const row = (await t.db.pool.query('SELECT routing_version, routing_rule FROM connector_charges')).rows[0];
    expect(row).toEqual({ routing_version: 1, routing_rule: 'qr' });
  });

  it('tarjeta: la regla pide `mercantil_card`, que no está cargado ⇒ cae al simulador', async () => {
    const response = await create({ method: 'card' });
    expect(response.body.connector).toBe('mock');
  });

  it('`preferred_connector` solo reordena dentro de lo que la regla permite', async () => {
    expect((await create({ preferred_connector: 'mock' })).body.connector).toBe('mock');
    expect((await create({ preferred_connector: 'bank_transfer' })).body.connector).toBe('mercantil_qr'); // la regla `qr` no lo lista
  });

  it('una versión nueva activa de reglas cambia el ruteo sin tocar código, y cada cobro guarda la suya', async () => {
    await t.db.pool.query("UPDATE routing_rule_sets SET active = false");
    await t.db.pool.query(
      "INSERT INTO routing_rule_sets (version, rules, active) VALUES (2, $1::jsonb, true)",
      [JSON.stringify([
        { id: 'qr-grande', when: { method: 'qr', amount_min_minor: 50000 }, route: ['mock'] },
        { id: 'qr', when: { method: 'qr' }, route: ['mercantil_qr', 'mock'] },
        { id: 'card', when: { method: 'card' }, route: ['mock'] },
        { id: 'bank_transfer', when: { method: 'bank_transfer' }, route: ['bank_transfer'] },
      ])],
    );
    const big = await create({ amount_minor: 60000 });
    const small = await create({ amount_minor: 10000 });
    expect(big.body.connector).toBe('mock');
    expect(small.body.connector).toBe('mercantil_qr');
    const rows = (await t.db.pool.query('SELECT amount_minor::int AS amount, routing_version, routing_rule FROM connector_charges ORDER BY amount_minor')).rows;
    expect(rows).toEqual([
      { amount: 10000, routing_version: 2, routing_rule: 'qr' },
      { amount: 60000, routing_version: 2, routing_rule: 'qr-grande' },
    ]);
    await t.db.pool.query('DELETE FROM routing_rule_sets WHERE version = 2');
    await t.db.pool.query('UPDATE routing_rule_sets SET active = true WHERE version = 1');
  });
});

describe('conmutación por error (REQ-P4-3)', () => {
  it('el preferido está caído ⇒ el cobro pasa al siguiente SIN duplicarse; el preferido no recibió nada', async () => {
    primaryBank.setDown(true);
    const response = await create();
    expect(response.status).toBe(201);
    expect(response.body.connector).toBe('mock');
    expect(await attemptsOf(response.body.id)).toEqual([
      { connector: 'mercantil_qr', outcome: 'unavailable' },
      { connector: 'mock', outcome: 'ok' },
    ]);
    expect(primaryBank.statement({ from: new Date(0), to: new Date(8.64e15) }).filter((l) => l.ourReference === response.body.id)).toEqual([]);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
  });

  it('tras N fallos el preferido sale del ruteo (no se le vuelve a intentar) y al recuperarse vuelve', async () => {
    primaryBank.setDown(true);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await create()).body.id as string);
    expect(await outboxEvents(t.db.pool, 'connector.health.degraded')).toHaveLength(1);
    const next = await create();
    expect(next.body.connector).toBe('mock');
    expect(await attemptsOf(next.body.id)).toEqual([{ connector: 'mock', outcome: 'ok' }]); // ni siquiera se intentó mercantil_qr

    primaryBank.setDown(false);
    await health.probeAll();
    expect(await outboxEvents(t.db.pool, 'connector.health.recovered')).toHaveLength(1);
    expect((await create()).body.connector).toBe('mercantil_qr');
  });

  it('todos caídos ⇒ 502 connector_unavailable; el cobro registrado no se pierde y la misma clave lo completa al volver', async () => {
    const mockBank = t.app.get<SimulatedBank>(SIMULATED_BANK);
    primaryBank.setDown(true);
    mockBank.setDown(true);
    const key = uniqueKey();
    const body = chargeBody({}, t.clock);
    const down = await post(t.app, '/charges', body, asPayments, key);
    expect(down.status).toBe(502);
    expect(down.body.code).toBe('connector_unavailable');
    t.contract.assertResponse({ method: 'POST', path: '/charges', status: 502, body: down.body });
    const stuck = (await t.db.pool.query('SELECT id, ambiguous, provider_reference FROM connector_charges')).rows;
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ ambiguous: false, provider_reference: null });
    expect(await attemptsOf(stuck[0].id)).toEqual([
      { connector: 'mercantil_qr', outcome: 'unavailable' },
      { connector: 'mock', outcome: 'unavailable' },
    ]);

    primaryBank.setDown(false);
    mockBank.setDown(false);
    const retry = await post(t.app, '/charges', body, asPayments, key);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(stuck[0].id);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
  });

  it('timeout AMBIGUO en el preferido ⇒ NO se cambia de conector (podría duplicarse): se reintenta el mismo con la misma referencia', async () => {
    config.timeoutRetries = 0;
    try {
      const key = uniqueKey();
      const body = chargeBody({ amount_minor: 10007 }, t.clock);
      const first = await post(t.app, '/charges', body, asPayments, key);
      expect(first.status).toBe(502);
      const stuck = (await t.db.pool.query('SELECT id, connector, ambiguous FROM connector_charges')).rows[0];
      expect(stuck).toMatchObject({ connector: 'mercantil_qr', ambiguous: true });
      expect(await attemptsOf(stuck.id)).toEqual([{ connector: 'mercantil_qr', outcome: 'timeout' }]);

      // Aunque mercantil_qr cayera ahora, un cobro ambiguo no migra a otro conector.
      const retry = await post(t.app, '/charges', body, asPayments, key);
      expect(retry.status).toBe(201);
      expect(retry.body.id).toBe(stuck.id);
      expect(retry.body.connector).toBe('mercantil_qr');
      expect(primaryBank.statement({ from: new Date(0), to: new Date(8.64e15) }).filter((l) => l.ourReference === stuck.id)).toHaveLength(1);
      expect(await connectorOf(stuck.id)).toMatchObject({ connector: 'mercantil_qr', ambiguous: false });
    } finally {
      config.timeoutRetries = 2;
    }
  });
});
