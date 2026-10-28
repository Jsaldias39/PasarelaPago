/**
 * CRITERIO DE ACEPTACIÓN de la prueba de carga de T-01, escrito ANTES de correrla (docs/trabajo/ola-3/P1/CARGA.md). Este archivo es su traducción a código:
 * si el criterio cambia, cambia en CARGA.md primero y acá después, con la razón.
 */
export const CRITERIA = {
  /** p99 de la latencia de `POST /v1/payment_intents` (ms). */
  p99MaxMs: 2000,
  /** Fracción máxima de respuestas 5xx sobre el total de pedidos que recibieron respuesta. 0,1 %. */
  serverErrorRateMax: 0.001,
  /** Intentos que no llegan a un estado terminal dentro del plazo de espera. */
  stuckMax: 0,
  /** Asientos de captura duplicados en el ledger (y claves de idempotencia que devolvieron intentos distintos). */
  doubleEntriesMax: 0,
} as const;

export type Verdict = 'APRUEBA' | 'NO_APRUEBA' | 'NO_CONCLUYENTE';

export interface Measured {
  readonly sent: number;
  readonly answered: number;
  readonly status5xx: number;
  readonly status429: number;
  readonly noResponse: number;
  readonly runnerDropped: number;
  readonly p99Ms: number | null;
  readonly sendLagP99Ms: number | null;
  readonly created: number;
  readonly stuck: number;
  /** `null` = no se midió (no se dio la URL del ledger o la lectura falló). */
  readonly doubleEntries: number | null;
  readonly idempotencyViolations: number;
  readonly missingEntries: number | null;
  readonly machineBusyPercentAvg: number | null;
}

export interface Check {
  readonly name: string;
  readonly target: string;
  readonly observed: string;
  readonly result: 'PASA' | 'FALLA' | 'NO_MEDIDO';
}

export interface Evaluation {
  readonly verdict: Verdict;
  readonly checks: Check[];
  /** Por qué el resultado no es concluyente aunque no falle nada (límites del propio ensayo). */
  readonly caveats: string[];
}

const pct = (x: number): string => `${(x * 100).toFixed(3)} %`;

export function evaluate(m: Measured, thresholds: typeof CRITERIA = CRITERIA): Evaluation {
  const checks: Check[] = [];
  checks.push(
    m.p99Ms === null
      ? { name: 'p99 de la creación', target: `< ${thresholds.p99MaxMs} ms`, observed: 'sin respuestas', result: 'NO_MEDIDO' }
      : { name: 'p99 de la creación', target: `< ${thresholds.p99MaxMs} ms`, observed: `${m.p99Ms.toFixed(0)} ms`, result: m.p99Ms < thresholds.p99MaxMs ? 'PASA' : 'FALLA' },
  );
  const rate5xx = m.answered === 0 ? null : m.status5xx / m.answered;
  checks.push(
    rate5xx === null
      ? { name: 'errores 5xx', target: `< ${pct(thresholds.serverErrorRateMax)}`, observed: 'sin respuestas', result: 'NO_MEDIDO' }
      : { name: 'errores 5xx', target: `< ${pct(thresholds.serverErrorRateMax)}`, observed: `${pct(rate5xx)} (${m.status5xx} de ${m.answered})`, result: rate5xx < thresholds.serverErrorRateMax ? 'PASA' : 'FALLA' },
  );
  checks.push({ name: 'intentos colgados (sin estado terminal a tiempo)', target: `${thresholds.stuckMax}`, observed: `${m.stuck} de ${m.created}`, result: m.stuck <= thresholds.stuckMax ? 'PASA' : 'FALLA' });
  const doubles = m.doubleEntries === null ? null : m.doubleEntries + m.idempotencyViolations;
  checks.push(
    doubles === null
      ? { name: 'doble asiento / intento duplicado', target: `${thresholds.doubleEntriesMax}`, observed: `ledger no medido; claves de idempotencia con intentos distintos: ${m.idempotencyViolations}`, result: m.idempotencyViolations > 0 ? 'FALLA' : 'NO_MEDIDO' }
      : { name: 'doble asiento / intento duplicado', target: `${thresholds.doubleEntriesMax}`, observed: `${m.doubleEntries} asientos duplicados + ${m.idempotencyViolations} claves con intentos distintos`, result: doubles <= thresholds.doubleEntriesMax ? 'PASA' : 'FALLA' },
  );

  const caveats: string[] = [];
  if (m.status429 > 0) caveats.push(`${m.status429} respuestas 429: el frenado del borde actuó y parte de la carga NO llegó a los servicios; subí RATE_LIMIT_* (compose.mock.yml) o repartí la carga entre más claves y repetí.`);
  if (m.runnerDropped > 0) caveats.push(`el generador descartó ${m.runnerDropped} pedidos por llegar al tope de pedidos en vuelo: la tasa real fue menor a la pedida.`);
  if (m.sendLagP99Ms !== null && m.sendLagP99Ms > 100) caveats.push(`el generador se atrasó (p99 de retraso de salida ${m.sendLagP99Ms.toFixed(0)} ms > 100 ms): la máquina del generador está saturada y la latencia medida incluye ese atraso.`);
  if (m.noResponse > 0) caveats.push(`${m.noResponse} pedidos sin respuesta (corte o plazo vencido): son resultados AMBIGUOS (regla 11), no fallos; se cuentan aparte y NO entran al porcentaje de 5xx.`);
  if (m.machineBusyPercentAvg !== null && m.machineBusyPercentAvg > 90) caveats.push(`la máquina estuvo saturada (CPU media ${m.machineBusyPercentAvg.toFixed(0)} %): el resultado mide los límites de ESTA máquina, no el diseño.`);
  if (m.missingEntries !== null && m.missingEntries > 0) caveats.push(`${m.missingEntries} intentos \`succeeded\` sin asiento de captura en el ledger al momento de leerlo (puede ser demora del asiento: repetir la lectura).`);

  const failed = checks.some((c) => c.result === 'FALLA');
  const unmeasured = checks.some((c) => c.result === 'NO_MEDIDO');
  const inconclusive = unmeasured || m.status429 > 0 || m.runnerDropped > 0 || (m.sendLagP99Ms !== null && m.sendLagP99Ms > 100) || (m.missingEntries !== null && m.missingEntries > 0);
  // Un FALLA es concluyente (el criterio falló aun en estas condiciones); un PASA con reservas no certifica nada.
  const verdict: Verdict = failed ? 'NO_APRUEBA' : inconclusive ? 'NO_CONCLUYENTE' : 'APRUEBA';
  return { verdict, checks, caveats };
}
