import { generateKeyPairSync, randomBytes } from 'node:crypto';

/** Los 11 servicios de producto, en un orden estable. */
export const SERVICES = [
  'pay-ledger',
  'pay-risk',
  'pay-qr',
  'pay-vault',
  'pay-merchants',
  'pay-webhooks',
  'pay-connectors',
  'pay-payments',
  'pay-settlement',
  'pay-schedules',
  'pay-edge',
] as const;
export type ServiceName = (typeof SERVICES)[number];

/** Quién tiene que estar sano antes de arrancar a quién (el arranque no depende de que el otro responda, pero el orden sí ayuda). */
export const DEPENDS_ON: Record<ServiceName, readonly ServiceName[]> = {
  'pay-ledger': [],
  'pay-risk': [],
  'pay-qr': [],
  'pay-vault': [],
  'pay-merchants': [],
  'pay-webhooks': [],
  'pay-connectors': ['pay-qr'],
  'pay-payments': ['pay-risk', 'pay-connectors', 'pay-ledger', 'pay-vault'],
  'pay-settlement': ['pay-ledger', 'pay-connectors'],
  'pay-schedules': ['pay-ledger'],
  'pay-edge': ['pay-payments', 'pay-merchants', 'pay-schedules', 'pay-webhooks', 'pay-ledger', 'pay-settlement'],
};

/** Streams de JetStream que crean los servicios (se borran al empezar y al terminar para no heredar estado de otra corrida). */
export const SERVICE_STREAMS = ['PAY_EDGE', 'PAY_PAYMENTS', 'PAY_CONNECTORS', 'PAY_QR', 'PAY_LEDGER', 'PAY_SETTLEMENT', 'PAY_MERCHANTS', 'PAY_RISK', 'PAY_SCHEDULES', 'PAY_WEBHOOKS', 'PAY_VAULT'] as const;

export interface Infra {
  readonly postgres: { readonly host: string; readonly port: number; readonly adminUrl: string };
  readonly natsUrl: string;
  readonly redisUrl: string;
  readonly temporalAddress: string;
  readonly watchmanUrl: string;
  readonly tigerbeetleAddress: string;
}

export const DEFAULT_INFRA: Infra = {
  postgres: { host: '127.0.0.1', port: 54321, adminUrl: process.env.PAY_E2E_ADMIN_URL ?? 'postgres://postgres:pay@127.0.0.1:54321' },
  natsUrl: process.env.PAY_E2E_NATS_URL ?? 'nats://127.0.0.1:54222',
  redisUrl: process.env.PAY_E2E_REDIS_URL ?? 'redis://127.0.0.1:54379',
  temporalAddress: process.env.PAY_E2E_TEMPORAL_ADDRESS ?? '127.0.0.1:54233',
  watchmanUrl: process.env.PAY_E2E_WATCHMAN_URL ?? 'http://127.0.0.1:54084',
  tigerbeetleAddress: process.env.PAY_E2E_TB_ADDRESS ?? '127.0.0.1:54300',
};

/** Secretos SINTÉTICOS de una corrida: se generan al vuelo y no sirven en ningún otro entorno. */
export interface RunSecrets {
  readonly payerHashKey: string;
  readonly webhooksKek: string;
  readonly connectorMockWebhookSecret: string;
  readonly operatorPublicKeyPem: string;
  readonly operatorPrivateKeyPem: string;
}

