import { createHash, createHmac, randomUUID } from 'node:crypto';
import { containsCardNumber, generateRequestId, isAcceptableRequestId, resolveRequestId, safeIdempotencyKey } from './card-number';
import { IdempotencyStore } from './index';
import { assertIdempotencyMaskConfig, DEV_MASK_KEY, MASK_KEY_ENV, resolveMaskKey } from './mask-key';

/** Número de PRUEBA público de la marca (pasa Luhn). Sintético. */
const VISA = '4111111111111111';
const KEY_A = 'k'.repeat(32); // 32 bytes exactos
const KEY_B = 'q'.repeat(48);
const live = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PAY_MODE: 'live', ...extra });

/** Dígito de control Luhn para un prefijo. */
function luhnCheckDigit(prefix: string): string {
  let sum = 0;
  [...prefix].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 0) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  });
  return String((10 - (sum % 10)) % 10);
}

describe('S-02 · safeIdempotencyKey enmascara con HMAC y clave de servidor: el PAN no se recupera de lo guardado', () => {
  it('CORRECTO: determinista con la misma clave de servidor, distinto con otra clave, y con forma masked-<64 hex>', () => {
    const env = { PAY_MODE: 'live', [MASK_KEY_ENV]: KEY_A };
    const first = safeIdempotencyKey(`pedido-${VISA}`, env);
    expect(first).toMatch(/^masked-[0-9a-f]{64}$/);
    expect(safeIdempotencyKey(`pedido-${VISA}`, env)).toBe(first);
    expect(safeIdempotencyKey(`pedido-${VISA}`, { ...env, [MASK_KEY_ENV]: KEY_B })).not.toBe(first);
    expect(safeIdempotencyKey(`otro-${VISA}`, env)).not.toBe(first);
    expect(first).toBe(`masked-${createHmac('sha256', KEY_A).update(`pedido-${VISA}`).digest('hex')}`);
  });

  it('CORRECTO: una clave legítima no se toca y no exige la clave de servidor ni bajo live', () => {
    expect(safeIdempotencyKey('3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10', live())).toBe('3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10');
    expect(safeIdempotencyKey('pi_1a72d49b631fe6c9e1824b6b:risk', live())).toBe('pi_1a72d49b631fe6c9e1824b6b:risk');
  });

  it('INVÁLIDO (el ataque): con el valor guardado y SIN la clave no se recupera el PAN; el instrumento sí lo recupera de un SHA-256 sin clave y de un HMAC CON la clave', () => {
    const env = { PAY_MODE: 'live', [MASK_KEY_ENV]: KEY_A };
    // Un PAN de la forma que el atacante enumera: BIN 411111, 9 dígitos de cuenta (los 4 últimos acotados) y control Luhn.
    const pan = (() => {
      const prefix = '411111000001234';
      return prefix + luhnCheckDigit(prefix);
    })();
    expect(containsCardNumber(pan)).toBe(true);
    const stored = safeIdempotencyKey(pan, env);
    // Control del instrumento 1: contra el esquema VIEJO (SHA-256 sin clave) el mismo ataque SÍ recupera el PAN.
    const oldStored = `masked-${createHash('sha256').update(pan).digest('hex')}`;
    const unkeyed = (candidate: string) => createHash('sha256').update(candidate).digest('hex');
    expect(bruteForceFrom('411111000000000', 10_000, oldStored, unkeyed)).toBe(pan);
    // Control del instrumento 2: quien tuviera la clave de servidor sí podría (la clave es EL secreto).
    const keyed = (candidate: string) => createHmac('sha256', KEY_A).update(candidate).digest('hex');
    expect(bruteForceFrom('411111000000000', 10_000, stored, keyed)).toBe(pan);
    // La afirmación: sin la clave (SHA-256 plano, o HMAC con una clave adivinada o la de desarrollo) NO se recupera.
    expect(bruteForceFrom('411111000000000', 10_000, stored, unkeyed)).toBeUndefined();
    expect(bruteForceFrom('411111000000000', 10_000, stored, (c) => createHmac('sha256', DEV_MASK_KEY).update(c).digest('hex'))).toBeUndefined();
    expect(stored).not.toContain(pan.slice(0, 8));
  });

  it('LÍMITE: 32 bytes exactos se aceptan y 31 no; los bytes cuentan en UTF-8 (un carácter de 2 bytes cuenta como 2)', () => {
    expect(() => resolveMaskKey(live({ [MASK_KEY_ENV]: 'k'.repeat(32) }))).not.toThrow();
    expect(() => resolveMaskKey(live({ [MASK_KEY_ENV]: 'k'.repeat(31) }))).toThrow(/mide 31 bytes/);
    expect(() => resolveMaskKey(live({ [MASK_KEY_ENV]: 'ñ'.repeat(16) }))).not.toThrow(); // 16 × 2 bytes = 32
    expect(() => resolveMaskKey(live({ [MASK_KEY_ENV]: 'ñ'.repeat(15) }))).toThrow(/mide 30 bytes/);
  });

  it('LÍMITE: en sandbox o sin PAY_MODE y sin variable se usa la constante de desarrollo DECLARADA (determinista entre procesos); con variable válida manda la variable', () => {
    for (const env of [{}, { PAY_MODE: 'sandbox' }, { PAY_MODE: '' }]) {
      expect(resolveMaskKey(env).toString('utf8')).toBe(DEV_MASK_KEY);
      expect(safeIdempotencyKey(VISA, env)).toBe(`masked-${createHmac('sha256', DEV_MASK_KEY).update(VISA).digest('hex')}`);
    }
    expect(resolveMaskKey({ PAY_MODE: 'sandbox', [MASK_KEY_ENV]: KEY_A }).toString('utf8')).toBe(KEY_A);
    expect(DEV_MASK_KEY.length).toBeGreaterThanOrEqual(32);
  });

  it('INVÁLIDO: bajo live sin la variable, con una corta, con la de desarrollo o con un PAY_MODE mal escrito, falla cerrado (al arrancar y al enmascarar)', () => {
    expect(() => assertIdempotencyMaskConfig(live())).toThrow(/obligatoria bajo PAY_MODE=live/);
    expect(() => assertIdempotencyMaskConfig(live({ [MASK_KEY_ENV]: '' }))).toThrow(/obligatoria/);
    expect(() => assertIdempotencyMaskConfig(live({ [MASK_KEY_ENV]: 'corta' }))).toThrow(/mide 5 bytes/);
    expect(() => assertIdempotencyMaskConfig(live({ [MASK_KEY_ENV]: DEV_MASK_KEY }))).toThrow(/desarrollo/);
    expect(() => assertIdempotencyMaskConfig({ PAY_MODE: 'LIVE' })).toThrow(/obligatoria/); // un typo nunca cae a la constante
    expect(() => assertIdempotencyMaskConfig({ PAY_MODE: 'sandbox', [MASK_KEY_ENV]: 'corta' })).toThrow(/mide 5 bytes/); // la variable, si está, se valida siempre
    // Falla cerrado: NO devuelve el PAN ni un hash sin clave.
    expect(() => safeIdempotencyKey(VISA, live())).toThrow(/obligatoria/);
    // Y el mensaje no repite el valor de la clave.
    expect(() => resolveMaskKey(live({ [MASK_KEY_ENV]: 'secreto-corto' }))).not.toThrow(/secreto-corto/);
  });
});

