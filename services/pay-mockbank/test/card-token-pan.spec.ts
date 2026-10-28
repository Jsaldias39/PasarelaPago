import { ProblemError } from '@pay/problem';
import request from 'supertest';
import { parseCardAuthorization } from '../src/sandbox/dto';
import { asConnectors, chargeRef, createTestApp, type TestApp } from './support/app';

// Hallazgo 14 de docs/trabajo/ola-2/P1/ARNES.md: `parseCardAuthorization` rechazaba (422) cualquier `card_token` con 12 dígitos decimales seguidos,
// y un token de la bóveda (`tok_` + 24 hexadecimales, pay-vault `fake-vault-backend.ts`) los tiene en ≈2 % de los casos.
// La guarda de PAN sigue en pie para todo lo que NO es un token de la bóveda. Tres niveles. Todos los números de tarjeta son de PRUEBA conocidos.

const REFERENCE = 'ch_abcdefghij12';

/** Calcula el dígito de control Luhn y devuelve `prefix` + dígito: un número Luhn válido de `prefix.length + 1` dígitos. */
function luhnComplete(prefix: string): string {
  let sum = 0;
  let double = true;
  for (let i = prefix.length - 1; i >= 0; i -= 1) {
    let d = Number(prefix[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return `${prefix}${(10 - (sum % 10)) % 10}`;
}

function luhnValid(digits: string): boolean {
  return luhnComplete(digits.slice(0, -1)) === digits;
}

/** Cadena de `length` dígitos (13 a 19) sin NINGUNA ventana de 13 a 19 dígitos que pase Luhn: no puede confundirse con un PAN. Búsqueda determinista. */
function noPanWindow(length: number): string {
  for (let seed = 1; ; seed += 1) {
    const candidate = String((BigInt(seed) * 7919n * 104729n * 1299709n) % 10n ** BigInt(length)).padStart(length, '7');
    let any = false;
    for (let size = 13; size <= Math.min(19, length) && !any; size += 1) for (let start = 0; start + size <= length && !any; start += 1) any = luhnValid(candidate.slice(start, start + size));
    if (!any) return candidate;
  }
}

/** Rellena con hexadecimales NO decimales (a–f) hasta los 24 de un token de la bóveda, con la racha de dígitos en `at`. */
function vaultToken(run: string, at: 'start' | 'middle' | 'end'): string {
  const pad = 24 - run.length;
  const filler = 'abcdefabcdefabcdefabcdef';
  const left = at === 'start' ? 0 : at === 'end' ? pad : Math.floor(pad / 2);
  return `tok_${filler.slice(0, left)}${run}${filler.slice(0, pad - left)}`;
}

function accepted(token: unknown): boolean {
  try {
    parseCardAuthorization({ reference: REFERENCE, amount_minor: 100, card_token: token });
    return true;
  } catch (error) {
    if (error instanceof ProblemError) return false;
    throw error;
  }
}

/** PRNG determinista (mulberry32): la muestra de tokens es la misma en cada corrida. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('card_token — nivel correcto: un token de la bóveda (tok_ + 24 hex) nunca se confunde con un PAN', () => {
  it('el token del reproductor del hallazgo 14 (12 dígitos seguidos) se acepta', () => {
    expect(accepted('tok_ab123456789012cdef0123ab')).toBe(true);
  });

  it.each([12, 13, 16, 19, 20, 24])('una racha de %i dígitos decimales dentro de 24 hexadecimales se acepta (al inicio, al medio y al final)', (digits) => {
    for (const at of ['start', 'middle', 'end'] as const) {
      const run = '123456789012345678901234'.slice(0, digits);
      expect([at, accepted(vaultToken(run, at))]).toEqual([at, true]);
    }
  });

  it('también cuando la racha ES un número Luhn válido: la forma tok_ + 24 hex es un identificador opaco, no un PAN', () => {
    expect(accepted(vaultToken(luhnComplete('411111111111111'), 'middle'))).toBe(true); // 16 dígitos Luhn
    expect(accepted('tok_000000000000000000000000')).toBe(true); // 24 ceros: contiene ventanas Luhn válidas
    expect(accepted('tok_411111111111111111111111')).toBe(true); // 24 dígitos
  });

  it('una muestra determinista de 100 000 tokens con la forma de la bóveda se acepta TODA, y la muestra sí cae en la zona del defecto', () => {
    const next = prng(20261028);
    const hex = '0123456789abcdef';
    const OLD_PAN_LIKE = /(?:\d[ -]?){12,19}/; // el regex del código anterior: el control de que la muestra toca el defecto
    let trapped = 0;
    for (let i = 0; i < 100_000; i += 1) {
      let token = 'tok_';
      for (let j = 0; j < 24; j += 1) token += hex[Math.floor(next() * 16)];
      if (OLD_PAN_LIKE.test(token)) trapped += 1;
      if (!accepted(token)) throw new Error(`rechazó un token legítimo: ${token}`);
    }
    expect(trapped).toBeGreaterThan(1_000); // ≈2 % de 100 000
  });
});

describe('card_token — nivel límite', () => {
  it('fuera de la forma de la bóveda, 11 y 12 dígitos seguidos no son un PAN (13 a 19 es el rango): se aceptan', () => {
    expect(accepted(`tok_prueba${'1'.repeat(11)}`)).toBe(true);
    expect(accepted('tok_prueba123456789012')).toBe(true); // 12 dígitos
  });

  it('13 y 19 dígitos: sin ventana Luhn válida se acepta; con ella se rechaza', () => {
    expect(accepted(`tok_prueba${noPanWindow(13)}`)).toBe(true);
    expect(accepted(`tok_prueba${noPanWindow(19)}`)).toBe(true);
    expect(accepted(`tok_prueba${luhnComplete('422222222222')}`)).toBe(false); // 13 dígitos, Visa de prueba
    expect(accepted(`tok_prueba${luhnComplete('411111111111111111')}`)).toBe(false); // 19 dígitos
  });

  it('20 dígitos: se rechaza si CONTIENE una ventana de 13 a 19 que pase Luhn (un PAN con basura pegada, o ceros)', () => {
    expect(accepted(`tok_prueba${luhnComplete('411111111111111')}9999`)).toBe(false); // PAN de 16 + 4 dígitos
    expect(accepted(`tok_prueba${'0'.repeat(20)}`)).toBe(false); // cualquier ventana de ceros pasa Luhn
  });

  it('la excepción es EXACTA: 23 o 25 hexadecimales, mayúsculas o sin el prefijo tok_ ya no son un token de la bóveda y se evalúan como cualquier otro valor', () => {
    const pan = luhnComplete('411111111111111'); // 16 dígitos Luhn
    expect(accepted(`tok_${pan}aaaaaaa`)).toBe(false); // 23
    expect(accepted(`tok_${pan}aaaaaaaaa`)).toBe(false); // 25
    expect(accepted(`tok_${pan}AAAAAAAA`)).toBe(false); // 24 con mayúsculas
    expect(accepted(`${pan}aaaaaaaa`)).toBe(false); // sin el prefijo
  });

  it('el patrón de la forma del token se mantiene: 7 caracteres, 65 caracteres y símbolos se rechazan', () => {
    expect(accepted('tok_abcdefg')).toBe(false); // 7 después del prefijo
    expect(accepted(`tok_${'a'.repeat(65)}`)).toBe(false);
    expect(accepted('tok_abc-defghijk')).toBe(false);
    expect(accepted('tok_abc defghijk')).toBe(false);
  });
});

describe('card_token — nivel inválido: un PAN real sigue dando 422, sin repetirlo', () => {
  const PANS = ['4111111111111111', '5555555555554444', '378282246310005', '4222222222222', '4111111111111111110'];

  it('un PAN solo, con espacios o con guiones, o con el prefijo tok_ ⇒ se rechaza', () => {
    for (const pan of PANS) {
      expect([pan, accepted(pan)]).toEqual([pan, false]);
      expect([`tok_${pan}`, accepted(`tok_${pan}`)]).toEqual([`tok_${pan}`, false]);
      expect([`tok_x${pan}`, accepted(`tok_x${pan}`)]).toEqual([`tok_x${pan}`, false]);
      expect([`tok_prueba${pan}z`, accepted(`tok_prueba${pan}z`)]).toEqual([`tok_prueba${pan}z`, false]);
    }
    for (const spaced of ['4111 1111 1111 1111', '4111-1111-1111-1111', 'tok_4111 1111 1111 1111', 'tok_4111-1111-1111-1111']) expect([spaced, accepted(spaced)]).toEqual([spaced, false]);
  });

  it('un valor que no es texto o es un token mal formado ⇒ se rechaza', () => {
    for (const bad of [undefined, null, 4111111111111111, 5, '', 'tok_', 'tok_corto', {}, ['tok_prueba0001']]) expect([String(bad), accepted(bad)]).toEqual([String(bad), false]);
  });

  describe('por HTTP, contra el servicio real', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(async () => t.close());
    const authorize = (body: Record<string, unknown>) => request(t.app.getHttpServer()).post('/sandbox/card-authorizations').set(asConnectors).send(body);
    const authCount = async () => (await t.db.pool.query('SELECT count(*)::int AS n FROM mb_card_auths')).rows[0].n as number;

    it('el token del hallazgo 14 se autoriza (201) y queda UNA autorización', async () => {
      const reference = chargeRef();
      const response = await authorize({ reference, amount_minor: 10_000, card_token: 'tok_ab123456789012cdef0123ab' });
      expect(response.status).toBe(201);
      expect(await authCount()).toBe(1);
    });

    it('un PAN en card_token ⇒ 422 que NO lo repite, y no se crea ninguna autorización', async () => {
      const before = await authCount();
      for (const token of ['4111111111111111', '4111 1111 1111 1111', 'tok_4111111111111111', 'tok_prueba4111111111111111', 'tok_5555555555554444']) {
        const response = await authorize({ reference: chargeRef(), amount_minor: 10_000, card_token: token });
        expect([token, response.status]).toEqual([token, 422]);
        const text = JSON.stringify(response.body);
        expect(text).not.toContain('4111');
        expect(text).not.toContain('5555');
      }
      expect(await authCount()).toBe(before);
    });

    it('un PAN en OTRO campo de la autorización (referencia o campo no declarado) ⇒ 422 sin efecto', async () => {
      const before = await authCount();
      for (const body of [
        { reference: '4111111111111111', amount_minor: 100, card_token: 'tok_prueba0001' },
        { reference: chargeRef(), amount_minor: 100, card_token: 'tok_prueba0001', pan: '4111111111111111' },
        { reference: chargeRef(), amount_minor: 100, card_token: 'tok_prueba0001', cardholder: '4111 1111 1111 1111' },
      ]) {
        const response = await authorize(body);
        expect(response.status).toBe(422);
        expect(JSON.stringify(response.body)).not.toContain('4111');
      }
      expect(await authCount()).toBe(before);
    });
  });
});
