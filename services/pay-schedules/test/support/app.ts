import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { type ContractValidator, type IsolatedDatabase, createIsolatedDatabase, loadContract } from '@pay/testing';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/database.module';
import { ExecutorService } from '../../src/executor/executor.service';
import { logSink, type LogTarget } from '../../src/logging.sink';
import { CLOCK } from '../../src/mandates/mandates.service';
import { SERVICE_CONFIG, loadConfig } from '../../src/config';
import { HttpLedgerClient, LEDGER_CLIENT, type LedgerClient } from '../../src/ledger/ledger.client';
import { SCHEDULE_SETTINGS, loadScheduleSettings, type ScheduleSettings } from '../../src/settings';
import { startLedgerDouble, type LedgerDouble } from '../doubles/ledger.double';
import { loadEventContract } from './event-contract';

// En modo ESM no hay __dirname: Jest corre con cwd = la carpeta del servicio.
const SERVICE = process.cwd();
const REPO = resolve(SERVICE, '../..');
// El DDL lo genera el modelo (D-18) y se vendoriza con `node scripts/p5-vendor-model-sql.mjs`; trae también las tablas técnicas (outbox, inbox, idempotencia).
export const SQL = [join(SERVICE, 'sql/ddl.sql')];
export const CONTRACT_PUBLIC = join(REPO, 'contracts/openapi/public-v1.yaml');
export const CONTRACT_LEDGER = join(REPO, 'contracts/openapi/internal-ledger-v1.yaml');
export const EVENTS = join(REPO, 'contracts/asyncapi/merchants-schedules.yaml');

export interface TestContext {
  app: INestApplication;
  db: IsolatedDatabase;
  publicContract: ContractValidator;
  events: Awaited<ReturnType<typeof loadEventContract>>;
  ledger: LedgerDouble;
  executor: ExecutorService;
  logs: string[];
  server: ReturnType<INestApplication['getHttpServer']>;
  /** Reloj del servicio: las pruebas lo mueven para ejercitar fechas y reintentos sin esperar. */
  clock: { now: Date };
  close(): Promise<void>;
}

export interface TestOptions {
  /** URL de un NATS REAL: enciende el consumidor de `merchant.*` y el relé del outbox. Por defecto, sin NATS. */
  natsUrl?: string;
  /** Envuelve al cliente real del libro mayor (por ejemplo, para quitarle el modo). */
  wrapLedger?: (inner: LedgerClient) => LedgerClient;
  settings?: Partial<ScheduleSettings>;
  /** Hora inicial del reloj; por defecto 2026-03-10 18:00 UTC = 14:00 en La Paz. */
  now?: Date;
}

/** Comercio de AloVida (beneficiario de las comisiones) de las pruebas. */
export const PLATFORM_MERCHANT = 'mc_platformsynthetic01';

/** App completa contra Postgres REAL (esquema propio) y un [DOBLE] declarado de pay-ledger. */
export async function createTestContext(options: TestOptions = {}): Promise<TestContext> {
  const db = await createIsolatedDatabase(SQL);
  const ledger = await startLedgerDouble(CONTRACT_LEDGER);
  const logs: string[] = [];
  const capture: LogTarget = { write: (chunk) => (logs.push(String(chunk)), true) };
  const previous = logSink.target;
  logSink.target = capture;
  const clock = { now: options.now ?? new Date('2026-03-10T18:00:00Z') };
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(new Proxy(db.pool, { get: (target, prop) => (prop === 'end' ? async () => undefined : (typeof target[prop as keyof typeof target] === 'function' ? (target[prop as keyof typeof target] as (...a: unknown[]) => unknown).bind(target) : target[prop as keyof typeof target])) }))
    .overrideProvider(SCHEDULE_SETTINGS)
    .useValue({ ...loadScheduleSettings(), ledgerUrl: ledger.url, platformMerchantId: PLATFORM_MERCHANT, ...options.settings })
    .overrideProvider(CLOCK)
    .useValue(() => new Date(clock.now));
  if (options.natsUrl) builder.overrideProvider(SERVICE_CONFIG).useValue({ ...loadConfig(), natsUrl: options.natsUrl });
  if (options.wrapLedger) {
    const wrap = options.wrapLedger;
    builder.overrideProvider(LEDGER_CLIENT).useFactory({ factory: (settings: ScheduleSettings) => wrap(new HttpLedgerClient(settings)), inject: [SCHEDULE_SETTINGS] });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.init();
  return {
    app,
    db,
    publicContract: await loadContract(CONTRACT_PUBLIC),
    events: await loadEventContract(EVENTS),
    ledger,
    executor: app.get(ExecutorService),
    logs,
    server: app.getHttpServer(),
    clock,
    async close() {
      await app.close();
      logSink.target = previous;
      await db.drop();
      await ledger.close();
    },
  };
}
