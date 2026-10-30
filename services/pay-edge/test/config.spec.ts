import { loadConfig, UPSTREAMS } from '../src/config';

/**
 * P1.H5.M5 (en pequeño) — guardia de modo del borde (D-26): `PAY_MODE` explícito, sin valor por defecto, y `live` no admite
 * restos de sandbox. Función pura: cada caso es un entorno distinto.
 */
const upstreams = Object.fromEntries(UPSTREAMS.map((name) => [`UPSTREAM_${name.toUpperCase().replace(/-/g, '_')}_URL`, `http://${name}.internal:3000`]));
// Bajo live son obligatorios, además, TRUST_PROXY_HOPS (S-06) e IDEMPOTENCY_MASK_KEY de 32 bytes o más (S-02): el `base` los declara para que cada caso de abajo pruebe UNA sola guardia.
const base = {
  DB_HOST: 'db', DB_NAME: 'pay_edge', DB_USER: 'u', DB_PASSWORD: 'p', REDIS_URL: 'redis://r:6379', NATS_URL: 'nats://n:4222', PAY_MODE: 'live',
  TRUST_PROXY_HOPS: '1', IDEMPOTENCY_MASK_KEY: 'k'.repeat(32), ...upstreams,
};

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

describe('pay-edge — S-06: TRUST_PROXY_HOPS obligatorio y explícito bajo live', () => {
  it('CORRECTO: declarado (1 salto, o 0 = sin proxy) ⇒ arranca y el valor llega a la configuración', () => {
    expect(loadConfig(base).trustProxyHops).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
  });

  it('LÍMITE: en sandbox sigue sin ser obligatorio (0 por defecto) y los extremos 0 y 10 se aceptan', () => {
    const env: NodeJS.ProcessEnv = { ...base, PAY_MODE: 'sandbox' };
    delete env.TRUST_PROXY_HOPS;
    expect(loadConfig(env).trustProxyHops).toBe(0);
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '10' }).trustProxyHops).toBe(10);
  });

  it.each([
    ['ausente', undefined],
    ['vacío', ''],
  ])('INVÁLIDO: %s bajo live ⇒ no arranca y nombra la variable (sin valor por defecto silencioso)', (_name, value) => {
    const env: NodeJS.ProcessEnv = { ...base };
    if (value === undefined) delete env.TRUST_PROXY_HOPS;
    else env.TRUST_PROXY_HOPS = value;
    expect(() => loadConfig(env)).toThrow(/PAY_MODE=live exige TRUST_PROXY_HOPS/);
  });

  it.each(['-1', '11', 'dos', '1.5'])('INVÁLIDO: %s ⇒ no arranca (rango 0 a 10, entero)', (value) => {
    expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS inválido/);
  });
});

describe('pay-edge — S-02: IDEMPOTENCY_MASK_KEY validada al arrancar', () => {
  it('CORRECTO: live con una clave de 32 bytes arranca; sandbox sin clave arranca (constante de desarrollo declarada)', () => {
    expect(() => loadConfig(base)).not.toThrow();
    const env: NodeJS.ProcessEnv = { ...base, PAY_MODE: 'sandbox' };
    delete env.IDEMPOTENCY_MASK_KEY;
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('LÍMITE: 31 bytes ⇒ no arranca (en cualquier modo); 32 sí', () => {
    expect(() => loadConfig({ ...base, IDEMPOTENCY_MASK_KEY: 'k'.repeat(31) })).toThrow(/IDEMPOTENCY_MASK_KEY inválida/);
    expect(() => loadConfig({ ...base, PAY_MODE: 'sandbox', IDEMPOTENCY_MASK_KEY: 'k'.repeat(31) })).toThrow(/IDEMPOTENCY_MASK_KEY inválida/);
    expect(() => loadConfig({ ...base, IDEMPOTENCY_MASK_KEY: 'k'.repeat(32) })).not.toThrow();
  });

  it('INVÁLIDO: bajo live sin clave, vacía o la de desarrollo ⇒ no arranca', () => {
    const missing: NodeJS.ProcessEnv = { ...base };
    delete missing.IDEMPOTENCY_MASK_KEY;
    expect(() => loadConfig(missing)).toThrow(/IDEMPOTENCY_MASK_KEY es obligatoria bajo PAY_MODE=live/);
    expect(() => loadConfig({ ...base, IDEMPOTENCY_MASK_KEY: '' })).toThrow(/obligatoria/);
    expect(() => loadConfig({ ...base, IDEMPOTENCY_MASK_KEY: 'dev-only-idempotency-mask-key-sandbox-0123456789' })).toThrow(/desarrollo/);
  });
});
