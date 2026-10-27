/**
 * Parámetros propios de pay-schedules (aparte de `ServiceConfig`, que es el de la plantilla).
 *
 * La política de reintentos NO tiene valor por defecto: cuánto esperar entre intentos cuando no hay fondos es una decisión de
 * negocio (REQ-P5-6, «se reintenta según la política»). Sin ella el servicio no arranca. Lo demás son parámetros operativos
 * con supuesto registrado en docs/trabajo/ola-1/P5/DECISIONES-TOMADAS.md.
 */
export interface ScheduleSettings {
  /** URL base de pay-ledger (red interna). */
  readonly ledgerUrl: string;
  readonly ledgerTimeoutMs: number;
  /** Espera antes de cada reintento, en segundos. Intentos totales = longitud + 1. */
  readonly retryDelaysSeconds: readonly number[];
  /** Cuánto dura la retención en el libro mayor antes de confirmarse; vuelve sola si vence. */
  readonly holdExpiresSeconds: number;
  /** Cuánto tiempo «posee» un ejecutor un pago antes de que otro pueda retomarlo. */
  readonly leaseSeconds: number;
  readonly runIntervalSeconds: number;
  /** Comercio de AloVida: único beneficiario permitido de una comisión programada (7.8). Sin él, no se aceptan comisiones. */
  readonly platformMerchantId?: string;
  /** Tope por mandato. Sin valor, no hay tope (no se inventa uno). */
  readonly mandateMaxAmountMinor?: number;
  readonly backgroundJobsEnabled: boolean;
  /** Stream y consumidor durable de los eventos `merchant.*` de pay-merchants. */
  readonly merchantsStream: string;
  readonly merchantsDurable: string;
}

export const SCHEDULE_SETTINGS = Symbol('SCHEDULE_SETTINGS');

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function intIn(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) throw new Error(`${name} debe ser un entero entre ${min} y ${max}: ${raw}`);
  return value;
}

export function loadScheduleSettings(env: NodeJS.ProcessEnv = process.env): ScheduleSettings {
  const ledgerUrl = required(env, 'LEDGER_URL').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(ledgerUrl)) throw new Error('LEDGER_URL debe ser una URL http(s)');
  const rawDelays = required(env, 'RETRY_DELAYS_SECONDS');
  const retryDelaysSeconds = rawDelays.split(',').map((part) => {
    if (!/^\d+$/.test(part.trim())) throw new Error(`RETRY_DELAYS_SECONDS debe ser una lista de enteros positivos separados por coma: ${rawDelays}`);
    return Number(part.trim());
  });
  if (retryDelaysSeconds.length > 10 || retryDelaysSeconds.some((n) => n < 1 || n > 30 * 86400)) throw new Error('RETRY_DELAYS_SECONDS admite hasta 10 esperas de 1 s a 30 días');
  const platformMerchantId = env.PLATFORM_MERCHANT_ID || undefined;
  if (platformMerchantId !== undefined && !/^mc_[a-z0-9]{10,40}$/.test(platformMerchantId)) throw new Error('PLATFORM_MERCHANT_ID no tiene la forma de un id de comercio');
  const cap = env.MANDATE_MAX_AMOUNT_MINOR;
  if (cap !== undefined && cap !== '' && (!/^[1-9]\d{0,15}$/.test(cap) || !Number.isSafeInteger(Number(cap)))) throw new Error(`MANDATE_MAX_AMOUNT_MINOR debe ser un entero positivo seguro: ${cap}`);
  return {
    ledgerUrl,
    ledgerTimeoutMs: intIn(env, 'LEDGER_TIMEOUT_MS', 3000, 1, 30000),
    retryDelaysSeconds,
    holdExpiresSeconds: intIn(env, 'HOLD_EXPIRES_SECONDS', 3600, 60, 2592000),
    leaseSeconds: intIn(env, 'LEASE_SECONDS', 120, 1, 3600),
    runIntervalSeconds: intIn(env, 'RUN_INTERVAL_SECONDS', 30, 1, 3600),
    ...(platformMerchantId !== undefined && { platformMerchantId }),
    ...(cap !== undefined && cap !== '' && { mandateMaxAmountMinor: Number(cap) }),
    backgroundJobsEnabled: env.DISABLE_BACKGROUND_JOBS !== '1',
    merchantsStream: env.MERCHANTS_STREAM || 'PAY_MERCHANTS',
    merchantsDurable: env.MERCHANTS_DURABLE || 'pay-schedules.merchant-replica',
  };
}
