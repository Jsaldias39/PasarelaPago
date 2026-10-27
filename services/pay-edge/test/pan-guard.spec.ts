import { containsCardNumber } from '../src/proxy/pan-guard';
import { startEdge, type EdgeHarness } from './harness';

/** Defensa en profundidad PCI: ningún número de tarjeta atraviesa el borde. Los números son los de PRUEBA públicos de las marcas. */
const b = (text: string) => Buffer.from(text, 'utf8');

describe('containsCardNumber (función pura)', () => {
  it.each([
    '4111111111111111', // Visa de prueba
    '5500000000000004', // Mastercard de prueba
    '340000000000009', // Amex de prueba (15)
    '4111 1111 1111 1111',
    '4111-1111-1111-1111',
    '6011000000000004',
    '3530111333300000', // JCB de prueba
    '4222222222222', // Visa de 13 dígitos
    '4000056655665556',
  ])('detecta %s dentro de JSON', (pan) => {
    expect(containsCardNumber(b(`{"card":{"number":"${pan}","exp":"12/30"}}`))).toBe(true);
    expect(containsCardNumber(b(`{"note":"pagar con ${pan} gracias"}`))).toBe(true);
  });

  it.each([
    '{"amount_minor":10000,"currency":"BOB"}',
    '{"amount_minor":9007199254740991}', // 16 dígitos, no Luhn
    '{"card_token":"tok_c92215200m49abcdef"}',
    '{"ref":"1234567890123456"}', // 16 dígitos sin Luhn
    '{"phone":"71234567"}',
    '{"n":4111111111111112}', // un dígito cambiado: no Luhn
    '{"ts":"2026-10-27T15:00:00.000Z"}',
    '{"a":"123456789012"}', // 12 dígitos: debajo del mínimo
    '{"a":"41111111111111111111"}', // 20 dígitos: arriba del máximo
    '',
  ])('no confunde %s', (body) => {
    expect(containsCardNumber(b(body))).toBe(false);
  });

  it('no tarda en un cuerpo grande de dígitos (sin retroceso catastrófico)', () => {
    const started = Date.now();
    expect(containsCardNumber(b('9'.repeat(900_000)))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('pay-edge rechaza el PAN', () => {
  let h: EdgeHarness;
  beforeAll(async () => {
    h = await startEdge();
  });
  afterAll(async () => h.stop());

  it('un cuerpo con un PAN da 422 card_number_detected, NO llega al servicio y la respuesta no repite el número', async () => {
    const k = await h.seedKey();
    const res = await h
      .http()
      .post('/v1/payment_intents')
      .set('Authorization', `Bearer ${k.token}`)
      .set('Idempotency-Key', 'clave-de-idempotencia-0001')
      .set('Content-Type', 'application/json')
      .send('{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","number":"4111111111111111"}}');
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'body', code: 'card_number_detected', message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain('4111');
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
  });

  it('un cobro con card_token pasa', async () => {
    const k = await h.seedKey();
    const res = await h
      .http()
      .post('/v1/payment_intents')
      .set('Authorization', `Bearer ${k.token}`)
      .set('Idempotency-Key', 'clave-de-idempotencia-0002')
      .set('Content-Type', 'application/json')
      .send('{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","card_token":"tok_c92215200m49abcdef"}}');
    expect(res.status).toBe(201);
  });
});
