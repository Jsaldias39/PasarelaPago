import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { assertDeploymentSafe } from '../src/ledger/deployment';
import { loadLedgerConfig } from '../src/ledger/ledger.config';
import { KEY_MODE_OF, requirePayMode } from '../src/ledger/mode';
import { TB_ENGINE, TigerBeetleEngine } from '../src/ledger/tb-engine';

/**
 * `PAY_MODE` (D-26, decisión de la ola 2): el ledger lo lee EXPLÍCITO (sandbox|live), sin valor por defecto, y bajo `live` se niega a arrancar con
 * cualquier doble. Relación con `X-Pay-Mode` (D-28): una clave `test` solo opera contra sandbox; una `live`, contra live.
 */
const saved = process.env.PAY_MODE;
const savedMaskKey = process.env.IDEMPOTENCY_MASK_KEY;
// Bajo live el almacén de idempotencia exige IDEMPOTENCY_MASK_KEY (≥32 bytes, S-02). Valor sintético de prueba.
const MASK_KEY = 'clave-sintetica-de-prueba-0123456789abcdef';
afterEach(() => {
  if (saved === undefined) delete process.env.PAY_MODE;
  else process.env.PAY_MODE = saved;
  if (savedMaskKey === undefined) delete process.env.IDEMPOTENCY_MASK_KEY;
  else process.env.IDEMPOTENCY_MASK_KEY = savedMaskKey;
});

const BASE = { TB_ADDRESS: '127.0.0.1:54300' };

describe('PAY_MODE en la configuración: obligatorio, sin valor por defecto', () => {
  it.each([
    ['ausente', undefined],
    ['vacío', ''],
  ])('%s ⇒ no arranca y el mensaje dice qué falta y que no hay valor por defecto', (_n, value) => {
    expect(() => loadLedgerConfig({ ...BASE, ...(value === undefined ? {} : { PAY_MODE: value }) })).toThrow(/PAY_MODE.*sandbox \| live.*no tiene valor por defecto/);
  });

  it.each(['staging', 'prod', 'SANDBOX', 'test', 'Live', ' live'])('%p es inválido', (value) => {
    expect(() => loadLedgerConfig({ ...BASE, PAY_MODE: value })).toThrow(/PAY_MODE inválido/);
  });

  it.each(['sandbox', 'live'] as const)('%s se acepta tal cual', (value) => {
    expect(loadLedgerConfig({ ...BASE, PAY_MODE: value }).payMode).toBe(value);
  });
});

describe('guardia de despliegue: live no acepta dobles', () => {
  const real = { isReal: true };
  const double = {};
  it('sandbox acepta reales y dobles', () => {
    expect(() => assertDeploymentSafe({ payMode: 'sandbox' }, { motor: real })).not.toThrow();
    expect(() => assertDeploymentSafe({ payMode: 'sandbox' }, { motor: double })).not.toThrow();
  });
  it('live acepta colaboradores reales', () => {
    expect(() => assertDeploymentSafe({ payMode: 'live' }, { motor: real })).not.toThrow();
  });
  it.each([
    ['un doble sin marca', {}],
    ['uno que dice no ser real', { isReal: false }],
  ])('live con %s ⇒ error con su nombre', (_n, collaborator) => {
    expect(() => assertDeploymentSafe({ payMode: 'live' }, { 'motor de TigerBeetle': collaborator, otro: real })).toThrow(/PAY_MODE=live se niega a arrancar con dobles: motor de TigerBeetle\b/);
  });
  it('el motor de verdad se declara real', () => {
    expect(new TigerBeetleEngine(loadLedgerConfig({ ...BASE, PAY_MODE: 'sandbox' }).tb)).toMatchObject({ isReal: true });
  });
});

describe('arranque de la aplicación', () => {
  async function boot(payMode: string | undefined, fakeEngine = false, maskKey: string | undefined = MASK_KEY): Promise<INestApplication> {
    if (payMode === undefined) delete process.env.PAY_MODE;
    else process.env.PAY_MODE = payMode;
    if (maskKey === undefined) delete process.env.IDEMPOTENCY_MASK_KEY;
    else process.env.IDEMPOTENCY_MASK_KEY = maskKey;
    let builder = Test.createTestingModule({ imports: [AppModule] });
    if (fakeEngine) builder = builder.overrideProvider(TB_ENGINE).useValue({ destroy: () => undefined });
    const app = (await builder.compile()).createNestApplication();
    await app.init();
    return app;
  }

  it.each(['sandbox', 'live'])('PAY_MODE=%s con TigerBeetle real: arranca y responde /health/ready', async (mode) => {
    const app = await boot(mode);
    try {
      await request(app.getHttpServer()).get('/health/ready').expect(200);
    } finally {
      await app.close();
    }
  });

  it('sin PAY_MODE: NO arranca (mensaje claro)', async () => {
    await expect(boot(undefined)).rejects.toThrow(/Falta la variable de entorno PAY_MODE/);
  });

  it('PAY_MODE inválido: NO arranca', async () => {
    await expect(boot('staging')).rejects.toThrow(/PAY_MODE inválido: staging/);
  });

  it('PAY_MODE=live con un motor que es un doble: NO arranca', async () => {
    await expect(boot('live', true)).rejects.toThrow(/PAY_MODE=live se niega a arrancar con dobles: motor de TigerBeetle/);
  });

  it('PAY_MODE=live SIN IDEMPOTENCY_MASK_KEY (o con una corta): NO arranca y dice qué falta (S-02)', async () => {
    await expect(boot('live', false, undefined)).rejects.toThrow(/IDEMPOTENCY_MASK_KEY es obligatoria bajo PAY_MODE=live/);
    await expect(boot('live', false, 'corta')).rejects.toThrow(/IDEMPOTENCY_MASK_KEY inválida/);
  });

  it('PAY_MODE=sandbox con un doble: arranca (los dobles son de sandbox)', async () => {
    const app = await boot('sandbox', true);
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
