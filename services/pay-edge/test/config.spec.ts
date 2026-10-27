import { loadConfig, UPSTREAMS } from '../src/config';

/**
 * P1.H5.M5 (en pequeño) — guardia de modo del borde (D-26): `PAY_MODE` explícito, sin valor por defecto, y `live` no admite
 * restos de sandbox. Función pura: cada caso es un entorno distinto.
 */
const upstreams = Object.fromEntries(UPSTREAMS.map((name) => [`UPSTREAM_${name.toUpperCase().replace(/-/g, '_')}_URL`, `http://${name}.internal:3000`]));
const base = { DB_HOST: 'db', DB_NAME: 'pay_edge', DB_USER: 'u', DB_PASSWORD: 'p', REDIS_URL: 'redis://r:6379', NATS_URL: 'nats://n:4222', PAY_MODE: 'live', ...upstreams };

describe('pay-edge — PAY_MODE explícito', () => {
  it('sandbox y live arrancan con destinos internos', () => {
    expect(loadConfig({ ...base, PAY_MODE: 'sandbox' }).payMode).toBe('sandbox');
    expect(loadConfig(base).payMode).toBe('live');
  });

  it.each([
    ['ausente', undefined],
    ['vacío', ''],
    ['con otro valor', 'prod'],
    ['con otra capitalización', 'LIVE'],
    ['con espacios', ' live'],
  ])('PAY_MODE %s ⇒ no arranca (nunca se asume sandbox ni live)', (_name, value) => {
    const env: NodeJS.ProcessEnv = { ...base };
    if (value === undefined) delete env.PAY_MODE;
    else env.PAY_MODE = value;
    expect(() => loadConfig(env)).toThrow(/PAY_MODE/);
  });
});

describe('pay-edge — PAY_MODE=live no admite dobles ni restos de sandbox', () => {
  it.each(['http://localhost:3003', 'http://127.0.0.1:3003', 'http://127.1.2.3:80', 'http://0.0.0.0:3003', 'http://[::1]:3003', 'http://LOCALHOST:3003'])(
    'un destino en loopback (%s) ⇒ no arranca y nombra la variable',
    (url) => {
      expect(() => loadConfig({ ...base, UPSTREAM_PAY_LEDGER_URL: url })).toThrow(/loopback.*UPSTREAM_PAY_LEDGER_URL/);
    },
  );

  it('los mismos destinos en loopback SÍ se admiten en sandbox (es el modo del arnés)', () => {
    expect(() => loadConfig({ ...base, PAY_MODE: 'sandbox', UPSTREAM_PAY_LEDGER_URL: 'http://127.0.0.1:3003' })).not.toThrow();
  });

  it('un nombre que solo contiene «localhost» pero es de otro dominio no se confunde con un doble', () => {
    expect(() => loadConfig({ ...base, UPSTREAM_PAY_LEDGER_URL: 'http://localhost.pay.example.com:3003' })).not.toThrow();
  });

  it('sin NATS_URL ⇒ no arranca: la réplica no se enteraría de revocaciones ni de cierres', () => {
    const env: NodeJS.ProcessEnv = { ...base };
    delete env.NATS_URL;
    expect(() => loadConfig(env)).toThrow(/NATS_URL/);
    expect(() => loadConfig({ ...env, PAY_MODE: 'sandbox' })).not.toThrow();
  });
});
