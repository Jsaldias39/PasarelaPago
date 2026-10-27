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
  /** URL base de `pay-mockbank` (banco simulado de la capa sandbox, D-26). Con ella, el conector `mock` y el de transferencias hablan con ese servicio en vez de usar el banco en memoria. Solo sandbox. */
  readonly mockbankUrl?: string;
  readonly mockbankTimeoutMs: number;
  readonly poller: { readonly intervalMs: number; readonly minAgeMs: number; readonly baseBackoffMs: number; readonly maxBackoffMs: number; readonly batchSize: number };
  readonly health: { readonly intervalMs: number; readonly downAfterFailures: number };
  /** Reintentos de la MISMA llamada ante un timeout ambiguo (con la misma referencia) antes de responder 502. */
  /** Candados de envío: conexiones dedicadas (tope de envíos simultáneos distintos) y cuánto se espera una conexión antes de responder 409. */
  readonly lockPool: { readonly max: number; readonly waitMs: number };
  /** Cuenta recaudadora que se le muestra al pagador de una transferencia. Sin configurar (T-03: no existe la cuenta) las instrucciones salen sin estos datos. */
  readonly bankTransferAccount?: { readonly bankName: string; readonly accountHolder: string; readonly accountNumber: string };
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

/** Cuenta SINTÉTICA de sandbox: el rótulo SANDBOX va en cada dato para que nadie la tome por una cuenta real (T-03). */
export const SANDBOX_BANK_ACCOUNT = {
  bankName: 'BANCO SIMULADO (SANDBOX)',
  accountHolder: 'ALOVIDA PAY (SANDBOX)',
  accountNumber: 'SANDBOX-0000-0001',
} as const;

const SANDBOX_LABEL = /sandbox|simulad/i;

/**
 * `BANK_TRANSFER_BANK_NAME`, `BANK_TRANSFER_ACCOUNT_HOLDER` y `BANK_TRANSFER_ACCOUNT_NUMBER`: datos de la empresa (no del pagador), no secretos.
 * - sandbox: cada variable es opcional; la que falta toma el valor SINTÉTICO declarado en `SANDBOX_BANK_ACCOUNT` (lleva el rótulo SANDBOX).
 * - live: los tres o ninguno. Mientras no exista la cuenta recaudadora (T-03) no se inventa nada: sin las tres, las instrucciones salen solo con la
 *   referencia y `pay-payments` responde `422 payment_method_unavailable`. Una cuenta a medias, o con el rótulo del simulador, no arranca.
 * Un valor presente se valida igual en los dos modos.
 */
