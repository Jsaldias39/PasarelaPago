import { addDecimals as sumarDecimales } from './decimal-money';

/**
 * Aritmética exacta de importes de pagos (MCH-017).
 *
 * Los importes llegan como cadena (`numeric` de PostgreSQL o el DTO) y así se
 * tratan: nada pasa por `Number`. Con coma flotante, 0.10 + 0.20 da
 * 0.30000000000000004 y un reembolso válido de 0.20 sobre 0.30 capturado
 * quedaba rechazado; un epsilon lo taparía y dejaría pasar excesos reales.
 *
 * La suma reusa `sumarDecimales` de `common/money`. Acá se agregan la
 * comparación y la resta, que ese módulo no ofrece, con la misma técnica:
 * `BigInt` sobre la representación decimal literal, cualquiera sea la escala
 * de la moneda (0, 2 o 3 decimales).
 */

/** Importe escalado a un entero y cuántos decimales tenía. */
interface Escalado {
  readonly valor: bigint;
  readonly decimales: number;
}

/**
 * Parte una cadena decimal en entero escalado + decimales.
 *
 * @param text - Importe como cadena.
 * @returns La representación escalada.
 * @throws RangeError si no es un decimal.
 */
function escalate(text: string): Escalado {
  const clean = text.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(clean)) {
    throw new RangeError(`Importe no decimal: ${text}`);
  }
  const negative = clean.startsWith('-');
  const [whole, fraction = ''] = clean.replace(/^[+-]/, '').split('.');
  const value = BigInt(`${whole}${fraction}`);
  return { valor: negative ? -value : value, decimales: fraction.length };
}

/**
 * Suma importes; la lista vacía suma cero.
 *
 * @param amounts - Importes como cadena.
 * @returns La suma, con la escala de la entrada más precisa.
 */
export function addAmounts(amounts: readonly string[]): string {
  return sumarDecimales(amounts) ?? '0';
}

/**
 * `a - b` exacto.
 *
 * @param a - Minuendo.
 * @param b - Sustraendo.
 * @returns La diferencia como cadena decimal (puede ser negativa).
 */
export function subtractAmounts(a: string, b: string): string {
  const clean = b.trim().replace(/^\+/, '');
  const opposite = clean.startsWith('-') ? clean.slice(1) : `-${clean}`;
  return addAmounts([a, opposite]);
}

/**
 * Compara dos importes por valor: `'0.3'` y `'0.30'` son iguales.
 *
 * @param a - Primer importe.
 * @param b - Segundo importe.
 * @returns -1 si `a < b`, 0 si son iguales, 1 si `a > b`.
 */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const ea = escalate(a);
  const eb = escalate(b);
  const decimals = Math.max(ea.decimales, eb.decimales);
  const va = ea.valor * 10n ** BigInt(decimals - ea.decimales);
  const vb = eb.valor * 10n ** BigInt(decimals - eb.decimales);
  if (va === vb) return 0;
  return va < vb ? -1 : 1;
}

/**
 * `true` si el importe es un decimal estrictamente mayor que cero.
 *
 * @param amount - Importe como cadena.
 * @returns Si es positivo; `false` también para texto que no es decimal.
 */
export function isPositiveAmount(amount: string): boolean {
  try {
    return compareAmounts(amount, '0') > 0;
  } catch {
    return false;
  }
}

/** Decimales con los que se persisten los importes de las monedas operadas (BOB y USD). */
export const MONEY_SCALE = 2;

/**
 * Forma admisible de un importe o una tasa que llega como cadena: decimal con
 * signo opcional, hasta 14 dígitos enteros y 6 decimales. El tope entero deja
 * cualquier suma de miles de líneas dentro de `numeric(20,6)`; los 6 decimales
 * son los que el modelo guarda. `@IsNumberString` por sí solo no fija escala ni
 * rango (admitía `.5` y cadenas de cientos de dígitos).
 */
export const BOUNDED_DECIMAL_REGEX = /^-?\d{1,14}(\.\d{1,6})?$/;

/** Mensaje de validación para {@link BOUNDED_DECIMAL_REGEX}. */
export const BOUNDED_DECIMAL_MESSAGE =
  'Debe ser un decimal con hasta 14 dígitos enteros y 6 decimales';

/**
 * Vuelve a poner el punto decimal en un entero escalado.
 *
 * @param value - Entero escalado, con signo.
 * @param decimals - Posiciones decimales a restituir.
 * @returns La cadena decimal.
 */
function format(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const text = `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative ? `-${text}` : text;
}

/**
 * Lleva un entero escalado de `decimals` a `target` posiciones. Al reducir
 * redondea half-up (el .5 se aleja de cero), igual que el resto del sistema.
 */
function rescale(value: bigint, decimals: number, target: number): bigint {
  if (decimals <= target) return value * 10n ** BigInt(target - decimals);
  const factor = 10n ** BigInt(decimals - target);
  const half = value < 0n ? -(factor / 2n) : factor / 2n;
  return (value + half) / factor;
}

/**
 * Redondea un importe a `scale` decimales (half-up) sin pasar por `Number`.
 *
 * @param amount - Importe como cadena decimal.
 * @param scale - Decimales de salida; por defecto {@link MONEY_SCALE}.
 * @returns El importe redondeado, siempre con `scale` decimales.
 */
export function roundAmount(
  amount: string,
  scale: number = MONEY_SCALE,
): string {
  const parsed = escalate(amount);
  return format(rescale(parsed.valor, parsed.decimales, scale), scale);
}

/**
 * Normaliza un importe para persistirlo: al menos {@link MONEY_SCALE} decimales
 * y sin ceros de relleno por encima de eso (`0.100000` → `0.10`, `0.1234` se
 * conserva). No pierde precisión.
 *
 * @param amount - Importe como cadena decimal.
 * @returns La cadena normalizada.
 */
export function normalizeAmount(amount: string): string {
  const parsed = escalate(amount);
  let decimals = parsed.decimales;
  let value = parsed.valor;
  while (decimals > MONEY_SCALE && value % 10n === 0n) {
    value /= 10n;
    decimals -= 1;
  }
  const target = Math.max(decimals, MONEY_SCALE);
  return format(rescale(value, decimals, target), target);
}

/**
 * `amount × factor` exacto, redondeado half-up a `scale` decimales.
 *
 * @param amount - Importe.
 * @param factor - Factor o tasa (por ejemplo una cotización).
 * @param scale - Decimales de salida; por defecto {@link MONEY_SCALE}.
 * @returns El producto como cadena decimal.
 */
export function multiplyAmount(
  amount: string,
  factor: string,
  scale: number = MONEY_SCALE,
): string {
  const a = escalate(amount);
  const b = escalate(factor);
  return format(
    rescale(a.valor * b.valor, a.decimales + b.decimales, scale),
    scale,
  );
}

/**
 * `amount × percentage / 100` exacto, redondeado half-up a `scale` decimales.
 *
 * @param amount - Importe base.
 * @param percentage - Porcentaje (`15` es el 15 %).
 * @param scale - Decimales de salida; por defecto {@link MONEY_SCALE}.
 * @returns La parte porcentual como cadena decimal.
 */
export function percentageOfAmount(
  amount: string,
  percentage: string,
  scale: number = MONEY_SCALE,
): string {
  const a = escalate(amount);
  const b = escalate(percentage);
  return format(
    rescale(a.valor * b.valor, a.decimales + b.decimales + 2, scale),
    scale,
  );
}
