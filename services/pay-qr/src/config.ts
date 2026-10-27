/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
  /** Opcional: sin NATS el servicio arranca pero el relé del outbox no publica y `/health/ready` lo informa. */
  readonly natsUrl?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number(env.PORT ?? 3104);
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
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
