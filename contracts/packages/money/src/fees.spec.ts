import { ChannelNotConfiguredError, FeeExceedsAmountError, quoteFee, toFeeRule, validateChannels, type ChannelRule } from './index';

const SCHEDULE: ChannelRule[] = [
  { channel: 'qr', percent: '2.5', fixed_minor: 50 },
  { channel: 'card', percent: '3.25', min_minor: 100, cap_minor: 5000 },
  { channel: 'direct', percent: '0' },
];

describe('quoteFee (D-07, D-20)', () => {
  it('CORRECTO: kill-test del plan, Bs 100,00 al 2,5 % + Bs 0,50 deja 3,00 de comisión y 97,00 de neto', () => {
    expect(quoteFee(SCHEDULE, 'qr', 10000n)).toEqual({ feeMinor: 300n, netMinor: 9700n });
  });

  it('LÍMITE: aplica mínimo y tope antes de redondear; sin tarifa no hay comisión', () => {
    expect(quoteFee(SCHEDULE, 'card', 1000n).feeMinor).toBe(100n); // 3,25 % de 10,00 = 0,325 → mínimo 1,00
    expect(quoteFee(SCHEDULE, 'card', 10_000_000n).feeMinor).toBe(5000n); // tope
    expect(quoteFee(SCHEDULE, 'direct', 12345n)).toEqual({ feeMinor: 0n, netMinor: 12345n });
  });

  it('PROPIEDAD (1.000 casos con semilla fija): comisión + neto = bruto y 0 ≤ comisión ≤ bruto', () => {
    let seed = 99n;
    const next = (limit: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return (seed >> 11n) % limit;
    };
    for (let i = 0; i < 1000; i += 1) {
      const gross = 100n + next(10n ** 10n);
      const q = quoteFee(SCHEDULE, ['qr', 'card', 'direct'][Number(next(3n))], gross);
      expect(q.feeMinor + q.netMinor).toBe(gross);
      expect(q.feeMinor).toBeGreaterThanOrEqual(0n);
      expect(q.feeMinor).toBeLessThanOrEqual(gross);
    }
  });

  it('INVÁLIDO: canal fuera del tarifario y comisión mayor que el importe', () => {
    expect(() => quoteFee(SCHEDULE, 'wallet', 1000n)).toThrow(ChannelNotConfiguredError);
    expect(() => quoteFee(SCHEDULE, 'qr', 49n)).toThrow(FeeExceedsAmountError); // el fijo de 50 supera 49
  });

  it('toFeeRule pasa los importes de número a bigint y omite lo que no está', () => {
    expect(toFeeRule({ channel: 'qr', percent: '1', fixed_minor: 5 })).toEqual({ percent: '1', fixedMinor: 5n });
  });
});

describe('validateChannels', () => {
  it('CORRECTO: un tarifario válido no tiene errores', () => {
    expect(validateChannels(SCHEDULE)).toEqual([]);
  });

  it.each([
    [[{ channel: 'qr', percent: '1' }, { channel: 'qr', percent: '2' }], 'channels[1].channel', 'duplicated'],
    [[{ channel: 'qr', percent: '101' }], 'channels[0].percent', 'invalid'],
    [[{ channel: 'qr', percent: '1.1234567' }], 'channels[0].percent', 'invalid'],
    [[{ channel: 'qr', percent: '1e2' }], 'channels[0].percent', 'invalid'],
    [[{ channel: 'qr', percent: '1', fixed_minor: -1 }], 'channels[0].fixed_minor', 'invalid'],
    [[{ channel: 'qr', percent: '1', cap_minor: 1.5 }], 'channels[0].cap_minor', 'invalid'],
    [[{ channel: 'qr', percent: '1', min_minor: 10, cap_minor: 5 }], 'channels[0].min_minor', 'above_cap'],
  ])('INVÁLIDO: %j', (channels, field, code) => {
    expect(validateChannels(channels as ChannelRule[])).toContainEqual({ field, code });
  });
});
