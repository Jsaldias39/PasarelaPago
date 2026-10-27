import {
  FeeExceedsAmountError,
  fromMinor,
  splitFee,
  toMinor,
  toSafeNumber,
} from './minor';

describe('minor (D-07, D-20)', () => {
  it('toMinor y fromMinor son inversas', () => {
    expect(toMinor('97.50')).toBe(9750n);
    expect(toMinor('97.5')).toBe(9750n);
    expect(toMinor('0.01')).toBe(1n);
    expect(toMinor('100')).toBe(10000n);
    expect(fromMinor(9750n)).toBe('97.50');
    expect(fromMinor(1n)).toBe('0.01');
    expect(fromMinor(0n)).toBe('0.00');
  });

  it.each(['', '-1', '1.234', '1e3', 'abc', '.5', '5.'])('toMinor rechaza %p', (value) => {
    expect(() => toMinor(value)).toThrow(RangeError);
  });

  it('toSafeNumber solo acepta enteros seguros', () => {
    expect(toSafeNumber(9750n)).toBe(9750);
    expect(() => toSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
  });

  describe('splitFee', () => {
    it('kill-test del plan: Bs 100,00 con 2,5 % + Bs 0,50 deja 97,00 y 3,00', () => {
      const split = splitFee(toMinor('100.00'), { percent: '2.5', fixedMinor: 50n });
      expect(fromMinor(split.feeMinor)).toBe('3.00');
      expect(fromMinor(split.netMinor)).toBe('97.00');
    });

    it('un empate exacto de medio centavo queda del lado del comercio (D-20)', () => {
      // 5 centavos al 10 % → comisión exacta 0,5 centavo → el neto exacto 4,5 sube a 5.
      expect(splitFee(5n, { percent: '10' })).toEqual({ grossMinor: 5n, feeMinor: 0n, netMinor: 5n });
      // 15 centavos al 10 % → comisión 1,5 → neto 13,5 sube a 14 → comisión 1.
      expect(splitFee(15n, { percent: '10' })).toEqual({ grossMinor: 15n, feeMinor: 1n, netMinor: 14n });
    });

    it('sin tarifa no hay comisión', () => {
      expect(splitFee(12345n, { percent: '0' })).toEqual({ grossMinor: 12345n, feeMinor: 0n, netMinor: 12345n });
    });

    it('aplica mínimo y tope antes de redondear', () => {
      expect(splitFee(1000n, { percent: '1', minMinor: 50n }).feeMinor).toBe(50n);
      expect(splitFee(1000000n, { percent: '5', capMinor: 2000n }).feeMinor).toBe(2000n);
    });

    it('el fijo solo puede igualar el importe, no superarlo', () => {
      expect(splitFee(50n, { percent: '0', fixedMinor: 50n })).toEqual({ grossMinor: 50n, feeMinor: 50n, netMinor: 0n });
      expect(() => splitFee(49n, { percent: '0', fixedMinor: 50n })).toThrow(FeeExceedsAmountError);
    });

    it('admite hasta 6 decimales de porcentaje y exactamente 100 %', () => {
      expect(splitFee(100000n, { percent: '2.345678' }).feeMinor).toBe(2346n);
      expect(splitFee(777n, { percent: '100' })).toEqual({ grossMinor: 777n, feeMinor: 777n, netMinor: 0n });
    });

    it.each(['', '-1', '100.000001', '101', '1e2', 'x', '1.1234567'])('rechaza el porcentaje %p', (percent) => {
      expect(() => splitFee(100n, { percent })).toThrow(RangeError);
    });

    it('rechaza un importe negativo', () => {
      expect(() => splitFee(-1n, { percent: '1' })).toThrow(RangeError);
    });

    it('propiedad (20.000 casos con semilla fija): comisión + neto = bruto, 0 ≤ comisión ≤ bruto y el error es ≤ medio centavo', () => {
      let seed = 123456789n;
      const next = (limit: bigint): bigint => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return (seed >> 11n) % limit;
      };
      for (let i = 0; i < 20000; i += 1) {
        const gross = next(10n ** 12n);
        const decimals = Number(next(7n));
        const percentScaled = next(100n * 10n ** BigInt(decimals) + 1n);
        const digits = percentScaled.toString().padStart(decimals + 1, '0');
        const percent = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
        const fixed = next(1000n);
        const scale = 10n ** BigInt(decimals + 2);
        const exact = gross * percentScaled + (fixed < gross ? fixed : 0n) * scale;
        const rule = { percent, fixedMinor: fixed < gross ? fixed : 0n };
        if (exact > gross * scale) {
          // Porcentaje + fijo superan el bruto: el rechazo tiene que estar justificado.
          expect(() => splitFee(gross, rule)).toThrow(FeeExceedsAmountError);
          continue;
        }
        const split = splitFee(gross, rule);
        expect(split.feeMinor + split.netMinor).toBe(gross);
        expect(split.feeMinor).toBeGreaterThanOrEqual(0n);
        expect(split.feeMinor).toBeLessThanOrEqual(gross);
        const diff = split.feeMinor * scale - exact;
        expect((diff < 0n ? -diff : diff) * 2n).toBeLessThanOrEqual(scale);
      }
    });
  });
});
