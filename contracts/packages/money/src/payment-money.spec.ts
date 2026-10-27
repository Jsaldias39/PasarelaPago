import {
  BOUNDED_DECIMAL_REGEX,
  compareAmounts,
  isPositiveAmount,
  multiplyAmount,
  normalizeAmount,
  percentageOfAmount,
  roundAmount,
  subtractAmounts,
  addAmounts,
} from './payment-money';

describe('payment-money (MCH-017)', () => {
  it('0.10 + 0.20 es exactamente 0.30', () => {
    expect(compareAmounts(addAmounts(['0.10', '0.20']), '0.30')).toBe(0);
  });

  it('la lista vacía suma cero', () => {
    expect(addAmounts([])).toBe('0');
  });

  it('compara por valor entre escalas distintas', () => {
    expect(compareAmounts('0.3', '0.30')).toBe(0);
    expect(compareAmounts('100', '99.999')).toBe(1);
    expect(compareAmounts('1.005', '1.01')).toBe(-1);
  });

  it('distingue una unidad menor en montos que no caben en un doble', () => {
    expect(compareAmounts('90071992547409.92', '90071992547409.91')).toBe(1);
  });

  it('resta exacta, incluso con resultado negativo', () => {
    expect(subtractAmounts('100.00', '40.00')).toBe('60.00');
    expect(subtractAmounts('0.30', '0.31')).toBe('-0.01');
    expect(subtractAmounts('0.30', '-0.10')).toBe('0.40');
  });

  it('sólo son positivos los decimales mayores que cero', () => {
    expect(isPositiveAmount('0.01')).toBe(true);
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('0.00')).toBe(false);
    expect(isPositiveAmount('-1')).toBe(false);
    expect(isPositiveAmount('1e3')).toBe(false);
    expect(isPositiveAmount('abc')).toBe(false);
  });

  describe('producto, porcentaje y redondeo exactos (PAY-01)', () => {
    it('multiplica sin ruido de coma flotante y redondea half-up a 2', () => {
      // Con Number: 1.005 * 100 = 100.49999999999999 -> 100.50 con toFixed; el exacto es 100.50
      expect(multiplyAmount('1.005', '100')).toBe('100.50');
      expect(multiplyAmount('150.00', '6.96')).toBe('1044.00');
      expect(multiplyAmount('0.10', '3')).toBe('0.30');
    });

    it('el .5 se aleja de cero, también en negativos', () => {
      expect(multiplyAmount('0.125', '1')).toBe('0.13');
      expect(multiplyAmount('-0.125', '1')).toBe('-0.13');
    });

    it('calcula el porcentaje exacto', () => {
      expect(percentageOfAmount('0.30', '33.3333')).toBe('0.10');
      expect(percentageOfAmount('150.00', '15.00')).toBe('22.50');
      expect(percentageOfAmount('100', '2.9')).toBe('2.90');
      // 0.07 * 2.5 / 100 = 0.00175 -> 0.00 a 2 decimales y 0.00175 a 5
      expect(percentageOfAmount('0.07', '2.5')).toBe('0.00');
      expect(percentageOfAmount('0.07', '2.5', 5)).toBe('0.00175');
    });

    it('conserva el máximo admisible sin pasar por Number', () => {
      // Number('999999999999999.99').toFixed(2) === '1000000000000000.00'
      expect(roundAmount('999999999999999.99')).toBe('999999999999999.99');
      expect(multiplyAmount('99999999999999.99', '1')).toBe(
        '99999999999999.99',
      );
      expect(addAmounts(['99999999999999.99', '0.01'])).toBe(
        '100000000000000.00',
      );
    });

    it('trabaja con tres y seis decimales', () => {
      expect(roundAmount('1.2345')).toBe('1.23');
      expect(roundAmount('1.235')).toBe('1.24');
      expect(addAmounts(['0.001', '0.002'])).toBe('0.003');
      expect(subtractAmounts('0.300000', '0.200000')).toBe('0.100000');
      expect(normalizeAmount('0.100000')).toBe('0.10');
      expect(normalizeAmount('0.123400')).toBe('0.1234');
      expect(normalizeAmount('5')).toBe('5.00');
      expect(normalizeAmount('-0.300')).toBe('-0.30');
    });

    it('0.30 - 0.20 es exactamente 0.10 (no 0.09999999999999998)', () => {
      expect(normalizeAmount(subtractAmounts('0.30', '0.20'))).toBe('0.10');
      expect(compareAmounts(subtractAmounts('0.30', '0.20'), '0.10')).toBe(0);
    });

    it('rechaza lo que no es decimal', () => {
      expect(() => roundAmount('.5')).toThrow(RangeError);
      expect(() => multiplyAmount('1', 'abc')).toThrow(RangeError);
    });
  });

  describe('BOUNDED_DECIMAL_REGEX', () => {
    it.each(['0', '150.00', '-5.25', '99999999999999.999999', '0.000001'])(
      'acepta %s',
      (value) => expect(BOUNDED_DECIMAL_REGEX.test(value)).toBe(true),
    );
    it.each([
      '.5',
      '5.',
      '1e3',
      '+5',
      '100000000000000',
      '1.1234567',
      '',
      '1,5',
    ])('rechaza %s', (value) =>
      expect(BOUNDED_DECIMAL_REGEX.test(value)).toBe(false),
    );
  });
});
