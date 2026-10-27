/** Servicios dueños de los recursos públicos, a los que pay-edge reenvía. */
export const UPSTREAMS = ['pay-payments', 'pay-merchants', 'pay-schedules', 'pay-webhooks', 'pay-ledger', 'pay-settlement'] as const;
export type UpstreamName = (typeof UPSTREAMS)[number];

/**
 * Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos ni
 * para destinos (regla 90.3.4). Los límites de velocidad sí tienen valor por defecto: son perillas operativas, no secretos.
 */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string; readonly schema?: string };
  /** Opcional: sin NATS el servicio arranca, pero la réplica de claves no se actualiza y `/health/ready` lo informa. */
  readonly natsUrl?: string;
  /** `sandbox` solo acepta claves `test`; `live` solo claves `live` (D-26). */
  readonly payMode: 'sandbox' | 'live';
  readonly redisUrl: string;
  readonly upstreams: Readonly<Record<UpstreamName, string>>;
  readonly upstreamTimeoutMs: number;
  readonly breaker: { readonly failureThreshold: number; readonly cooldownMs: number };
  readonly rateLimit: { readonly prefix: string; readonly windowSeconds: number; readonly ipPerWindow: number; readonly keyPerWindow: number; readonly authFailuresPerWindow: number };
  /** Saltos de proxy confiables para leer la IP del cliente (`X-Forwarded-For`). 0 = no confiar en esa cabecera. */
  readonly trustProxyHops: number;
  readonly maxBodyBytes: number;
  readonly replica: { readonly stream: string; readonly subjectPrefix: string; readonly durable: string };
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

function schemaName(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`DB_SCHEMA inválido: ${value}`);
  return value;
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const payMode = required(env, 'PAY_MODE');
  if (payMode !== 'sandbox' && payMode !== 'live') throw new Error(`PAY_MODE inválido: ${payMode} (sandbox | live)`);
  const upstreams = Object.fromEntries(
    UPSTREAMS.map((name) => {
      const variable = `UPSTREAM_${name.toUpperCase().replace(/-/g, '_')}_URL`;
      const url = required(env, variable);
      if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(url)) throw new Error(`${variable} inválida: debe ser http(s)://host[:puerto] sin ruta`);
      return [name, url];
    }),
  ) as Record<UpstreamName, string>;
  return {
    port: integer(env, 'PORT', 3101, 1, 65535),
    logLevel: env.LOG_LEVEL ?? 'info',
    db: {
      host: required(env, 'DB_HOST'),
      port: integer(env, 'DB_PORT', 5432, 1, 65535),
      name: required(env, 'DB_NAME'),
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
      ...(env.DB_SCHEMA ? { schema: schemaName(env.DB_SCHEMA) } : {}),
    },
    ...(env.NATS_URL ? { natsUrl: env.NATS_URL } : {}),
    payMode,
    redisUrl: required(env, 'REDIS_URL'),
    upstreams,
    upstreamTimeoutMs: integer(env, 'UPSTREAM_TIMEOUT_MS', 15_000, 100, 120_000),
    breaker: { failureThreshold: integer(env, 'BREAKER_FAILURE_THRESHOLD', 5, 1, 100_000), cooldownMs: integer(env, 'BREAKER_COOLDOWN_MS', 10_000, 100, 600_000) },
    rateLimit: {
      prefix: env.RATE_LIMIT_PREFIX ?? 'pay-edge:rl',
      windowSeconds: integer(env, 'RATE_LIMIT_WINDOW_SECONDS', 60, 1, 3600),
      ipPerWindow: integer(env, 'RATE_LIMIT_IP_PER_WINDOW', 300, 1, 1_000_000),
      keyPerWindow: integer(env, 'RATE_LIMIT_KEY_PER_WINDOW', 600, 1, 1_000_000),
      authFailuresPerWindow: integer(env, 'RATE_LIMIT_AUTH_FAILURES_PER_WINDOW', 30, 1, 100_000),
    },
    trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 0, 0, 10),
    maxBodyBytes: integer(env, 'MAX_BODY_BYTES', 1_048_576, 1024, 10_485_760),
    replica: {
      stream: env.REPLICA_STREAM ?? 'PAY_MERCHANTS',
      subjectPrefix: env.REPLICA_SUBJECT_PREFIX ?? 'pay-merchants',
      durable: env.REPLICA_DURABLE ?? 'pay-edge-replica',
    },
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
