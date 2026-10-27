/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
  /** Opcional: sin NATS el servicio arranca pero el relé del outbox no publica y `/health/ready` lo informa. */
  readonly natsUrl?: string;
  /** Modo de DESPLIEGUE (D-26): `sandbox` solo atiende claves `test`, `live` solo claves `live` (D-28). Obligatorio, sin valor por defecto. */
  readonly mode: 'sandbox' | 'live';
  readonly qr: {
    /** GUID del operador en la plantilla de cuenta del QR. Lo asigna el banco o el regulador: sin valor por defecto. */
    readonly accountGuid: string;
  };
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

/** Un GUID con estos rótulos es el de pruebas: emitir con él bajo `live` daría un QR que no cobra a nadie y parece real. */
const PLACEHOLDER_GUID = /provisional|sandbox|e2e|simulad/i;

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number(env.PORT ?? 3104);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT inválido: ${env.PORT}`);
  const dbPort = Number(env.DB_PORT ?? 5432);
  if (!Number.isInteger(dbPort)) throw new Error(`DB_PORT inválido: ${env.DB_PORT}`);
  const mode = parseMode(env.PAY_MODE);
  const accountGuid = required(env, 'QR_ACCOUNT_GUID');
  if (mode === 'live' && PLACEHOLDER_GUID.test(accountGuid)) {
    throw new Error('PAY_MODE=live no admite un QR_ACCOUNT_GUID provisional o de sandbox: poné el GUID que asigna el banco o el regulador');
  }
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
    mode,
    qr: { accountGuid },
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
