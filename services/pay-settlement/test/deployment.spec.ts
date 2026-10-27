import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { assertDeploymentSafe } from '../src/settlement/deployment';
import { HttpConnectorsClient, HttpLedgerClient } from '../src/settlement/http-clients';
import { KEY_MODE_OF, requirePayMode } from '../src/settlement/mode';
import { CONNECTORS_PORT, LEDGER_PORT } from '../src/settlement/ports';
import { AcquirerSettlementRail, BankTransferRail } from '../src/settlement/rails';
import { FakeConnectors, FakeLedger } from './helpers/fakes';

/**
 * `PAY_MODE` (D-26, decisión de la ola 2): pay-settlement lo lee EXPLÍCITO (sandbox|live), sin valor por defecto, y bajo `live` se niega a arrancar con
 * cualquier doble o con el conector mock. Relación con `X-Pay-Mode` (D-28): una clave `test` solo opera contra sandbox; una `live`, contra live.
 */
const KEYS = ['PAY_MODE', 'SETTLEMENT_MODE', 'SETTLEMENT_TRANSFER_CONNECTOR'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
afterEach(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

describe('guardia de despliegue: live no acepta dobles ni el conector mock', () => {
  const realLedger = new HttpLedgerClient('http://127.0.0.1:9', 100);
  const realConnectors = new HttpConnectorsClient('http://127.0.0.1:9', 100, 'bank_transfer');
  const bankRail = new BankTransferRail(realConnectors);
  const live = { payMode: 'live', mode: 'bank', transferConnector: 'bank_transfer' } as const;

  it('los clientes HTTP de verdad se declaran reales; los dobles no', () => {
    expect(realLedger.isReal).toBe(true);
    expect(realConnectors.isReal).toBe(true);
    expect((new FakeLedger() as { isReal?: boolean }).isReal).toBeUndefined();
    expect((new FakeConnectors() as { isReal?: boolean }).isReal).toBeUndefined();
  });

  it('live con colaboradores reales arranca', () => {
    expect(() => assertDeploymentSafe(live, { ledger: realLedger, connectors: realConnectors, rail: bankRail })).not.toThrow();
  });

  it.each([
    ['el ledger es un doble', { ledger: new FakeLedger(), connectors: realConnectors, rail: bankRail }, /cliente del ledger/],
    ['los conectores son un doble', { ledger: realLedger, connectors: new FakeConnectors(), rail: bankRail }, /cliente de conectores/],
    ['el riel es el doble del modo B', { ledger: realLedger, connectors: realConnectors, rail: new AcquirerSettlementRail() }, /riel acquirer_settlement/],
  ])('live: %s ⇒ NO arranca y lo nombra', (_n, collaborators, message) => {
    expect(() => assertDeploymentSafe(live, collaborators)).toThrow(message);
  });

  it('live con settlement.mode=acquirer o con el conector mock ⇒ NO arranca; juntos, los nombra a todos', () => {
    const real = { ledger: realLedger, connectors: realConnectors, rail: bankRail };
    expect(() => assertDeploymentSafe({ ...live, mode: 'acquirer' }, real)).toThrow(/settlement\.mode=acquirer/);
    expect(() => assertDeploymentSafe({ ...live, transferConnector: 'mock' }, real)).toThrow(/conector mock/);
    expect(() => assertDeploymentSafe({ ...live, mode: 'acquirer', transferConnector: 'mock' }, { ledger: new FakeLedger(), connectors: new FakeConnectors(), rail: new AcquirerSettlementRail() })).toThrow(
      /cliente del ledger, cliente de conectores, riel acquirer_settlement, settlement\.mode=acquirer \(modo B\), conector mock/,
    );
  });

  it('sandbox acepta dobles, el modo B y el conector mock', () => {
    expect(() => assertDeploymentSafe({ payMode: 'sandbox', mode: 'acquirer', transferConnector: 'mock' }, { ledger: new FakeLedger(), connectors: new FakeConnectors(), rail: new AcquirerSettlementRail() })).not.toThrow();
  });
});

describe('arranque de la aplicación', () => {
  async function boot(env: Partial<Record<(typeof KEYS)[number], string | null>>, doubles: { ledger?: boolean; connectors?: boolean } = {}): Promise<INestApplication> {
    for (const [k, v] of Object.entries(env)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    let builder = Test.createTestingModule({ imports: [AppModule] });
    if (doubles.ledger) builder = builder.overrideProvider(LEDGER_PORT).useValue(new FakeLedger());
    if (doubles.connectors) builder = builder.overrideProvider(CONNECTORS_PORT).useValue(new FakeConnectors());
    const app = (await builder.compile()).createNestApplication();
    await app.init();
    return app;
  }

  it('sin PAY_MODE: NO arranca (mensaje claro, sin valor por defecto)', async () => {
    await expect(boot({ PAY_MODE: null })).rejects.toThrow(/Falta la variable de entorno PAY_MODE.*no tiene valor por defecto/);
  });

  it('PAY_MODE inválido: NO arranca', async () => {
    await expect(boot({ PAY_MODE: 'staging' })).rejects.toThrow(/PAY_MODE inválido: staging/);
  });

  it('sandbox con el conector mock: arranca y el reporte de salud lo dice', async () => {
    const app = await boot({ PAY_MODE: 'sandbox', SETTLEMENT_MODE: 'bank' });
    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body.info.settlement).toMatchObject({ payMode: 'sandbox', simulated: false });
    } finally {
      await app.close();
    }
  });

  it('live con colaboradores reales (clientes HTTP, riel bancario, conector de verdad): arranca', async () => {
    const app = await boot({ PAY_MODE: 'live', SETTLEMENT_MODE: 'bank', SETTLEMENT_TRANSFER_CONNECTOR: null });
    try {
      const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(res.body.info.settlement).toMatchObject({ payMode: 'live', mode: 'bank', rail: 'bank_transfer', simulated: false });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['con un ledger doble', { ledger: true }, /cliente del ledger/],
    ['con un conector doble', { connectors: true }, /cliente de conectores/],
  ])('live %s: NO arranca', async (_n, doubles, message) => {
    await expect(boot({ PAY_MODE: 'live', SETTLEMENT_MODE: 'bank', SETTLEMENT_TRANSFER_CONNECTOR: null }, doubles)).rejects.toThrow(message);
  });

  it('sandbox con dobles: arranca (los dobles son de sandbox)', async () => {
    const app = await boot({ PAY_MODE: 'sandbox', SETTLEMENT_MODE: 'bank' }, { ledger: true, connectors: true });
    await app.close();
  });
});

describe('relación con X-Pay-Mode: una clave test solo opera contra sandbox; live, contra live', () => {
  it('la tabla de correspondencia', () => {
    expect(KEY_MODE_OF).toEqual({ sandbox: 'test', live: 'live' });
  });
  it.each([
    ['sandbox', 'test', true],
    ['sandbox', 'live', false],
    ['live', 'live', true],
    ['live', 'test', false],
    ['sandbox', undefined, false],
    ['live', undefined, false],
    ['sandbox', 'sandbox', false],
    ['live', '', false],
  ] as const)('despliegue %s con X-Pay-Mode=%p ⇒ %s', (deployment, header, allowed) => {
    if (allowed) expect(requirePayMode(header, deployment)).toBe(header);
    else expect(() => requirePayMode(header, deployment)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
});
