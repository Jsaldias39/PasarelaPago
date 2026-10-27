import { redactPan } from '../src/redact';

describe('redactPan: un número de tarjeta que el cliente pone por error en una URL no se repite ni se loguea', () => {
  it.each([
    ['/tokens/4111111111111111', '/tokens/[redacted]'],
    ['/tokens/4111 1111 1111 1111/x', '/tokens/[redacted]/x'],
    ['/payment_intents/4111-1111-1111-1111', '/payment_intents/[redacted]'],
    ['/a/378282246310005', '/a/[redacted]'],
  ])('%s', (input, expected) => expect(redactPan(input)).toBe(expected));

  it('no toca ids normales ni números cortos (12 dígitos o menos) ni una corrida de 13 a 19 dígitos sin ninguna subsecuencia con Luhn válido', () => {
    for (const text of ['/payment_intents/pi_abcdefghij12', '/tokens/tok_0123456789ab', '/x/1234567', '/orden/123456789012', '/a/1000000000001']) expect(redactPan(text)).toBe(text);
  });

  it('enmascara una marca desconocida con Luhn válido y un PAN con ceros delante, sin tocar el resto de la ruta', () => {
    expect(redactPan('/tokens/9000000000000001/x')).toBe('/tokens/[redacted]/x');
    expect(redactPan('/t/0004111111111111111/z')).toBe('/t/[redacted]/z');
  });
});
