import { redactPan } from '../src/redact';

describe('redactPan: un número de tarjeta que el cliente pone por error en una URL no se repite ni se loguea', () => {
  it.each([
    ['/tokens/4111111111111111', '/tokens/[redacted]'],
    ['/tokens/4111 1111 1111 1111/x', '/tokens/[redacted]/x'],
    ['/payment_intents/4111-1111-1111-1111', '/payment_intents/[redacted]'],
    ['/a/378282246310005', '/a/[redacted]'],
  ])('%s', (input, expected) => expect(redactPan(input)).toBe(expected));

  it('no toca ids normales ni números cortos', () => {
    for (const text of ['/payment_intents/pi_abcdefghij12', '/tokens/tok_0123456789ab', '/x/1234567', '/orden/123456789012']) expect(redactPan(text)).toBe(text);
  });
});

import { containsPan } from '../src/redact';

describe('containsPan (clave de idempotencia y X-Request-Id): prefijo y largo de una marca + Luhn', () => {
  it.each(['4111111111111111', '5555555555554444', '378282246310005', '6011111111111117', '2223003122003222', '3530111333300000', '4111 1111 1111 1111', 'idem-4111-1111-1111-1111'])('detecta %s', (text) => {
    expect(containsPan(text)).toBe(true);
  });

  it('no confunde un timestamp en ms (las claves de idempotencia típicas) ni un id de orden', () => {
    for (const text of ['k-vault-1793120000000-1', '1793120000009', 'orden 1234567890123', 'k-vault-abc-1', '4111111111111112']) expect({ text, found: containsPan(text) }).toEqual({ text, found: false });
  });
});
