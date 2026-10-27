/** Configuración del servicio. Falla al arrancar si falta algo obligatorio: sin valores por defecto para secretos (regla 90.3.4). */
export interface UpstreamConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
}

export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly db: { readonly host: string; readonly port: number; readonly name: string; readonly user: string; readonly password: string };
  /** Opcional: sin NATS el servicio arranca pero el relé del outbox no publica y `/health/ready` lo informa. */
  readonly natsUrl?: string;
  /** Si es `false` no se crean los consumidores JetStream (pruebas que arrancan la app contra una base sin esquema). */
  readonly consumeEvents: boolean;
  readonly temporal: {
    readonly address: string;
    readonly namespace: string;
    readonly taskQueue: string;
    /** Ruta del módulo de workflows para el bundler del worker (fuente en pruebas, `dist/` en producción). */
    readonly workflowsPath?: string;
    /** Si es `false` el proceso no ejecuta el worker (solo el cliente), para separar API y workers. */
    readonly runWorker: boolean;
  };
  readonly upstream: { readonly risk: UpstreamConfig; readonly connectors: UpstreamConfig; readonly ledger: UpstreamConfig };
  readonly policy: {
    /**
     * Política ante un riesgo caído (P3.H2.M2): desde este monto, sin respuesta del servicio de riesgo el cobro se rechaza
     * (`risk_unavailable`). Debajo, pasa solo si `riskAllowBelowThreshold`. Sin valor inventado (Q-08): por defecto 0, es decir,
     * SIEMPRE rechaza (fail-closed total) hasta que el negocio fije un monto.
     */
    readonly riskFailClosedThresholdMinor: bigint;
    readonly riskAllowBelowThreshold: boolean;
    /** Cuánto espera `POST /payment_intents` a que el cobro quede en `requires_action` o terminal antes de responder. */
    readonly createWaitMs: number;
    readonly circuit: { readonly failureThreshold: number; readonly resetAfterMs: number };
    /** Cuánto se espera el estado final de un reembolso `pending` antes de darlo por fallido (conciliación lo reabre). */
    readonly refundWaitMs: number;
    /** Cada cuánto se consulta el estado del cargo al conector mientras se espera al pagador (eventos perdidos, REQ-P3-7). */
    readonly inquiryIntervalMs: number;
    /** Política de las activities de Temporal: el tope de reintentos decide cuándo se compensa y se falla el cobro. */
    readonly activity: { readonly timeoutMs: number; readonly maxAttempts: number; readonly initialMs: number; readonly maxMs: number; readonly slowRetryMs: number };
    /** Vigencia de la retención de un reembolso en el ledger. Larga a propósito: si vence, el dinero del comercio se libera. */
    readonly refundHoldSeconds: number;
    /**
     * Cuenta recaudadora para transferencia bancaria. Sin ella el medio no está disponible (no se inventan datos bancarios,
     * T-03): la creación responde 422 `payment_method_unavailable`.
     */
    readonly bankTransfer?: { readonly bankName: string; readonly accountHolder: string; readonly accountNumber: string };
  };
  /** Temas de los eventos que se consumen (configurables para aislar las pruebas). */
  readonly subjects: { readonly connectorStatus: string; readonly merchantEvents: string; readonly feeSchedule: string };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} inválido: ${raw}`);
  return value;
}

function upstream(env: NodeJS.ProcessEnv, prefix: string, timeoutMs: number): UpstreamConfig {
  const baseUrl = required(env, `${prefix}_URL`).replace(/\/+$/, '');
  return { baseUrl, timeoutMs: int(env, `${prefix}_TIMEOUT_MS`, timeoutMs) };
}

/** Los tres datos de la cuenta recaudadora van juntos o no va ninguno. */
function bankTransfer(env: NodeJS.ProcessEnv): { bankTransfer?: { bankName: string; accountHolder: string; accountNumber: string } } {
  const bankName = env.BANK_TRANSFER_BANK_NAME;
  const accountHolder = env.BANK_TRANSFER_ACCOUNT_HOLDER;
  const accountNumber = env.BANK_TRANSFER_ACCOUNT_NUMBER;
  const present = [bankName, accountHolder, accountNumber].filter((v) => v !== undefined && v !== '').length;
  if (present === 0) return {};
  if (present !== 3 || !bankName || !accountHolder || !accountNumber) throw new Error('BANK_TRANSFER_BANK_NAME, BANK_TRANSFER_ACCOUNT_HOLDER y BANK_TRANSFER_ACCOUNT_NUMBER van juntas');
  return { bankTransfer: { bankName, accountHolder, accountNumber } };
}

/** Lee y valida el entorno. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const port = Number(env.PORT ?? 3102);
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
    consumeEvents: env.CONSUME_EVENTS !== 'false',
    temporal: {
      address: env.TEMPORAL_ADDRESS ?? '127.0.0.1:54233',
      namespace: env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: env.TEMPORAL_TASK_QUEUE ?? 'pay-payments',
      ...(env.TEMPORAL_WORKFLOWS_PATH ? { workflowsPath: env.TEMPORAL_WORKFLOWS_PATH } : {}),
      runWorker: env.TEMPORAL_RUN_WORKER !== 'false',
    },
    upstream: {
      risk: upstream(env, 'RISK', 300), // objetivo p99 < 300 ms del contrato de riesgo
      connectors: upstream(env, 'CONNECTORS', 5000),
      ledger: upstream(env, 'LEDGER', 5000),
    },
    policy: {
      riskFailClosedThresholdMinor: BigInt(env.RISK_FAIL_CLOSED_THRESHOLD_MINOR ?? '0'),
      riskAllowBelowThreshold: env.RISK_ALLOW_BELOW_THRESHOLD === 'true',
      createWaitMs: int(env, 'CREATE_WAIT_MS', 8000),
      circuit: { failureThreshold: int(env, 'CIRCUIT_FAILURE_THRESHOLD', 5), resetAfterMs: int(env, 'CIRCUIT_RESET_MS', 10_000) },
      refundWaitMs: int(env, 'REFUND_WAIT_MS', 30_000),
      inquiryIntervalMs: int(env, 'STATUS_INQUIRY_MS', 30_000),
      activity: {
        timeoutMs: int(env, 'ACTIVITY_TIMEOUT_MS', 10_000),
        maxAttempts: int(env, 'ACTIVITY_MAX_ATTEMPTS', 6),
        initialMs: int(env, 'ACTIVITY_INITIAL_MS', 500),
        maxMs: int(env, 'ACTIVITY_MAX_MS', 5000),
        // Tras agotar los reintentos con un resultado AMBIGUO se escala a una persona y se sigue reintentando, despacio, con la misma clave.
        slowRetryMs: int(env, 'ACTIVITY_SLOW_RETRY_MS', 30_000),
      },
      refundHoldSeconds: int(env, 'REFUND_HOLD_SECONDS', 604_800),
      ...bankTransfer(env),
    },
    subjects: {
      connectorStatus: env.SUBJECT_CONNECTOR_STATUS ?? 'pay-connectors.connector.transaction.status_changed',
      merchantEvents: env.SUBJECT_MERCHANT_EVENTS ?? 'pay-merchants.merchant.*',
      feeSchedule: env.SUBJECT_FEE_SCHEDULE ?? 'pay-merchants.fee_schedule.published',
    },
  };
}

export const SERVICE_CONFIG = Symbol('SERVICE_CONFIG');
