/**
 * Plan de llegadas del generador de carga: ABIERTO (open loop). Las peticiones salen en los instantes planificados, no cuando termina la anterior: si el sistema se
 * enlentece, la cola crece y se MIDE (un generador cerrado dejaría de cargar justo cuando más importa: «omisión coordinada»).
 *
 * Tasa r(t) = peak · min(1, t / ramp). Llegadas acumuladas N(t) = peak·t²/(2·ramp) durante la rampa y peak·ramp/2 + peak·(t − ramp) después.
 */
export interface PlanOptions {
  readonly peakRps: number;
  readonly rampSeconds: number;
  readonly durationSeconds: number;
}

export function validatePlan(o: PlanOptions): void {
  if (!(o.peakRps > 0 && Number.isFinite(o.peakRps))) throw new Error(`peakRps inválido: ${o.peakRps}`);
  if (!(o.rampSeconds >= 0 && Number.isFinite(o.rampSeconds))) throw new Error(`rampSeconds inválido: ${o.rampSeconds}`);
  if (!(o.durationSeconds > 0 && Number.isFinite(o.durationSeconds))) throw new Error(`durationSeconds inválido: ${o.durationSeconds}`);
  if (o.rampSeconds > o.durationSeconds) throw new Error('la rampa no puede durar más que la prueba');
}

/** Llegadas acumuladas esperadas hasta `t` segundos. */
export function cumulativeArrivals(o: PlanOptions, t: number): number {
  const ramp = o.rampSeconds;
  if (ramp === 0 || t >= ramp) return (ramp === 0 ? 0 : (o.peakRps * ramp) / 2) + o.peakRps * Math.max(0, t - ramp);
  return (o.peakRps * t * t) / (2 * ramp);
}

/** Instantes (ms desde el inicio) de cada llegada, en orden. Determinista. */
export function arrivalOffsetsMs(o: PlanOptions): number[] {
  validatePlan(o);
  const total = Math.floor(cumulativeArrivals(o, o.durationSeconds));
  const out: number[] = [];
  const rampArrivals = o.rampSeconds === 0 ? 0 : (o.peakRps * o.rampSeconds) / 2;
  for (let i = 1; i <= total; i += 1) {
    // Se invierte N(t) = i.
    const t = i <= rampArrivals ? Math.sqrt((2 * o.rampSeconds * i) / o.peakRps) : o.rampSeconds + (i - rampArrivals) / o.peakRps;
    out.push(Math.round(t * 1000));
  }
  return out;
}
