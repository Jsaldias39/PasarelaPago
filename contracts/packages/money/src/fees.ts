import { splitFee, type FeeRule } from './minor';

/** El canal pedido no figura en el tarifario del comercio. */
export class ChannelNotConfiguredError extends RangeError {
  readonly code = 'channel_not_configured';
  constructor(readonly channel: string) {
    super(`El canal ${channel} no está en el tarifario`);
  }
}

/** Regla de un canal tal como viaja por API y eventos (importes en centavos como número entero). */
export interface ChannelRule {
  readonly channel: string;
  /** Porcentaje como cadena: `'2.5'` es el 2,5 %. */
  readonly percent: string;
  readonly fixed_minor?: number;
  readonly min_minor?: number;
  readonly cap_minor?: number;
}

export interface Quote {
  readonly feeMinor: bigint;
  readonly netMinor: bigint;
}

/** Pasa la regla del formato de red (`fixed_minor` numérico) a la de {@link splitFee} (`bigint`). */
export function toFeeRule(rule: ChannelRule): FeeRule {
  return {
    percent: rule.percent,
    fixedMinor: BigInt(rule.fixed_minor ?? 0),
    ...(rule.min_minor !== undefined && { minMinor: BigInt(rule.min_minor) }),
    ...(rule.cap_minor !== undefined && { capMinor: BigInt(rule.cap_minor) }),
  };
}

/**
 * Comisión y neto de un cobro con el tarifario de un comercio. El cálculo es SIEMPRE el de {@link splitFee} (D-07, D-20: el neto
 * se redondea half-up, el centavo de un empate queda del lado del comercio): acá no hay aritmética propia. El abono mensual no
 * entra: no es por transacción. Los servicios traducen los errores a su formato (RFC 9457).
 *
 * @throws ChannelNotConfiguredError si el canal no está en el tarifario.
 * @throws FeeExceedsAmountError (de `./minor`) si la comisión supera el importe.
 */
export function quoteFee(channels: readonly ChannelRule[], channel: string, grossMinor: bigint): Quote {
  const rule = channels.find((c) => c.channel === channel);
  if (!rule) throw new ChannelNotConfiguredError(channel);
  const split = splitFee(grossMinor, toFeeRule(rule));
  return { feeMinor: split.feeMinor, netMinor: split.netMinor };
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
