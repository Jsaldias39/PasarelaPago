import { containsPan, luhn } from './pan';

/** Números de PRUEBA públicos de cada marca (los que publican los procesadores); ninguno es una tarjeta real. */
const TEST_PANS: [string, string][] = [
  ['Visa 16', '4111111111111111'],
  ['Visa 13', '4222222222222'],
  ['Visa 19', '4000000000000000006'],
  ['Mastercard', '5555555555554444'],
  ['Mastercard serie 2', '2223003122003222'],
  ['Amex', '378282246310005'],
  ['Discover', '6011111111111117'],
  ['JCB', '3530111333300000'],
  ['Diners', '30569309025904'],
  ['UnionPay', '6200000000000005'],
];

describe('containsPan: Luhn + prefijo y largo de una marca de tarjeta', () => {
  it.each(TEST_PANS)('detecta %s, solo, con espacios, con guiones y dentro de una frase', (_name, pan) => {
    expect(luhn(pan)).toBe(true);
    const spaced = pan.replace(/(\d{4})(?=\d)/g, '$1 ');
    const dashed = pan.replace(/(\d{4})(?=\d)/g, '$1-');
    for (const text of [pan, spaced, dashed, `pago de ${pan}.`, `idem-${pan}`, `x ${spaced} y`]) expect({ text, found: containsPan(text) }).toEqual({ text, found: true });
  });

  it('NO confunde con un PAN un timestamp en ms, un id de orden ni un teléfono aunque pasen Luhn por casualidad', () => {
    const luhnOk = (prefix: string, length: number): string => {
      for (let tail = 0; tail < 10_000_000; tail += 1) {
        const candidate = `${prefix}${String(tail).padStart(length - prefix.length, '0')}`;
        if (luhn(candidate)) return candidate;
      }
      throw new Error('sin candidato');
    };
    const samples = [luhnOk('1793120', 13), luhnOk('1793120000', 14), luhnOk('7', 15), luhnOk('9100', 16), luhnOk('1000', 13)];
    for (const sample of samples) {
      expect({ sample, luhn: luhn(sample) }).toEqual({ sample, luhn: true });
      expect({ sample, found: containsPan(sample) }).toEqual({ sample, found: false });
      expect(containsPan(`k-${sample}-1`)).toBe(false);
    }
    for (const text of ['orden 1234567890123', '+591 7 123 4567', 'factura 000123456789', 'k-vault-abc-1', '4111 1111 1111 1112']) expect({ text, found: containsPan(text) }).toEqual({ text, found: false });
  });

  it('un número con la marca bien pero Luhn mal no es un PAN', () => {
    expect(containsPan('4111111111111112')).toBe(false);
    expect(containsPan('5555555555554445')).toBe(false);
  });
});
