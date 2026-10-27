import { loadScheduleSettings } from '../src/settings';

const BASE = { PAY_MODE: 'sandbox', LEDGER_URL: 'http://ledger:3000', RETRY_DELAYS_SECONDS: '60,120' };

describe('configuración de pay-schedules: la política de reintentos y el libro mayor NO tienen valor por defecto', () => {
  it('correcto: lee la política y fija solo parámetros operativos por defecto', () => {
    expect(loadScheduleSettings(BASE)).toMatchObject({ ledgerUrl: 'http://ledger:3000', retryDelaysSeconds: [60, 120], ledgerTimeoutMs: 3000, holdExpiresSeconds: 3600, leaseSeconds: 120, backgroundJobsEnabled: true });
    expect(loadScheduleSettings(BASE).platformMerchantId).toBeUndefined();
    expect(loadScheduleSettings(BASE).mandateMaxAmountMinor).toBeUndefined(); // sin tope inventado
  });

  it.each(['LEDGER_URL', 'RETRY_DELAYS_SECONDS'])('falta %s ⇒ no arranca', (name) => {
    const env: Record<string, string | undefined> = { ...BASE };
    delete env[name];
    expect(() => loadScheduleSettings(env)).toThrow(name);
    expect(() => loadScheduleSettings({ ...env, [name]: '' })).toThrow(name);
  });

  it.each([['60,'], ['a'], ['0'], ['-5'], ['1.5'], ['60 120'], [Array(11).fill('60').join(',')], [`${31 * 86400}`]])('política %p inválida ⇒ no arranca', (raw) => {
    expect(() => loadScheduleSettings({ ...BASE, RETRY_DELAYS_SECONDS: raw })).toThrow(/RETRY_DELAYS_SECONDS/);
  });

  it('límite: una sola espera y diez esperas valen; 30 días exactos valen', () => {
    expect(loadScheduleSettings({ ...BASE, RETRY_DELAYS_SECONDS: '1' }).retryDelaysSeconds).toEqual([1]);
    expect(loadScheduleSettings({ ...BASE, RETRY_DELAYS_SECONDS: Array(10).fill('60').join(',') }).retryDelaysSeconds).toHaveLength(10);
    expect(loadScheduleSettings({ ...BASE, RETRY_DELAYS_SECONDS: `${30 * 86400}` }).retryDelaysSeconds).toEqual([2592000]);
  });

  it('el comercio de plataforma y el tope, si se dan, tienen que ser válidos', () => {
    expect(loadScheduleSettings({ ...BASE, PLATFORM_MERCHANT_ID: 'mc_abcdefghij12', MANDATE_MAX_AMOUNT_MINOR: '500000' })).toMatchObject({ platformMerchantId: 'mc_abcdefghij12', mandateMaxAmountMinor: 500000 });
    expect(() => loadScheduleSettings({ ...BASE, PLATFORM_MERCHANT_ID: 'platform' })).toThrow(/PLATFORM_MERCHANT_ID/);
    for (const bad of ['0', '-1', '1.5', 'x', '99999999999999999']) expect(() => loadScheduleSettings({ ...BASE, MANDATE_MAX_AMOUNT_MINOR: bad })).toThrow(/MANDATE_MAX_AMOUNT_MINOR/);
  });

  it('la URL del libro mayor debe ser http(s); los tiempos tienen rango', () => {
    expect(() => loadScheduleSettings({ ...BASE, LEDGER_URL: 'ledger:3000' })).toThrow(/LEDGER_URL/);
    for (const [name, bad] of [['LEDGER_TIMEOUT_MS', '0'], ['HOLD_EXPIRES_SECONDS', '59'], ['LEASE_SECONDS', '0'], ['RUN_INTERVAL_SECONDS', 'x']]) expect(() => loadScheduleSettings({ ...BASE, [name]: bad })).toThrow(name);
  });

  describe('PAY_MODE y guardias de despliegue (explícito, sin valor por defecto; live no arranca con interruptores de prueba)', () => {
    it('PAY_MODE es obligatorio y solo admite sandbox | live', () => {
      const env: Record<string, string | undefined> = { ...BASE };
      delete env.PAY_MODE;
      expect(() => loadScheduleSettings(env)).toThrow(/PAY_MODE/);
      expect(() => loadScheduleSettings({ ...BASE, PAY_MODE: '' })).toThrow(/PAY_MODE/);
      for (const bad of ['test', 'SANDBOX', 'prod', 'sandbox ']) expect(() => loadScheduleSettings({ ...BASE, PAY_MODE: bad })).toThrow(/PAY_MODE inválido/);
      expect(loadScheduleSettings(BASE).payMode).toBe('sandbox');
    });

    it('LIVE arranca con la configuración real (pay-schedules no embebe ningún doble) y se niega con DISABLE_BACKGROUND_JOBS=1', () => {
      expect(loadScheduleSettings({ ...BASE, PAY_MODE: 'live' })).toMatchObject({ payMode: 'live', backgroundJobsEnabled: true });
      expect(() => loadScheduleSettings({ ...BASE, PAY_MODE: 'live', DISABLE_BACKGROUND_JOBS: '1' })).toThrow(/DISABLE_BACKGROUND_JOBS/);
      expect(loadScheduleSettings({ ...BASE, DISABLE_BACKGROUND_JOBS: '1' }).backgroundJobsEnabled).toBe(false); // en sandbox sí vale
    });
  });
});
