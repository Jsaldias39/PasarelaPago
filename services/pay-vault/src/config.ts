/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
  /** Opcional: sin NATS el servicio arranca pero el relé del outbox no publica y `/health/ready` lo informa. */
  readonly natsUrl?: string;
  /**
   * Quién custodia la tarjeta. Hoy solo existe `fake` (un DOBLE en memoria, P3.H3.M2); `hyperswitch-card-vault` o los campos
   * alojados del banco llegan cuando se resuelvan P3.H3.M1 y D-17. Sin valor, el servicio NO arranca: no hay bóveda por defecto.
   */
  readonly backend: 'fake';
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function backendOf(env: NodeJS.ProcessEnv): 'fake' {
  const backend = required(env, 'VAULT_BACKEND');
  if (backend !== 'fake') throw new Error(`VAULT_BACKEND inválido: ${backend} (hoy solo existe «fake»)`);
  // El doble guarda tarjetas en memoria y las entrega tal cual: jamás con dinero real.
  if ((env.PAY_MODE ?? 'sandbox') === 'live') throw new Error('VAULT_BACKEND=fake no se permite con PAY_MODE=live');
  return 'fake';
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number(env.PORT ?? 3111);
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
    backend: backendOf(env),
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
