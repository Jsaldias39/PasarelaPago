import { FeeExceedsAmountError, type FeeRule, splitFee } from '@pay/money';
import { ProblemError } from '@pay/problem';

/** Regla de un canal tal como viaja por API y eventos (importes en centavos como número). */
export interface ChannelRule {
  channel: 'qr' | 'card' | 'bank_transfer' | 'wallet' | 'direct';
  percent: string;
  fixed_minor?: number;
  min_minor?: number;
  cap_minor?: number;
}

export interface Quote {
  fee_minor: bigint;
  net_minor: bigint;
}

export function toFeeRule(rule: ChannelRule): FeeRule {
  return {
    percent: rule.percent,
    fixedMinor: BigInt(rule.fixed_minor ?? 0),
    ...(rule.min_minor !== undefined && { minMinor: BigInt(rule.min_minor) }),
    ...(rule.cap_minor !== undefined && { capMinor: BigInt(rule.cap_minor) }),
  };
}

/**
 * Comisión y neto de un cobro con el tarifario de un comercio. El cálculo es SIEMPRE el de `@pay/money.splitFee`
 * (D-07, D-20: el neto se redondea half-up, el centavo de un empate queda del lado del comercio): acá no hay aritmética propia.
 * El abono mensual no entra: no es por transacción.
 *
 * @throws ProblemError `validation_failed` si el canal no está en el tarifario, `fee_exceeds_amount` si la comisión supera el importe.
 */
export function quoteFee(channels: readonly ChannelRule[], channel: string, grossMinor: bigint): Quote {
  const rule = channels.find((c) => c.channel === channel);
  if (!rule) throw new ProblemError('validation_failed', { errors: [{ field: 'channel', code: 'not_configured' }] });
  try {
    const split = splitFee(grossMinor, toFeeRule(rule));
    return { fee_minor: split.feeMinor, net_minor: split.netMinor };
  } catch (error) {
    if (error instanceof FeeExceedsAmountError) throw new ProblemError('fee_exceeds_amount');
    throw error;
  }
}

/** Validación de un tarifario antes de publicarlo. Devuelve los errores por campo (vacío si es válido). */
export function validateChannels(channels: readonly ChannelRule[]): { field: string; code: string }[] {
  const errors: { field: string; code: string }[] = [];
  const seen = new Set<string>();
  channels.forEach((rule, i) => {
    const at = `channels[${i}]`;
    if (seen.has(rule.channel)) errors.push({ field: `${at}.channel`, code: 'duplicated' });
    seen.add(rule.channel);
    if (!/^\d{1,3}(\.\d{1,6})?$/.test(rule.percent) || Number(rule.percent) > 100) errors.push({ field: `${at}.percent`, code: 'invalid' });
    for (const key of ['fixed_minor', 'min_minor', 'cap_minor'] as const) {
      const value = rule[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) errors.push({ field: `${at}.${key}`, code: 'invalid' });
    }
    if (rule.min_minor !== undefined && rule.cap_minor !== undefined && rule.min_minor > rule.cap_minor) errors.push({ field: `${at}.min_minor`, code: 'above_cap' });
  });
  return errors;
}
