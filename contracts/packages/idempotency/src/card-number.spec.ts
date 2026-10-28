import { join } from 'node:path';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { ProblemError } from '@pay/problem';
import { containsCardNumber } from './card-number';
import { hashRequest, IdempotencyStore } from './index';

/** Números de PRUEBA públicos de las marcas (pasan Luhn); ninguno es de una tarjeta real. */
const VISA = '4111111111111111'; // 16
const VISA13 = '4222222222222'; // 13 exactos
const AMEX = '378282246310005'; // 15
const PAN19 = '6759649826438453005'; // 19 exactos (Maestro de prueba)
const hash = hashRequest({ method: 'POST', path: '/v1/payment_intents', body: { amount_minor: 10000 } });
/** Escribe los dígitos de `digits` en otra escritura decimal (ancho completo, árabe-índicos, devanagari, matemáticos): `zero` es el código del «0» de esa serie. */
const inScript = (digits: string, zero: number) => [...digits].map((d) => String.fromCodePoint(zero + Number(d))).join('');
const chars = (...codes: number[]) => String.fromCodePoint(...codes);
const groups = (digits: string, separator: string) => {
  const points = [...digits];
  return Array.from({ length: Math.ceil(points.length / 4) }, (_, i) => points.slice(i * 4, i * 4 + 4).join('')).join(separator);
};

describe('containsCardNumber — nivel CORRECTO: lo legítimo pasa', () => {
  it.each([
    ['UUID', '3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10'],
    ['ULID', '01J9Z3K8M2Q7R5T6V4W8X0Y1ZA'],
    ['clave legible con letras', 'cobro-mesa-12-2026-10-28'],
    ['clave con letras que rodean dígitos', 'orden-A1234-B5678'],
    ['número corto (teléfono, NIT)', '71234567'],
    ['13 dígitos que NO pasan Luhn', '4222222222223'],
    ['16 dígitos sin ninguna ventana Luhn', '1000000000007919'],
    ['timestamp con prefijo de texto', 'ts-1793147228790'],
    ['vacío', ''],
  ])('no marca: %s', (_name, text) => {
    expect(containsCardNumber(text)).toBe(false);
  });
});

describe('containsCardNumber — nivel LÍMITE: el PAN no se esconde', () => {
  it.each([
    ['PAN pelado', VISA],
    ['13 dígitos exactos', VISA13],
    ['15 dígitos (Amex)', AMEX],
    ['19 dígitos exactos', PAN19],
    ['con espacios', '4111 1111 1111 1111'],
    ['con guiones', '4111-1111-1111-1111'],
    ['con guiones bajos, puntos y barras mezclados', '4111_1111.1111/1111'],
    ['con prefijo de texto', `orden-${VISA}`],
    ['con sufijo de texto', `${VISA}-reintento`],
    ['pegado a dígitos ANTES', `12${VISA}`],
    ['pegado a dígitos DESPUÉS', `${VISA}7`],
    ['rodeado de dígitos por los dos lados', `99${VISA}77`],
    ['con dígitos antes y después separados por guion', `12-${VISA}-77`],
  ])('detecta: %s', (_name, text) => {
    expect(containsCardNumber(text)).toBe(true);
  });

  it.each(['+', ':', ';', '|', ',', '*', '#', '~', '=', '!', '?', '@', '%', '&', '(', ')', '[', ']', '{', '}', '<', '>', '^', '\\', '"', "'", '`', '$'])('detecta el PAN partido por el separador %s', (sep) => {
    expect(containsCardNumber(groups(VISA, sep))).toBe(true);
    expect(containsCardNumber(`k${groups(VISA, sep)}z`)).toBe(true);
  });

  it('detecta el PAN partido por separadores MEZCLADOS y por corridas largas de separadores', () => {
    expect(containsCardNumber('4111+1111:1111;1111')).toBe(true);
    expect(containsCardNumber('4111 -_ ++ 1111 ;; || 1111 ,, ** 1111')).toBe(true);
    expect(containsCardNumber(`4111${'-'.repeat(500)}1111${' '.repeat(500)}1111${'+'.repeat(500)}1111`)).toBe(true);
  });

  it('detecta separadores de espacio/control raros: tabulador, salto de línea, NBSP, espacio fino, ideográfico, controles', () => {
    for (const sep of ['\t', '\n', '\r', chars(0xa0), chars(0x2009), chars(0x3000), chars(0x1), chars(0x7f), chars(0x2028), chars(0x2022), chars(0x1f4b3)]) {
      expect(containsCardNumber(groups(VISA, sep))).toBe(true);
    }
  });

  it('detecta el PAN escrito con dígitos de otras escrituras: ancho completo, árabe-índicos, devanagari, matemáticos en negrita', () => {
    for (const zero of [0xff10, 0x0660, 0x06f0, 0x0966, 0x1d7ce, 0x1d7d8, 0x2080]) {
      expect(containsCardNumber(inScript(VISA, zero))).toBe(true);
      expect(containsCardNumber(groups(inScript(VISA, zero), '-'))).toBe(true);
    }
    expect(containsCardNumber(`4111${chars(0xff11)}111${chars(0x0661)}111${chars(0x0661)}111`)).toBe(true); // mezcla de escrituras
  });

  it('detecta el PAN con caracteres invisibles (ancho cero, guion suave, marcas de dirección, BOM) entre los dígitos', () => {
    for (const invisible of [0x200b, 0x200c, 0x200d, 0x2060, 0xad, 0xfeff, 0x200e, 0x200f]) expect(containsCardNumber(groups(VISA, chars(invisible)))).toBe(true);
  });

  it('detecta el PAN escapado como lo escribiría un texto (ya decodificado): \\u0034 es el dígito 4', () => {
    expect(containsCardNumber(JSON.parse('"\\u0034111111111111111"') as string)).toBe(true);
  });
});

