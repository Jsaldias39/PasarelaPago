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

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const payMode = env.PAY_MODE ?? '';
  if (payMode !== 'sandbox' && payMode !== 'live') throw new Error(`PAY_MODE inválido: ${payMode || '(vacío)'} (sandbox | live)`);
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
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
