import { FeeExceedsAmountError, splitFee, type FeeRule, type FeeSplit } from '@pay/money';
import { ProblemError } from '@pay/problem';

export type PaymentMethod = 'qr' | 'card' | 'bank_transfer' | 'wallet';

export interface ChannelFee {
  readonly channel: string;
  readonly percent: string;
  readonly fixed_minor?: number;
  readonly min_minor?: number;
  readonly cap_minor?: number;
}

/**
 * Cotiza la comisión de un cobro con la tarifa replicada del comercio (REQ-P3-5): `fee + net = amount`, siempre, con la regla
 * de redondeo única de `@pay/money` (D-20: se redondea half-up el NETO del comercio; el centavo de un empate es del comercio).
 *
 * El canal `direct` (comisión menor, 7.9) todavía no se aplica: no hay definición de cuándo un cobro es «directo» y no se
 * inventa. Se cotiza por el canal del medio de pago.
 */
export function quoteFee(channels: readonly ChannelFee[], method: PaymentMethod, amountMinor: number): FeeSplit {
  const row = channels.find((c) => c.channel === method);
  if (!row) {
    throw new ProblemError('validation_failed', { detail: 'El comercio no tiene tarifa publicada para este medio de pago', errors: [{ field: 'payment_method.type', code: 'fee_schedule_missing' }] });
  }
  const rule: FeeRule = {
    percent: row.percent,
    ...(row.fixed_minor !== undefined && { fixedMinor: BigInt(row.fixed_minor) }),
    ...(row.min_minor !== undefined && { minMinor: BigInt(row.min_minor) }),
    ...(row.cap_minor !== undefined && { capMinor: BigInt(row.cap_minor) }),
  };
  try {
    return splitFee(BigInt(amountMinor), rule);
  } catch (error) {
    if (error instanceof FeeExceedsAmountError) throw new ProblemError('fee_exceeds_amount');
    throw error;
  }
}