describe('containsCardNumber — nivel INVÁLIDO: entradas hostiles no revientan y cuestan poco', () => {
  it('no lanza con entradas raras y siempre devuelve boolean', () => {
    for (const text of ['', ' ', '\u0000', chars(0xd800), chars(0xfffe, 0xffff), '-'.repeat(10_000), '\n'.repeat(10_000), chars(0x1f4a9).repeat(5_000)]) {
      expect(typeof containsCardNumber(text)).toBe('boolean');
    }
  });

  it.each([
    ['100 KB de dígitos', '9'.repeat(100_000)],
    ['100 KB de dígitos con separadores', '98'.repeat(25_000).replace(/(.{3})/g, '$1-')],
    ['100 KB de dígitos de otra escritura', chars(0x0669).repeat(100_000)],
    ['100 KB que casi cumplen Luhn', '1'.repeat(100_000)],
    ['100 KB de separadores', '+'.repeat(100_000)],
  ])('%s: termina en menos de 2 s', (_name, text) => {
    const started = Date.now();
    containsCardNumber(text);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('una secuencia de dígitos sin ninguna ventana Luhn de 13 a 19 devuelve false (control del instrumento: hay falsos y verdaderos)', () => {
    const digits = '1'.repeat(40); // ningún tramo de 1 repetidos suma múltiplo de 10 en 13 a 19 dígitos
    expect(containsCardNumber(digits)).toBe(false);
    expect(containsCardNumber(`${digits}${VISA}`)).toBe(true);
  });
});

describe('IdempotencyStore: una Idempotency-Key con forma de PAN no entra a idempotency_keys', () => {
  let db: IsolatedDatabase;
  beforeAll(async () => {
    db = await createIsolatedDatabase([join(__dirname, '../sql/001_idempotency_keys.sql')]);
  });
  afterAll(async () => db.drop());

  const store = () => new IdempotencyStore(db.pool);
  const rows = async () => Number((await db.pool.query('SELECT count(*)::int AS n FROM idempotency_keys')).rows[0].n);

  it('INVÁLIDO: se rechaza con 422 validation_failed/card_number_detected, el manejador NO corre, no se guarda NADA y el error no repite el valor', async () => {
    let ran = false;
    for (const key of [`pedido-${VISA}`, groups(VISA, '+'), groups(VISA, ':'), `99${VISA}77`, inScript(VISA, 0x0660)]) {
      const attempt = store().execute({ scope: 'merchant_A', key, requestHash: hash }, async () => {
        ran = true;
        return { status: 201, body: { ok: true } };
      });
      const error = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProblemError);
      expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
      expect(JSON.stringify((error as ProblemError).toProblem())).not.toContain('4111');
      expect((error as ProblemError).message).not.toContain('4111');
    }
    expect(ran).toBe(false);
    expect(await rows()).toBe(0);
  });

  it('CORRECTO: una clave legítima sigue funcionando y se guarda tal cual', async () => {
    const key = '3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10';
    const result = await store().execute({ scope: 'merchant_A', key, requestHash: hash }, async () => ({ status: 201, body: { ok: true } }));
    expect(result).toMatchObject({ status: 201, replayed: false });
    expect((await db.pool.query('SELECT key FROM idempotency_keys')).rows).toEqual([{ key }]);
  });
});
