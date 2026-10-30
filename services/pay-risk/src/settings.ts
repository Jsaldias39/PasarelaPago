import { payModeOf, type PayMode } from './config';

/**
 * Parámetros propios de pay-risk (aparte de `ServiceConfig`, que es el de la plantilla).
 *
 * Los umbrales de sanciones NO tienen valor por defecto (los fija cumplimiento, `docs/spikes/watchman.md`): sin ellos el
 * servicio no arranca. Lo mismo la clave que huella al pagador. El resto son parámetros operativos con supuesto
 * registrado en docs/trabajo/ola-1/P5/DECISIONES-TOMADAS.md.
 */
export interface RiskSettings {
  /** Despliegue (D-26). */
  readonly payMode: PayMode;
  /** Listas que sirve Watchman: `static` (v2-static, congeladas de 2019, SOLO sandbox) o `current` (vigentes, declaradas por quien despliega). */
  readonly watchmanLists: 'static' | 'current';
  /** URL base de moov Watchman (red interna: su API no autentica). */
  readonly watchmanUrl: string;
  /** Tiempo máximo de cada búsqueda en Watchman, para entrar en el presupuesto de 300 ms. */
  readonly screeningTimeoutMs: number;
  /** Puntaje (0–1] desde el cual una coincidencia es `deny`. */
  readonly sanctionsDenyScore: number;
  /** Puntaje (0–1] desde el cual una coincidencia es `review`; no puede superar al de `deny`. */
  readonly sanctionsReviewScore: number;
  /** Clave del HMAC con que se huella al pagador antes de guardarlo. */
  readonly payerHashKey: string;
}

export const RISK_SETTINGS = Symbol('RISK_SETTINGS');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function score(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(raw) || !(value > 0 && value <= 1)) throw new Error(`${name} debe estar en (0, 1]: ${raw}`);
  return value;
}

export function loadRiskSettings(env: NodeJS.ProcessEnv = process.env): RiskSettings {
  const payMode = payModeOf(env);
  const lists = env.WATCHMAN_LISTS || (payMode === 'sandbox' ? 'static' : '');
  if (lists !== 'static' && lists !== 'current') {
    throw new Error(lists === '' ? 'PAY_MODE=live exige declarar WATCHMAN_LISTS=current (listas de sanciones vigentes)' : `WATCHMAN_LISTS inválido: ${lists} (static | current)`);
  }
  // Las listas congeladas de 2019 del Watchman de pruebas son un doble: bajo `live` no se arranca con ellas.
  if (payMode === 'live' && lists === 'static') throw new Error('PAY_MODE=live no arranca con WATCHMAN_LISTS=static: son las listas congeladas de 2019 (doble de sandbox)');
  const watchmanUrl = required(env, 'WATCHMAN_URL').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(watchmanUrl)) throw new Error('WATCHMAN_URL debe ser una URL http(s)');
  const timeout = Number(env.SCREENING_TIMEOUT_MS ?? 200);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 250) throw new Error(`SCREENING_TIMEOUT_MS debe estar entre 1 y 250: ${env.SCREENING_TIMEOUT_MS}`);
  const sanctionsDenyScore = score(env, 'SANCTIONS_DENY_SCORE');
  const sanctionsReviewScore = score(env, 'SANCTIONS_REVIEW_SCORE');
  if (sanctionsReviewScore > sanctionsDenyScore) throw new Error('SANCTIONS_REVIEW_SCORE no puede ser mayor que SANCTIONS_DENY_SCORE');
  const payerHashKey = required(env, 'PAYER_HASH_KEY');
  if (payerHashKey.length < 16) throw new Error('PAYER_HASH_KEY debe tener al menos 16 caracteres');
  return { payMode, watchmanLists: lists, watchmanUrl, screeningTimeoutMs: timeout, sanctionsDenyScore, sanctionsReviewScore, payerHashKey };
}
