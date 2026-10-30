import request from 'supertest';
import { looksLikePan } from '../src/sandbox/dto';
import { asAdmin, asConnectors, createTestApp, type TestApp } from './support/app';

// Defensa en profundidad (regla 90.2): un campo libre que el pagador pudo teclear no guarda un número de tarjeta. Tres niveles.
describe('looksLikePan', () => {
  it('correcto: detecta PAN de prueba de las marcas, continuos, con espacios, con guiones y pegados a otro texto', () => {
    for (const pan of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '5555555555554444', '378282246310005', '6011111111111117', 'ref-4111111111111111-x', 'TR4111111111111111']) expect(looksLikePan(pan)).toBe(true);
  });
  it('límite: 13 y 19 dígitos con Luhn válido se detectan; 12 dígitos o 20 sin ventana válida, no', () => {
    expect(looksLikePan('4222222222222')).toBe(true); // 13 dígitos (Visa de prueba)
    expect(looksLikePan('4111111111111111110')).toBe(true); // 19 dígitos, contiene la ventana de 16
    expect(looksLikePan('411111111111')).toBe(false); // 12 dígitos
  });
  it('límite: rechaza DE MÁS, a propósito (como el guardia del borde): una cadena de 16 dígitos con Luhn inválido puede contener una ventana de 13 que sí lo pasa', () => {
    expect(looksLikePan('4111111111111112')).toBe(true);
  });
  it('inválido (falsos positivos que NO deben rechazarse): referencias de transferencia, fechas, importes e ids', () => {
    for (const ok of ['TRABCDEFGHIJ', 'po_ab12cd34:payout:1', '2026-10-28T12:00:00Z', 'ch_abcdefghij12', '1234567890', '123456789012', 'SIM-000123', 'x'.repeat(40)]) expect(looksLikePan(ok)).toBe(false);
  });
});

describe('los campos libres de pay-mockbank rechazan un PAN (422, sin repetirlo)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => t.close());

  it('depósito del pagador, transferencia saliente y línea inyectada con un PAN en la referencia, el destino o la glosa ⇒ 422 sin efecto', async () => {
    const http = () => request(t.app.getHttpServer());
    const bodies: Array<[string, request.Test]> = [
      ['transfer-in', http().post('/sandbox/payer/transfer-in').set(asAdmin).send({ reference: '4111111111111111', amount_minor: 100 })],
      ['transfer-in con espacios', http().post('/sandbox/payer/transfer-in').set(asAdmin).send({ reference: 'TR-4111-1111-1111-1111', amount_minor: 100 })],
      ['transfers: referencia', http().post('/sandbox/transfers').set(asConnectors).send({ reference: '4111 1111 1111 1111', amount_minor: 100, destination_ref: 'dest_1' })],
      ['transfers: destino', http().post('/sandbox/transfers').set(asConnectors).send({ reference: 'po_x:payout:1', amount_minor: 100, destination_ref: '4111111111111111' })],
      ['línea inyectada: glosa', http().post('/sandbox/admin/statement-lines').set(asAdmin).send({ direction: 'credit', amount_minor: 100, booked_at: new Date().toISOString(), description: 'pago 4111 1111 1111 1111' })],
      ['línea inyectada: referencia', http().post('/sandbox/admin/statement-lines').set(asAdmin).send({ direction: 'credit', amount_minor: 100, booked_at: new Date().toISOString(), our_reference: '4111111111111111' })],
    ];
    for (const [name, call] of bodies) {
      const response = await call;
      expect([name, response.status]).toEqual([name, 422]);
      expect(JSON.stringify(response.body)).not.toContain('4111');
    }
    const counts = await t.db.pool.query('SELECT (SELECT count(*) FROM mb_transfers) + (SELECT count(*) FROM mb_statement_extra) AS n');
    expect(counts.rows[0].n).toBe('0');
    // Una referencia legítima sigue pasando.
    expect((await http().post('/sandbox/payer/transfer-in').set(asAdmin).send({ reference: 'TRABCDEFGHIJ', amount_minor: 100 })).status).toBe(201);
  });
});