/**
 * El ataque de S-02: quien lee `idempotency_keys` (o un volcado) conoce el BIN y enumera los candidatos que cumplen Luhn. Acá se acota a 10^4 candidatos (varían 4 dígitos
 * del prefijo de 15; control Luhn calculado) para que la prueba sea rápida; el espacio completo con BIN conocido (~10^9) solo cambia el tiempo, no el resultado.
 */
describe('S-02 · el almacén de idempotencia valida la clave al CONSTRUIRSE (arranque), no en la primera petición con un PAN', () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
  const saved = { mode: process.env.PAY_MODE, key: process.env[MASK_KEY_ENV] };
  afterEach(() => {
    for (const [name, value] of [['PAY_MODE', saved.mode], [MASK_KEY_ENV, saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('INVÁLIDO: bajo live sin clave, con una corta o con la de desarrollo, new IdempotencyStore lanza', () => {
    process.env.PAY_MODE = 'live';
    delete process.env[MASK_KEY_ENV];
    expect(() => new IdempotencyStore(pool)).toThrow(/obligatoria bajo PAY_MODE=live/);
    process.env[MASK_KEY_ENV] = 'corta';
    expect(() => new IdempotencyStore(pool)).toThrow(/mide 5 bytes/);
    process.env[MASK_KEY_ENV] = DEV_MASK_KEY;
    expect(() => new IdempotencyStore(pool)).toThrow(/desarrollo/);
  });

  it('CORRECTO / LÍMITE: live con 32 bytes y sandbox sin clave se construyen', () => {
    process.env.PAY_MODE = 'live';
    process.env[MASK_KEY_ENV] = 'k'.repeat(32);
    expect(() => new IdempotencyStore(pool)).not.toThrow();
    process.env.PAY_MODE = 'sandbox';
    delete process.env[MASK_KEY_ENV];
    expect(() => new IdempotencyStore(pool)).not.toThrow();
  });
});

function bruteForceFrom(start: string, count: number, stored: string, hashOf: (candidate: string) => string): string | undefined {
  for (let n = 0; n < count; n += 1) {
    const prefix = start.slice(0, 11) + String(n).padStart(4, '0');
    const candidate = prefix + luhnCheckDigit(prefix);
    if (`masked-${hashOf(candidate)}` === stored) return candidate;
  }
  return undefined;
}

describe('S-03 · resolveRequestId: un X-Request-Id con forma de PAN se descarta', () => {
  const UUID = '3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10';
  it('CORRECTO: un UUID, un id legible y un id con puntos/guiones bajos se conservan tal cual', () => {
    for (const id of [UUID, 'req_01J9Z3K8M2Q7R5T6V4W8X0Y1ZA', 'cobro.mesa-12_2026', 'abcdefgh']) expect(resolveRequestId(id)).toBe(id);
  });

  it('LÍMITE: 8 y 64 caracteres exactos se conservan; 7 y 65 se reemplazan por un UUID nuevo', () => {
    expect(resolveRequestId('a'.repeat(8))).toBe('a'.repeat(8));
    expect(resolveRequestId('a'.repeat(64))).toBe('a'.repeat(64));
    for (const id of ['a'.repeat(7), 'a'.repeat(65)]) expect(resolveRequestId(id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('INVÁLIDO: con forma de PAN (16 dígitos, con prefijo, con puntos y guiones, 13 y 19 dígitos) se descarta y sale un UUID distinto cada vez', () => {
    for (const id of [VISA, `req-${VISA}`, '4111.1111.1111.1111', '4111-1111-1111-1111', '4222222222222', '6759649826438453005', `${VISA}-trace`]) {
      expect(isAcceptableRequestId(id)).toBe(false);
      const resolved = resolveRequestId(id);
      expect(resolved).not.toContain('4111');
      expect(resolved).toMatch(/^[0-9a-f-]{36}$/);
      expect(resolveRequestId(id)).not.toBe(resolved);
    }
  });

  it('INVÁLIDO: ausente, no-cadena, vacío, con espacio o símbolo se reemplazan', () => {
    for (const id of [undefined, null, 42, ['a'.repeat(10)], '', 'con espacio 12345', 'a'.repeat(10) + '$']) expect(resolveRequestId(id)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('S-03 · consistencia de la cadena: un id GENERADO nunca es rechazado por otro servicio; uno del cliente con corrida PAN-like se descarta siempre', () => {
  // UUID v4 real cuya corrida de dígitos con guiones cumple Luhn por azar (medido por el agente de trazas: ~0,9 % de los UUID v4).
  const LUHN_BY_CHANCE = '0ebff702-5185-4350-8802-cb20d183f879';
  const SAMPLE = 20_000;

  it('CORRECTO: el instrumento — un UUID v4 al azar SÍ es rechazado por el validador en ~1 % de los casos (por eso el id generado se regenera)', () => {
    let rejected = 0;
    for (let i = 0; i < SAMPLE; i += 1) if (!isAcceptableRequestId(randomUUID())) rejected += 1;
    expect(rejected).toBeGreaterThan(SAMPLE * 0.002); // >0,2 %: sin la regeneración habría cientos de inconsistencias
    expect(rejected).toBeLessThan(SAMPLE * 0.03);
    expect(isAcceptableRequestId(LUHN_BY_CHANCE)).toBe(false);
  });

  it('LÍMITE (estadística): 20 000 ids generados por un servicio ⇒ 0 rechazados por el validador compartido (el que usa cada servicio y los clientes internos)', () => {
    let inconsistent = 0;
    for (let i = 0; i < SAMPLE; i += 1) {
      if (!isAcceptableRequestId(generateRequestId())) inconsistent += 1;
      if (!isAcceptableRequestId(resolveRequestId(undefined))) inconsistent += 1;
      if (!isAcceptableRequestId(resolveRequestId(LUHN_BY_CHANCE))) inconsistent += 1; // el cliente mandó uno rechazable ⇒ el reemplazo sí pasa
    }
    expect(inconsistent).toBe(0);
  });

  it('LÍMITE: un id generado conserva la forma de UUID y es distinto cada vez', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateRequestId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('INVÁLIDO: un id del cliente con forma de UUID que CONTIENE un PAN se descarta y se reemplaza (no se exentan los UUID canónicos); el reemplazo es aceptable', () => {
    for (const id of ['41111111-1111-1111-1111-111111111111', LUHN_BY_CHANCE, '4111111111111111', '00000000-4111-1111-1111-111111111111']) {
      expect(isAcceptableRequestId(id)).toBe(false);
      const resolved = resolveRequestId(id);
      expect(resolved).not.toBe(id);
      expect(isAcceptableRequestId(resolved)).toBe(true);
    }
  });
});
