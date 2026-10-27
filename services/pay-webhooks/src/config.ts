/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface EventSource {
  /** Stream de JetStream del publicador (`PAY_PAYMENTS`). */
  readonly stream: string;
  /** Prefijo de los temas (`pay-payments` ⇒ `pay-payments.payment_intent.succeeded`). */
  readonly subjectPrefix: string;
}

export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string; readonly schema?: string };
  /** Opcional: sin NATS el servicio arranca pero no recibe eventos y `/health/ready` lo informa. */
  readonly natsUrl?: string;
  /** `sandbox` ⇒ los eventos salen con `mode: test`; `live` ⇒ `mode: live`. */
  readonly payMode: 'sandbox' | 'live';
  /**
   * Motor de entrega (`WEBHOOKS_ENGINE`). Hoy solo existe `inprocess`, el [DOBLE de Svix]: en sandbox es el valor por defecto; bajo
   * `live` la variable es obligatoria y el servicio NO arranca ni con `inprocess` (es un doble) ni con `svix` (SvixEngine no existe todavía).
   */
  readonly engine: 'inprocess';
  /** Clave de 32 bytes con la que se sellan los secretos de firma (AES-256-GCM). */
  readonly secretKek: Buffer;
  readonly eventSources: readonly EventSource[];
  readonly delivery: {
    readonly timeoutMs: number;
    /** Esperas antes de cada intento, en ms; el largo es el número máximo de intentos. */
    readonly scheduleMs: readonly number[];
    readonly jitterRatio: number;
    /** Entregas agotadas seguidas que deshabilitan un endpoint. */
    readonly disableAfterDeadDeliveries: number;
    readonly batchSize: number;
    readonly pollIntervalMs: number;
    /** Cuánto tiempo «posee» un trabajador una entrega antes de que otro pueda retomarla. */
    readonly leaseMs: number;
    /** Entregas en vuelo a la vez hacia un mismo endpoint: uno lento no puede ahogar a los demás. */
    readonly perEndpointConcurrency: number;
    /** Tope de entregas de un mismo endpoint que un lote puede reclamar. */
    readonly perEndpointBatch: number;
  };
  /** Cuánto siguen firmándose las entregas con el secreto viejo después de rotarlo. */
  readonly rotationGraceMs: number;
  readonly maxEndpointsPerMerchant: number;
  /**
   * SOLO sandbox (e2e): destinos `127.0.0.1:<puerto>` EXACTOS a los que se puede entregar aunque sean de loopback. Con `PAY_MODE=live`
   * el servicio no arranca si hay alguno. Cualquier otro destino privado sigue rechazado.
   */
  readonly sandboxTargets: readonly string[];
  /** SOLO sandbox: CA en PEM en la que se confía para esos destinos (el receptor de prueba usa un certificado autofirmado). */
  readonly sandboxCaFile?: string;
  /** `false` en pruebas y en réplicas que solo atienden la API: el trabajador de entregas no arranca solo. */
  readonly workerEnabled: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} inválido: ${raw}`);
  return value;
}

const SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Misma escalera que Svix (inmediato, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h): 8 intentos en unas 28 h. */
const DEFAULT_SCHEDULE = [0, 5 * SECOND, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 5 * HOUR, 10 * HOUR, 10 * HOUR] as const;
const DEFAULT_SOURCES = 'PAY_PAYMENTS=pay-payments,PAY_SETTLEMENT=pay-settlement,PAY_SCHEDULES=pay-schedules';

function parseSources(text: string): EventSource[] {
  return text.split(',').map((pair) => {
    const [stream, subjectPrefix, ...rest] = pair.trim().split('=');
    if (!stream || !subjectPrefix || rest.length > 0 || !/^[A-Za-z0-9_-]+$/.test(stream) || !/^[A-Za-z0-9_.-]+$/.test(subjectPrefix)) {
      throw new Error(`WEBHOOKS_EVENT_SOURCES inválido: ${pair}`);
    }
    return { stream, subjectPrefix };
  });
}

function parseSchedule(text: string | undefined): readonly number[] {
  if (text === undefined || text === '') return DEFAULT_SCHEDULE;
  const values = text.split(',').map((part) => Number(part.trim()));
  if (values.length < 1 || values.length > 20 || values.some((v) => !Number.isInteger(v) || v < 0 || v > 24 * HOUR)) throw new Error(`WEBHOOKS_RETRY_SCHEDULE_MS inválido: ${text}`);
  return values;
}

/**
 * D-26. `inprocess|svix`. Sin valor: sandbox usa `inprocess`; live exige declararlo, y aun declarado no arranca: `inprocess` es un doble
 * de Svix y `svix` todavía no está implementado (no hay `SvixEngine`). Cuando exista, `svix` pasa a ser el único valor admitido en live.
 */
function parseEngine(raw: string | undefined, payMode: 'sandbox' | 'live'): 'inprocess' {
  const value = raw ?? '';
  if (value !== '' && value !== 'inprocess' && value !== 'svix') throw new Error(`WEBHOOKS_ENGINE inválido: ${value} (inprocess | svix)`);
  if (value === 'svix') throw new Error('WEBHOOKS_ENGINE=svix: el motor real no está implementado (no existe SvixEngine); en sandbox usá WEBHOOKS_ENGINE=inprocess');
  if (payMode === 'live') {
    if (value === '') throw new Error('PAY_MODE=live exige declarar WEBHOOKS_ENGINE (sin valor por defecto en live)');
    throw new Error('PAY_MODE=live no admite WEBHOOKS_ENGINE=inprocess: es el doble de Svix y el motor real no está implementado');
  }
  return 'inprocess';
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const payMode = env.PAY_MODE ?? '';
  if (payMode !== 'sandbox' && payMode !== 'live') throw new Error(`PAY_MODE inválido: ${payMode || '(vacío)'} (sandbox | live)`);
  const sandboxTargets = (env.WEBHOOKS_SANDBOX_TARGETS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  for (const target of sandboxTargets) if (!/^127\.0\.0\.1:\d{2,5}$/.test(target)) throw new Error(`WEBHOOKS_SANDBOX_TARGETS inválido: ${target} (solo 127.0.0.1:<puerto>)`);
  if (payMode === 'live' && (sandboxTargets.length > 0 || env.WEBHOOKS_SANDBOX_CA_FILE)) {
    throw new Error('WEBHOOKS_SANDBOX_TARGETS y WEBHOOKS_SANDBOX_CA_FILE no pueden usarse con PAY_MODE=live: abren la entrega a la red local');
  }
  // D-26: la escalera de reintentos acortada es un acelerador de sandbox; en live rige la de Svix (la escalera por defecto).
  if (payMode === 'live' && env.WEBHOOKS_RETRY_SCHEDULE_MS) {
    throw new Error('WEBHOOKS_RETRY_SCHEDULE_MS no puede usarse con PAY_MODE=live: es un acelerador de sandbox y en live rige la escalera por defecto');
  }
  const engine = parseEngine(env.WEBHOOKS_ENGINE, payMode);
  const kek = Buffer.from(required(env, 'WEBHOOKS_SECRET_KEK'), 'base64');
  if (kek.length !== 32) throw new Error('WEBHOOKS_SECRET_KEK debe ser una clave de 32 bytes en base64');
  if (env.DB_SCHEMA && !SCHEMA.test(env.DB_SCHEMA)) throw new Error(`DB_SCHEMA inválido: ${env.DB_SCHEMA}`);
  return {
    port: integer(env, 'PORT', 3110, 1, 65535),
    logLevel: env.LOG_LEVEL ?? 'info',
    db: {
      host: required(env, 'DB_HOST'),
      port: integer(env, 'DB_PORT', 5432, 1, 65535),
      name: required(env, 'DB_NAME'),
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
      ...(env.DB_SCHEMA ? { schema: env.DB_SCHEMA } : {}),
    },
    ...(env.NATS_URL ? { natsUrl: env.NATS_URL } : {}),
    payMode,
    engine,
    secretKek: kek,
    eventSources: parseSources(env.WEBHOOKS_EVENT_SOURCES ?? DEFAULT_SOURCES),
    delivery: {
      timeoutMs: integer(env, 'WEBHOOKS_DELIVERY_TIMEOUT_MS', 15_000, 100, 60_000),
      scheduleMs: parseSchedule(env.WEBHOOKS_RETRY_SCHEDULE_MS),
      jitterRatio: integer(env, 'WEBHOOKS_RETRY_JITTER_PERCENT', 20, 0, 50) / 100,
      disableAfterDeadDeliveries: integer(env, 'WEBHOOKS_DISABLE_AFTER_DEAD', 5, 1, 1000),
      batchSize: integer(env, 'WEBHOOKS_BATCH_SIZE', 20, 1, 500),
      pollIntervalMs: integer(env, 'WEBHOOKS_POLL_INTERVAL_MS', 1_000, 10, 60_000),
      leaseMs: integer(env, 'WEBHOOKS_LEASE_MS', 60_000, 1_000, 600_000),
      perEndpointConcurrency: integer(env, 'WEBHOOKS_PER_ENDPOINT_CONCURRENCY', 2, 1, 50),
      perEndpointBatch: integer(env, 'WEBHOOKS_PER_ENDPOINT_BATCH', 10, 1, 500),
    },
    rotationGraceMs: integer(env, 'WEBHOOKS_ROTATION_GRACE_HOURS', 24, 0, 24 * 30) * HOUR,
    maxEndpointsPerMerchant: integer(env, 'WEBHOOKS_MAX_ENDPOINTS', 20, 1, 1000),
    workerEnabled: (env.WEBHOOKS_WORKER_ENABLED ?? 'true') !== 'false',
    sandboxTargets,
    ...(env.WEBHOOKS_SANDBOX_CA_FILE ? { sandboxCaFile: env.WEBHOOKS_SANDBOX_CA_FILE } : {}),
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
