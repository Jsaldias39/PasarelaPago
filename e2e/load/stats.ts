/** Estadística mínima del runner de carga (sin dependencias). */

/** Percentil por rango más cercano sobre una copia ordenada. `p` en [0, 100]. Lista vacía ⇒ `null` (no se inventa un número). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new Error(`percentil fuera de rango: ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export interface Summary {
  readonly n: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly mean: number | null;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { n: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { n: sorted.length, min: sorted[0]!, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1]!, mean: sum / sorted.length };
}

export const round = (value: number | null, digits = 1): number | null => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
