import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { loadConfig, type ServiceConfig } from '../../src/config';
import { createDeps, type Deps } from '../../src/deps';
import { TemporalOrchestrator } from '../../src/payments/orchestrator';
import { PaymentsService } from '../../src/payments/payments.service';
import { replicasRepo } from '../../src/persistence/replicas.repo';
import { startPaymentsWorker, type PaymentsWorker } from '../../src/temporal/worker';
import { ConnectorsDouble } from '../doubles/connectors.double';
import { LedgerDouble } from '../doubles/ledger.double';
import { RiskDouble } from '../doubles/risk.double';
import { WalletAuthorizerDouble } from '../doubles/wallet.double';

// Temporal escribe cada cambio de estado del worker en INFO: en las pruebas solo importan los avisos.
try {
  Runtime.install({ logger: new DefaultLogger('WARN') });
} catch {
  // Ya instalado en este proceso (otro archivo de pruebas): sirve el mismo.
}

const root = process.cwd(); // las pruebas corren desde services/pay-payments (Jest ESM no tiene __dirname)
export const SQL_FILES = [
  path.join(root, 'sql/001_payments.sql'),
  path.join(root, '../../contracts/packages/idempotency/sql/001_idempotency_keys.sql'),
  path.join(root, '../../contracts/packages/outbox/sql/001_outbox_inbox.sql'),
];
export const WORKFLOWS_PATH = path.join(root, 'src/temporal/workflows.ts');

export const MC = 'mc_merchant00001';
export const MC2 = 'mc_merchant00002';
export const QR_FEES = [{ channel: 'qr', percent: '2.5', fixed_minor: 50 }, { channel: 'card', percent: '3' }, { channel: 'bank_transfer', percent: '1' }, { channel: 'wallet', percent: '1.5' }];

export interface Stack {
  readonly db: IsolatedDatabase;
  readonly config: ServiceConfig;
  readonly deps: Deps;
  readonly service: PaymentsService;
  readonly orchestrator: TemporalOrchestrator;
  readonly risk: RiskDouble;
  readonly connectors: ConnectorsDouble;
  readonly ledger: LedgerDouble;
  readonly wallet: WalletAuthorizerDouble;
  readonly worker: PaymentsWorker | undefined;
  stop(): Promise<void>;
}

export interface StackOptions {
  readonly env?: Record<string, string>;
  /** Sin worker en proceso (la prueba de caída arranca el suyo como proceso aparte). */
  readonly inProcessWorker?: boolean;
  readonly taskQueue?: string;
}

/** Arma el servicio contra Postgres, Temporal y NATS reales y los dobles de riesgo, conectores y ledger. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const [db, risk, connectors, ledger] = [await createIsolatedDatabase(SQL_FILES), new RiskDouble(), new ConnectorsDouble(), new LedgerDouble()];
  const [riskUrl, connectorsUrl, ledgerUrl] = await Promise.all([risk.start(), connectors.start(), ledger.start()]);
  const wallet = new WalletAuthorizerDouble();
  const taskQueue = options.taskQueue ?? `p3-${randomBytes(4).toString('hex')}`;
  const config = loadConfig({
    ...process.env,
    RISK_URL: riskUrl,
    CONNECTORS_URL: connectorsUrl,
    LEDGER_URL: ledgerUrl,
    TEMPORAL_TASK_QUEUE: taskQueue,
    CIRCUIT_FAILURE_THRESHOLD: '1000',
    CREATE_WAIT_MS: '6000',
    STATUS_INQUIRY_MS: '1000',
    ACTIVITY_TIMEOUT_MS: '8000',
    ACTIVITY_MAX_ATTEMPTS: '4',
    ACTIVITY_INITIAL_MS: '200',
    ACTIVITY_MAX_MS: '800',
    ...options.env,
  });
  const deps = createDeps(db.pool as never, config, { wallet });
  const worker = options.inProcessWorker === false ? undefined : await startPaymentsWorker(deps, { workflowsPath: WORKFLOWS_PATH });
  const orchestrator = await TemporalOrchestrator.connect({ address: config.temporal.address, namespace: config.temporal.namespace, taskQueue });
  const service = new PaymentsService(deps, orchestrator);
  return {
    db, config, deps, service, orchestrator, risk, connectors, ledger, wallet, worker,
    async stop() {
      await worker?.shutdown();
      await orchestrator.close();
      await Promise.all([risk.stop(), connectors.stop(), ledger.stop()]);
      await db.drop();
    },
  };
}

export async function seedMerchant(stack: Pick<Stack, 'deps'>, merchantId: string, status: 'active' | 'suspended' | 'pending' | 'closed' = 'active', channels = QR_FEES): Promise<void> {
  await replicasRepo.upsertMerchantStatus(stack.deps.pool, merchantId, status, new Date());
  await replicasRepo.upsertFeeSchedule(stack.deps.pool, { merchantId, version: 1, currency: 'BOB', channels, effectiveFrom: new Date(Date.now() - 86_400_000), effectiveTo: null });
}

export async function waitFor<T>(probe: () => Promise<T | undefined | false | null>, timeoutMs = 15_000, label = 'condición'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Se agotó la espera de: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

export const key = (): string => `k-${randomBytes(8).toString('hex')}`;