export function generateSecrets(): RunSecrets {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    payerHashKey: `e2e-${randomBytes(24).toString('hex')}`,
    webhooksKek: randomBytes(32).toString('base64'),
    connectorMockWebhookSecret: `whsec_${randomBytes(32).toString('base64')}`,
    operatorPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    operatorPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export interface EnvContext {
  readonly runId: string;
  readonly ports: Record<ServiceName, number>;
  readonly infra: Infra;
  readonly secrets: RunSecrets;
  /** Puerto reservado para el receptor de webhooks de la prueba (el servicio lo recibe como destino de sandbox permitido). */
  readonly receiverPort: number;
  /** Archivo con la CA del receptor de prueba. */
  readonly receiverCaFile: string;
  readonly kycDir: string;
  /** Escalera de reintentos de webhooks (ms); por defecto la de producción. */
  readonly webhookRetryScheduleMs?: string;
}

const url = (ctx: EnvContext, name: ServiceName) => `http://127.0.0.1:${ctx.ports[name]}`;

/** Variables comunes a todos: puerto, base propia (un rol y una base por servicio), NATS y modo de despliegue. */
function common(ctx: EnvContext, name: ServiceName): Record<string, string> {
  const short = name.replace('pay-', '');
  return {
    PORT: String(ctx.ports[name]),
    LOG_LEVEL: 'info',
    DB_HOST: ctx.infra.postgres.host,
    DB_PORT: String(ctx.infra.postgres.port),
    DB_NAME: `pay_${short}`,
    DB_USER: `pay_${short}`,
    DB_PASSWORD: `dev_only_${short}`,
    NATS_URL: ctx.infra.natsUrl,
    PAY_MODE: 'sandbox',
  };
}

/** Variables propias de cada servicio, tomadas de su `.env.example` y de su configuración (ver e2e/ARNES en docs/trabajo/ola-2/P1). */
export function envFor(ctx: EnvContext, name: ServiceName): Record<string, string> {
  const base = common(ctx, name);
  const { infra, secrets } = ctx;
  switch (name) {
    case 'pay-ledger':
      return { ...base, TB_ADDRESS: infra.tigerbeetleAddress, TB_CLUSTER_ID: '0', LEDGER_ID_NAMESPACE: ctx.runId.slice(0, 40) };
    case 'pay-risk':
      return { ...base, WATCHMAN_URL: infra.watchmanUrl, SANCTIONS_DENY_SCORE: '0.80', SANCTIONS_REVIEW_SCORE: '0.60', PAYER_HASH_KEY: secrets.payerHashKey };
    case 'pay-qr':
      return { ...base, QR_ACCOUNT_GUID: 'e2e.sandbox.guid' };
    case 'pay-vault':
      return { ...base, VAULT_BACKEND: 'fake' };
    case 'pay-merchants':
      return { ...base, KYC_STORE_DIR: ctx.kycDir };
    case 'pay-webhooks':
      return {
        ...base,
        WEBHOOKS_SECRET_KEK: secrets.webhooksKek,
        WEBHOOKS_SANDBOX_TARGETS: `127.0.0.1:${ctx.receiverPort}`,
        WEBHOOKS_SANDBOX_CA_FILE: ctx.receiverCaFile,
        WEBHOOKS_POLL_INTERVAL_MS: '100',
        WEBHOOKS_RETRY_JITTER_PERCENT: '0',
        ...(ctx.webhookRetryScheduleMs ? { WEBHOOKS_RETRY_SCHEDULE_MS: ctx.webhookRetryScheduleMs } : {}),
      };
    case 'pay-connectors':
      return {
        ...base,
        PAY_QR_URL: url(ctx, 'pay-qr'),
        PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET: secrets.connectorMockWebhookSecret,
        BANK_TRANSFER_BANK_NAME: 'BANCO SIMULADO (SANDBOX)',
        BANK_TRANSFER_ACCOUNT_HOLDER: 'ALOVIDA PAY (SANDBOX)',
        BANK_TRANSFER_ACCOUNT_NUMBER: 'SANDBOX-0000-0001',
      };
    case 'pay-payments':
      return {
        ...base,
        RISK_URL: url(ctx, 'pay-risk'),
        CONNECTORS_URL: url(ctx, 'pay-connectors'),
        LEDGER_URL: url(ctx, 'pay-ledger'),
        VAULT_URL: url(ctx, 'pay-vault'),
        TEMPORAL_ADDRESS: infra.temporalAddress,
        TEMPORAL_NAMESPACE: 'default',
        TEMPORAL_TASK_QUEUE: `pay-payments-${ctx.runId}`,
        TEMPORAL_RUN_WORKER: 'true',
        RISK_FAIL_CLOSED_THRESHOLD_MINOR: '0',
        RISK_ALLOW_BELOW_THRESHOLD: 'false',
      };
    case 'pay-settlement':
      return {
        ...base,
        LEDGER_URL: url(ctx, 'pay-ledger'),
        CONNECTORS_URL: url(ctx, 'pay-connectors'),
        OPERATOR_TOKEN_PUBLIC_KEY: secrets.operatorPublicKeyPem.replace(/\n/g, '\\n'),
        OPERATOR_TOKEN_ISSUER: 'e2e-issuer',
        OPERATOR_TOKEN_AUDIENCE: 'pay-settlement',
        SETTLEMENT_MODE: 'bank',
        SETTLEMENT_TRANSFER_CONNECTOR: 'mock',
      };
    case 'pay-schedules':
      return { ...base, LEDGER_URL: url(ctx, 'pay-ledger'), RETRY_DELAYS_SECONDS: '3600,7200,14400' };
    case 'pay-edge':
      return {
        ...base,
        REDIS_URL: infra.redisUrl,
        RATE_LIMIT_PREFIX: `e2e:${ctx.runId}`,
        UPSTREAM_PAY_PAYMENTS_URL: url(ctx, 'pay-payments'),
        UPSTREAM_PAY_MERCHANTS_URL: url(ctx, 'pay-merchants'),
        UPSTREAM_PAY_SCHEDULES_URL: url(ctx, 'pay-schedules'),
        UPSTREAM_PAY_WEBHOOKS_URL: url(ctx, 'pay-webhooks'),
        UPSTREAM_PAY_LEDGER_URL: url(ctx, 'pay-ledger'),
        UPSTREAM_PAY_SETTLEMENT_URL: url(ctx, 'pay-settlement'),
      };
  }
}
