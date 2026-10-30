import type { ScreeningResult } from '../screening/screener';

/** Conjunto de reglas tal como está en `risk_rule_sets`. `null` = regla apagada (D-23: sin valores por defecto). */
export interface RuleSet {
  readonly version: number;
  readonly maxAmountMinor: bigint | null;
  readonly merchantDailyAmountMinor: bigint | null;
  readonly payerDailyAmountMinor: bigint | null;
  readonly payerVelocity: { readonly max: number; readonly windowSeconds: number } | null;
  readonly merchantVelocity: { readonly max: number; readonly windowSeconds: number } | null;
  readonly hours: { readonly from: number; readonly to: number } | null;
}

/** Lo que el motor necesita saber de la historia reciente (ya consultado, para que el motor sea una función pura). */
export interface History {
  /** Intentos DISTINTOS ya evaluados dentro de cada ventana (sin contar el actual). */
  readonly payerAttempts: number;
  readonly merchantAttempts: number;
  /** Importe ya comprometido en las últimas 24 h (intentos distintos no rechazados, sin el actual). */
  readonly payerDailyMinor: bigint;
  readonly merchantDailyMinor: bigint;
}

export interface Facts {
  readonly amountMinor: bigint;
  /** Hora local de La Paz (0–23) en el momento de evaluar. */
  readonly localHour: number;
  /** ¿Vino una huella del pagador? Sin ella no se pueden aplicar los límites por pagador. */
  readonly payerKnown: boolean;
  readonly screening: ScreeningResult | 'not_provided';
}

export type Decision = 'allow' | 'review' | 'deny';

export interface Verdict {
  readonly decision: Decision;
  readonly reasonCode: string;
  /** Todas las reglas que se activaron, de la más grave a la menos grave. */
  readonly reasonCodes: readonly string[];
  readonly screened: boolean;
}

/** Prioridad = orden de la lista. El primer motivo activado es el que se devuelve. */
const DENY_CODES = ['sanctions_match', 'amount_over_limit', 'daily_limit_exceeded', 'payer_daily_limit_exceeded', 'velocity_exceeded', 'merchant_velocity_exceeded'] as const;
const REVIEW_CODES = ['sanctions_possible_match', 'screening_unavailable', 'screening_not_provided', 'payer_unidentified', 'outside_allowed_hours'] as const;

export function hasAnyLimit(rules: RuleSet): boolean {
  return (
    rules.maxAmountMinor !== null ||
    rules.merchantDailyAmountMinor !== null ||
    rules.payerDailyAmountMinor !== null ||
    rules.payerVelocity !== null ||
    rules.merchantVelocity !== null ||
    rules.hours !== null
  );
}

/**
 * Motor de reglas: función pura (sin base, sin red, sin reloj).
 * - `deny` gana a `review`, y `review` a `allow`.
 * - Nunca `allow` si no se cribó (`screened: false` ⇒ como mucho `review`).
 * - Sin ninguna regla cargada y cribado limpio ⇒ `allow` con `no_limits_configured`, para que se vea que no hay límites.
 */
export function evaluate(rules: RuleSet, facts: Facts, history: History): Verdict {
  const fired = new Set<string>();
  const screening = facts.screening;
  const screened = screening !== 'not_provided' && screening.outcome !== 'unavailable';

  if (screening === 'not_provided') fired.add('screening_not_provided');
  else if (screening.outcome === 'match') fired.add('sanctions_match');
  else if (screening.outcome === 'possible_match') fired.add('sanctions_possible_match');
  else if (screening.outcome === 'unavailable') fired.add('screening_unavailable');

  if (rules.maxAmountMinor !== null && facts.amountMinor > rules.maxAmountMinor) fired.add('amount_over_limit');
  if (rules.merchantDailyAmountMinor !== null && history.merchantDailyMinor + facts.amountMinor > rules.merchantDailyAmountMinor) fired.add('daily_limit_exceeded');
  if (rules.payerDailyAmountMinor !== null && history.payerDailyMinor + facts.amountMinor > rules.payerDailyAmountMinor) fired.add('payer_daily_limit_exceeded');
  // El intento actual es el (n+1)-ésimo: se rechaza cuando ya hay `max` dentro de la ventana.
  if (rules.payerVelocity !== null && history.payerAttempts >= rules.payerVelocity.max) fired.add('velocity_exceeded');
  if (rules.merchantVelocity !== null && history.merchantAttempts >= rules.merchantVelocity.max) fired.add('merchant_velocity_exceeded');
  // Un límite por pagador sin pagador identificado no se puede cumplir: se lo hace visible en vez de dejarlo pasar.
  if ((rules.payerVelocity !== null || rules.payerDailyAmountMinor !== null) && !facts.payerKnown) fired.add('payer_unidentified');
  if (rules.hours !== null && (facts.localHour < rules.hours.from || facts.localHour >= rules.hours.to)) fired.add('outside_allowed_hours');

  const deny = DENY_CODES.filter((code) => fired.has(code));
  const review = REVIEW_CODES.filter((code) => fired.has(code));
  const reasonCodes = [...deny, ...review];
  if (deny.length > 0) return { decision: 'deny', reasonCode: deny[0], reasonCodes, screened };
  if (review.length > 0) return { decision: 'review', reasonCode: review[0], reasonCodes, screened };
  return { decision: 'allow', reasonCode: hasAnyLimit(rules) ? 'ok' : 'no_limits_configured', reasonCodes: [], screened };
}
