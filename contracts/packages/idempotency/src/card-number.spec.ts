import { join } from 'node:path';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { ProblemError } from '@pay/problem';
import { containsCardNumber } from './card-number';
import { hashRequest, IdempotencyStore } from './index';

/** Números de PRUEBA públicos de las marcas (pasan Luhn); ninguno es de una tarjeta real. */
const VISA = '4111111111111111';
const AMEX = '378282246310005';
const hash = hashRequest({ method: 'POST', path: '/v1/payment_intents', body: { amount_minor: 10000 } });

describe('containsCardNumber', () => {
  it.each([
    ['PAN pelado', VISA],
    ['PAN con espacios', '4111 1111 1111 1111'],
    ['PAN con guiones', '4111-1111-1111-1111'],
    ['PAN con guiones bajos, puntos y barras mezclados', '4111_1111.1111/1111'],
    ['PAN con prefijo de texto', `orden-${VISA}`],
    ['PAN con sufijo de texto', `${VISA}-reintento`],
    ['PAN American Express (15 dígitos)', AMEX],
    ['PAN pegado a otros dígitos', `12${VISA}7`],
    ['PAN en dígitos de ancho completo', '４１１１１１１１１１１１１１１１'],
    ['PAN con caracteres invisibles entre los dígitos', '4111\u200B1111\u200B1111\u200B1111'],
  ])('LÍMITE \u2014 detecta: %s', (_name, text) => {
    expect(containsCardNumber(text)).toBe(true);
  });

  it.each([
    ['UUID', '3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10'],
    ['clave legible', 'cobro-mesa-12-2026-10-28'],
    ['ULID', '01J9Z3K8M2Q7R5T6V4W8X0Y1ZA'],
    ['número corto (teléfono, NIT)', '71234567'],
    ['13 dígitos que NO pasan Luhn', '4111111111112'],
    ['timestamp en milisegundos con prefijo', 'ts-1793147228790'],
  ])('CORRECTO \u2014 no marca: %s', (_name, text) => {
    expect(containsCardNumber(text)).toBe(false);
  });

  it('INVÁLIDO: entradas raras no lanzan', () => {
    for (const text of ['', ' ', '\u0000', '-'.repeat(10_000), '9'.repeat(100_000)]) expect(() => containsCardNumber(text)).not.toThrow();
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
    const attempt = store().execute({ scope: 'merchant_A', key: `pedido-${VISA}`, requestHash: hash }, async () => {
      ran = true;
      return { status: 201, body: { ok: true } };
    });
    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ code: 'validation_failed', status: 422 });
    expect(JSON.stringify((error as ProblemError).toProblem())).not.toContain('4111');
    expect((error as ProblemError).message).not.toContain('4111');
    expect(ran).toBe(false);
    expect(await rows()).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM idempotency_keys WHERE key LIKE '%4111%'")).rows).toHaveLength(0);
  });

  it('CORRECTO: una clave legítima sigue funcionando y se guarda tal cual', async () => {
    const key = '3f2b8f0e-5a1c-4d7e-9b21-0c6a7e4d8f10';
    const result = await store().execute({ scope: 'merchant_A', key, requestHash: hash }, async () => ({ status: 201, body: { ok: true } }));
    expect(result).toMatchObject({ status: 201, replayed: false });
    expect((await db.pool.query('SELECT key FROM idempotency_keys')).rows).toEqual([{ key }]);
  });
});