function bankAccount(env: NodeJS.ProcessEnv, mode: 'sandbox' | 'live'): { bankTransferAccount?: { bankName: string; accountHolder: string; accountNumber: string } } {
  const given = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const bankName = given('BANK_TRANSFER_BANK_NAME');
  const accountHolder = given('BANK_TRANSFER_ACCOUNT_HOLDER');
  const accountNumber = given('BANK_TRANSFER_ACCOUNT_NUMBER');
  const present = [bankName, accountHolder, accountNumber].filter((v) => v !== undefined).length;
  if (mode === 'live') {
    if (present === 0) return {};
    if (present !== 3) throw new Error('BANK_TRANSFER_BANK_NAME, BANK_TRANSFER_ACCOUNT_HOLDER y BANK_TRANSFER_ACCOUNT_NUMBER van los tres o ninguno');
  }
  const account = {
    bankName: bankName ?? SANDBOX_BANK_ACCOUNT.bankName,
    accountHolder: accountHolder ?? SANDBOX_BANK_ACCOUNT.accountHolder,
    accountNumber: accountNumber ?? SANDBOX_BANK_ACCOUNT.accountNumber,
  };
  for (const [name, value] of [['BANK_TRANSFER_BANK_NAME', account.bankName], ['BANK_TRANSFER_ACCOUNT_HOLDER', account.accountHolder]] as const) {
    if (value.length > 100) throw new Error(`${name} inválido (1 a 100 caracteres)`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{3,39}$/.test(account.accountNumber)) throw new Error('BANK_TRANSFER_ACCOUNT_NUMBER inválido (4 a 40 caracteres: letras, números, espacio, punto o guion)');
  return { bankTransferAccount: account };
}

/**
 * Bajo `PAY_MODE=live` el servicio se niega a arrancar si el entorno trae algún doble de sandbox (D-26): el secreto del simulador `mock`,
 * su bomba de callbacks o una cuenta bancaria con el rótulo del simulador. Un despliegue live con el simulador "a medias" es un cobro de
 * mentira que parece real; mejor que no arranque.
 */
function rejectDoublesInLive(env: NodeJS.ProcessEnv): void {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('PAY_SECRET_CONNECTOR_MOCK_') && value !== undefined && value !== '') found.push(name);
  }
  if (env.MOCK_PUMP_INTERVAL_MS !== undefined && env.MOCK_PUMP_INTERVAL_MS !== '') found.push('MOCK_PUMP_INTERVAL_MS');
  for (const name of ['MOCKBANK_URL', 'MOCKBANK_TIMEOUT_MS']) if (env[name] !== undefined && env[name] !== '') found.push(name);
  for (const name of ['BANK_TRANSFER_BANK_NAME', 'BANK_TRANSFER_ACCOUNT_HOLDER', 'BANK_TRANSFER_ACCOUNT_NUMBER']) {
    const value = env[name];
    if (value !== undefined && SANDBOX_LABEL.test(value)) found.push(name);
  }
  if (found.length > 0) throw new Error(`PAY_MODE=live no admite conectores ni dobles de sandbox; quitá del entorno: ${found.join(', ')}`);
}

/** `MOCKBANK_URL`: una URL http(s) válida. Bajo `live` ya la rechaza `rejectDoublesInLive`. */
function mockbank(env: NodeJS.ProcessEnv): { mockbankUrl?: string } {
  const raw = env.MOCKBANK_URL;
  if (raw === undefined || raw === '') return {};
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('MOCKBANK_URL inválida (tiene que ser una URL http o https)');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('MOCKBANK_URL inválida (tiene que ser una URL http o https)');
  return { mockbankUrl: raw };
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
  const mode = parseMode(env.PAY_MODE);
  if (mode === 'live') rejectDoublesInLive(env);
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
    ...(env.PAY_QR_URL ? { qrUrl: env.PAY_QR_URL } : {}),
    ...mockbank(env),
    mockbankTimeoutMs: integer(env, 'MOCKBANK_TIMEOUT_MS', 5_000, 1),
    poller: {
      intervalMs: integer(env, 'POLLER_INTERVAL_MS', 15_000),
      minAgeMs: integer(env, 'POLLER_MIN_AGE_MS', 30_000),
      baseBackoffMs: integer(env, 'POLLER_BASE_BACKOFF_MS', 30_000, 1),
      maxBackoffMs: integer(env, 'POLLER_MAX_BACKOFF_MS', 600_000, 1),
      batchSize: integer(env, 'POLLER_BATCH_SIZE', 50, 1),
    },
    health: { intervalMs: integer(env, 'HEALTH_INTERVAL_MS', 10_000), downAfterFailures: integer(env, 'HEALTH_DOWN_AFTER_FAILURES', 3, 1) },
    lockPool: { max: integer(env, 'LOCK_POOL_MAX', 20, 1), waitMs: integer(env, 'LOCK_WAIT_MS', 15_000, 1) },
    ...bankAccount(env, mode),
    timeoutRetries: integer(env, 'TIMEOUT_RETRIES', 2),
    callbackRatePerMinute: integer(env, 'CALLBACK_RATE_PER_MINUTE', 600, 1),
    mockPumpIntervalMs: integer(env, 'MOCK_PUMP_INTERVAL_MS', 1_000),
    reconcile: { intervalMs: integer(env, 'RECONCILE_INTERVAL_MS', 300_000), lookbackHours: integer(env, 'RECONCILE_LOOKBACK_HOURS', 48, 1) },
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
