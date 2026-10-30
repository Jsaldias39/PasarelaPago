import { FeeExceedsAmountError, splitFee } from '@pay/money';
import { ProblemError } from '@pay/problem';
import { quoteFee, type ChannelFee } from './quote';

const QR: ChannelFee[] = [{ channel: 'qr', percent: '2.5', fixed_minor: 50 }, { channel: 'card', percent: '3.25', min_minor: 100, cap_minor: 5000 }, { channel: 'bank_transfer', percent: '0' }];

describe('quoteFee (REQ-P3-5): comisión + neto = bruto, con la regla de redondeo única de @pay/money (D-20)', () => {
  it('kill-test del plan: Bs 100,00 con 2,5 % + Bs 0,50 deja 97,00 y 3,00', () => {
    expect(quoteFee(QR, 'qr', 10000)).toEqual({ grossMinor: 10000n, feeMinor: 300n, netMinor: 9700n });
  });

  it('usa la fila del canal del medio de pago, con mínimo y tope', () => {
    expect(quoteFee(QR, 'card', 1000).feeMinor).toBe(100n); // 3,25 % de 10,00 = 0,325 → mínimo 1,00
    expect(quoteFee(QR, 'card', 10_000_000).feeMinor).toBe(5000n); // tope
    expect(quoteFee(QR, 'bank_transfer', 777)).toEqual({ grossMinor: 777n, feeMinor: 0n, netMinor: 777n });
  });

  it('propiedad (30.000 casos con semilla fija): fee + net = amount, 0 ≤ fee ≤ amount, y es idéntico a splitFee directo', () => {
    let seed = 987654321n;
    const next = (limit: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) % limit;
    };
    let rejected = 0;
    for (let i = 0; i < 30_000; i += 1) {
      const amount = Number(next(10n ** 11n)) + 1;
      const decimals = Number(next(7n));
      const scaled = next(100n * 10n ** BigInt(decimals) + 1n);
      const digits = scaled.toString().padStart(decimals + 1, '0');
      const percent = decimals === 0 ? digits : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
      const fixed = Number(next(2000n));
      const min = next(3n) === 0n ? Number(next(500n)) : undefined;
      const cap = next(3n) === 0n ? Number(next(20_000n)) : undefined;
      const row: ChannelFee = { channel: 'qr', percent, fixed_minor: fixed, ...(min !== undefined ? { min_minor: min } : {}), ...(cap !== undefined ? { cap_minor: cap } : {}) };
      let split;
      try {
        split = quoteFee([row], 'qr', amount);
      } catch (error) {
        // El único rechazo admitido: la comisión (con su fijo) no cabe en el importe.
        expect(error).toBeInstanceOf(ProblemError);
        expect((error as ProblemError).code).toBe('fee_exceeds_amount');
        expect(() => splitFee(BigInt(amount), { percent, fixedMinor: BigInt(fixed), ...(min !== undefined ? { minMinor: BigInt(min) } : {}), ...(cap !== undefined ? { capMinor: BigInt(cap) } : {}) })).toThrow(FeeExceedsAmountError);
        rejected += 1;
        continue;
      }
      expect(split.feeMinor + split.netMinor).toBe(BigInt(amount));
      expect(split.feeMinor).toBeGreaterThanOrEqual(0n);
      expect(split.feeMinor).toBeLessThanOrEqual(BigInt(amount));
      expect(split).toEqual(splitFee(BigInt(amount), { percent, fixedMinor: BigInt(fixed), ...(min !== undefined ? { minMinor: BigInt(min) } : {}), ...(cap !== undefined ? { capMinor: BigInt(cap) } : {}) }));
    }
    expect(rejected).toBeLessThan(15_000); // el generador ejercita ambos caminos
    expect(rejected).toBeGreaterThan(0);
  });

  it('un empate exacto de medio centavo queda del lado del comercio (D-20)', () => {
    expect(quoteFee([{ channel: 'qr', percent: '10' }], 'qr', 5)).toEqual({ grossMinor: 5n, feeMinor: 0n, netMinor: 5n });
    expect(quoteFee([{ channel: 'qr', percent: '10' }], 'qr', 15)).toEqual({ grossMinor: 15n, feeMinor: 1n, netMinor: 14n });
  });

  it('inválidos: sin tarifa para el medio → 422 fee_schedule_missing; el fijo supera el importe → 422 fee_exceeds_amount; porcentaje corrupto → no cotiza', () => {
    expect(() => quoteFee(QR, 'wallet', 100)).toThrow(expect.objectContaining({ code: 'validation_failed' }));
    expect(() => quoteFee([{ channel: 'qr', percent: '0', fixed_minor: 100 }], 'qr', 99)).toThrow(expect.objectContaining({ code: 'fee_exceeds_amount' }));
    expect(() => quoteFee([{ channel: 'qr', percent: '101' }], 'qr', 100)).toThrow(RangeError);
    expect(() => quoteFee([{ channel: 'qr', percent: 'abc' }], 'qr', 100)).toThrow(RangeError);
  });
});
