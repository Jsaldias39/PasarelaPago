/**
 * Importes en unidades menores (centavos de BOB) y cálculo de comisiones (D-07, D-20).
 *
 * Todo es `bigint`: no hay coma flotante en ningún paso. La regla de redondeo (D-20)
 * es *half-up a favor del comercio*: se redondea el **neto** que cobra el comercio
 * (el .5 sube), y la comisión es lo que queda. Así `comisión + neto = bruto` siempre,
 * y el centavo de un empate exacto queda del lado del comercio.
 */

/** La comisión pedida no cabe en el importe cobrado. */
export class FeeExceedsAmountError extends RangeError {
  readonly code = 'fee_exceeds_amount';
  constructor(grossMinor: bigint) {
    super(`La comisión supera el importe cobrado (${grossMinor} centavos)`);
  }
}

/** Tarifa de un comercio para un canal. */
export interface FeeRule {
  /** Porcentaje como cadena: `'2.5'` es el 2,5 %. Hasta 3 enteros y 6 decimales, entre 0 y 100. */
  readonly percent: string;
  /** Monto fijo por transacción, en centavos. */
  readonly fixedMinor?: bigint;
  /** Comisión mínima, en centavos (se aplica antes de redondear). */
  readonly minMinor?: bigint;
  /** Tope de comisión, en centavos (se aplica antes de redondear). */
  readonly capMinor?: bigint;
}

/** Reparto de un cobro entre la plataforma y el comercio. */
export interface FeeSplit {
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly netMinor: bigint;
}

const PERCENT = /^\d{1,3}(\.\d{1,6})?$/;

/**
 * Pasa una cadena decimal con hasta 2 decimales a centavos.
 *
 * @param text - Por ejemplo `'97.50'`.
 * @returns Los centavos (`9750n`).
 * @throws RangeError si no es un decimal no negativo con a lo sumo 2 decimales.
 */
export function toMinor(text: string): bigint {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new RangeError(`Importe inválido (≥ 0, hasta 2 decimales): ${text}`);
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`);
}

/**
 * Pasa centavos a una cadena decimal con 2 decimales.
 *
 * @param minor - Centavos, no negativos.
 * @returns Por ejemplo `'97.50'`.
 */
export function fromMinor(minor: bigint): string {
  if (minor < 0n) throw new RangeError('Importe negativo');
  const digits = minor.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Convierte centavos a `number` para el borde JSON, solo si es un entero seguro.
 *
 * @param minor - Centavos.
 * @returns El mismo valor como `number`.
 * @throws RangeError si no cabe en un entero seguro.
 */
export function toSafeNumber(minor: bigint): number {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < 0n) {
    throw new RangeError('El importe no cabe en un entero seguro');
  }
  return Number(minor);
}

/**
 * Reparte un cobro en comisión y neto.
 *
 * @param grossMinor - Importe cobrado, en centavos (≥ 0).
 * @param rule - Tarifa del comercio.
 * @returns `{ grossMinor, feeMinor, netMinor }` con `feeMinor + netMinor === grossMinor`.
 * @throws RangeError si el porcentaje o el importe son inválidos.
 * @throws FeeExceedsAmountError si la comisión (con su fijo) supera el importe.
 */
export function splitFee(grossMinor: bigint, rule: FeeRule): FeeSplit {
  if (grossMinor < 0n) throw new RangeError('Importe negativo');
  if (!PERCENT.test(rule.percent)) {
    throw new RangeError(`Porcentaje inválido: ${rule.percent}`);
  }
  const [whole, fraction = ''] = rule.percent.split('.');
  const pct = BigInt(`${whole}${fraction}`);
  // El porcentaje se divide por 100 y por 10^decimales: todo se escala a `scale`.
  const scale = 10n ** BigInt(fraction.length + 2);
  if (pct > 100n * 10n ** BigInt(fraction.length)) {
    throw new RangeError(`Porcentaje mayor que 100: ${rule.percent}`);
  }

  let fee = grossMinor * pct + (rule.fixedMinor ?? 0n) * scale;
  if (rule.minMinor !== undefined && fee < rule.minMinor * scale) fee = rule.minMinor * scale;
  if (rule.capMinor !== undefined && fee > rule.capMinor * scale) fee = rule.capMinor * scale;
  if (fee > grossMinor * scale) throw new FeeExceedsAmountError(grossMinor);

  const netExact = grossMinor * scale - fee;
  const netMinor = (netExact * 2n + scale) / (2n * scale); // half-up; netExact ≥ 0
  return { grossMinor, feeMinor: grossMinor - netMinor, netMinor };
}
