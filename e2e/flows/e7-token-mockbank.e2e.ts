import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * REGRESIÓN del hallazgo 14 (corregido en pay-mockbank, ola 3, P4; era un reproductor en pending/) — de docs/trabajo/ola-2/P1/ARNES.md. `pay-mockbank` rechaza (422) un `card_token` legítimo de la bóveda.
 *
 * `services/pay-mockbank/src/sandbox/dto.ts` (`parseCardAuthorization`) trata como «con forma de PAN» cualquier `card_token` que contenga 12 dígitos decimales seguidos
 * (`PAN_LIKE = /(?:\d[ -]?){12,19}/`, sin anclar). Un token de la bóveda es `tok_` + 24 hexadecimales: el 1,99 % tiene esa racha (3981 de 200000 medidos, evidencia/e7-hallazgo-token-mockbank.txt),
 * así que ≈2 de cada 100 autorizaciones de tarjeta legítimas se rechazan. Visto de verdad en la primera corrida de E7 (`pay-mockbank.log`: `POST /sandbox/card-authorizations` → 422).
 * Un token no es un PAN (lleva el prefijo `tok_` y letras): el chequeo debería mirar si el valor ENTERO es un PAN, no si contiene una racha de dígitos.
 */
describe('hallazgo 14 pendiente — pay-mockbank acepta un token legítimo con una racha de 12 dígitos', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, only: ['pay-qr', 'pay-mockbank'] });
  }, 300_000);
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('autoriza una tarjeta con card_token tok_ab123456789012cdef0123ab', async () => {
    const res = await stack.callAs('pay-connectors', 'pay-mockbank', 'POST', '/sandbox/card-authorizations', { payMode: 'test', json: { reference: 'ch_e7token00000000000001', amount_minor: 10_000, card_token: 'tok_ab123456789012cdef0123ab' } });
    expect(res.status).toBe(201); // FALLA HOY: 422
  });
});
