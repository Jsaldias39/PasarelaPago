/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
  /** Opcional: sin NATS el servicio arranca pero el relé del outbox no publica y `/health/ready` lo informa. */
  readonly natsUrl?: string;
  /** `sandbox` carga el simulador y los dobles; `live` los rechaza (D-26). Sin valor por defecto en producción: ver `loadConfig`. */
  readonly mode: 'sandbox' | 'live';
  /** URL base de `pay-qr`. Sin ella, pedir un cobro QR falla con `internal_error` (no hay QR que mostrar). */
  readonly qrUrl?: string;
  readonly poller: { readonly intervalMs: number; readonly minAgeMs: number; readonly baseBackoffMs: number; readonly maxBackoffMs: number; readonly batchSize: number };
  readonly health: { readonly intervalMs: number; readonly downAfterFailures: number };
  /** Reintentos de la MISMA llamada ante un timeout ambiguo (con la misma referencia) antes de responder 502. */
  /** Candados de envío: conexiones dedicadas (tope de envíos simultáneos distintos) y cuánto se espera una conexión antes de responder 409. */
  readonly lockPool: { readonly max: number; readonly waitMs: number };
  readonly timeoutRetries: number;
  /** Callbacks por minuto y por conector antes de responder 429. */
  readonly callbackRatePerMinute: number;
  /** El simulador entrega sus callbacks en proceso cada tantos ms (0 = no, las pruebas lo disparan a mano). */
  readonly mockPumpIntervalMs: number;
  /** Conciliación por extracto: cada cuánto corre (0 = no, las pruebas la disparan a mano) y cuántas horas hacia atrás mira. */
  readonly reconcile: { readonly intervalMs: number; readonly lookbackHours: number };
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${name} inválido: ${raw}`);
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/** `PAY_MODE` es obligatorio y solo admite `sandbox` o `live`: un modo mal escrito no puede dar un servicio en `live` por accidente. */
function parseMode(raw: string | undefined): 'sandbox' | 'live' {
  if (raw === 'sandbox' || raw === 'live') return raw;
  throw new Error(`PAY_MODE debe ser sandbox o live (llegó: ${raw ?? 'sin definir'})`);
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number(env.PORT ?? 3103);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT inválido: ${env.PORT}`);
  const dbPort = Number(env.DB_PORT ?? 5432);
  if (!Number.isInteger(dbPort)) throw new Error(`DB_PORT inválido: ${env.DB_PORT}`);
  return {
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    db: {
      host: required(env, 'DB_HOST'),
      port: dbPort,
      name: required(env, 'DB_NAME'),
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
    },
    ...(env.NATS_URL ? { natsUrl: env.NATS_URL } : {}),
    mode: parseMode(env.PAY_MODE),
    ...(env.PAY_QR_URL ? { qrUrl: env.PAY_QR_URL } : {}),
    poller: {
      intervalMs: integer(env, 'POLLER_INTERVAL_MS', 15_000),
      minAgeMs: integer(env, 'POLLER_MIN_AGE_MS', 30_000),
      baseBackoffMs: integer(env, 'POLLER_BASE_BACKOFF_MS', 30_000, 1),
      maxBackoffMs: integer(env, 'POLLER_MAX_BACKOFF_MS', 600_000, 1),
      batchSize: integer(env, 'POLLER_BATCH_SIZE', 50, 1),
    },
    health: { intervalMs: integer(env, 'HEALTH_INTERVAL_MS', 10_000), downAfterFailures: integer(env, 'HEALTH_DOWN_AFTER_FAILURES', 3, 1) },
    lockPool: { max: integer(env, 'LOCK_POOL_MAX', 20, 1), waitMs: integer(env, 'LOCK_WAIT_MS', 15_000, 1) },
    timeoutRetries: integer(env, 'TIMEOUT_RETRIES', 2),
    callbackRatePerMinute: integer(env, 'CALLBACK_RATE_PER_MINUTE', 600, 1),
    mockPumpIntervalMs: integer(env, 'MOCK_PUMP_INTERVAL_MS', 1_000),
    reconcile: { intervalMs: integer(env, 'RECONCILE_INTERVAL_MS', 300_000), lookbackHours: integer(env, 'RECONCILE_LOOKBACK_HOURS', 48, 1) },
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
