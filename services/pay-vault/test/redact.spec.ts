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
