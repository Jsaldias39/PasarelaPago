import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { type IsolatedDatabase, createIsolatedDatabase, loadContract, type ContractValidator } from '@pay/testing';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/database.module';
import { logSink, type LogTarget } from '../../src/logging.sink';
import { FsObjectStore, OBJECT_STORE } from '../../src/kyc/object-store';
import { OPERATOR_AUTHENTICATOR } from '../../src/operators/operator-auth';
import { OperatorAuthenticatorDouble } from '../doubles/operator-auth.double';
import { loadEventContract } from './event-contract';

// En modo ESM no hay __dirname: Jest corre con cwd = la carpeta del servicio.
const SERVICE = process.cwd();
const REPO = resolve(SERVICE, '../..');
export const SQL = [
  join(REPO, 'contracts/packages/outbox/sql/001_outbox_inbox.sql'),
  join(REPO, 'contracts/packages/idempotency/sql/001_idempotency_keys.sql'),
  join(SERVICE, 'sql/001_merchants.sql'),
];
export const CONTRACT_PUBLIC = join(REPO, 'contracts/openapi/public-v1.yaml');
export const CONTRACT_BACKOFFICE = join(REPO, 'contracts/openapi/internal-merchants-v1.yaml');
export const EVENTS = join(REPO, 'contracts/asyncapi/merchants-schedules.yaml');

export interface TestContext {
  app: INestApplication;
  db: IsolatedDatabase;
  publicContract: ContractValidator;
  backofficeContract: ContractValidator;
  events: Awaited<ReturnType<typeof loadEventContract>>;
  logs: string[];
  server: ReturnType<INestApplication['getHttpServer']>;
  store: FsObjectStore;
  close(): Promise<void>;
}

/** App completa contra Postgres REAL (esquema propio) con el [DOBLE] de operadores. Captura los logs. */
export async function createTestContext(options: { realOperatorAuthenticator?: boolean } = {}): Promise<TestContext> {
  const db = await createIsolatedDatabase(SQL);
  const logs: string[] = [];
  const capture: LogTarget = { write: (chunk) => (logs.push(String(chunk)), true) };
  const previous = logSink.target;
  logSink.target = capture;
  const store = new FsObjectStore(process.env.KYC_STORE_DIR as string);
  const builder = Test.createTestingModule({ imports: [AppModule] })
    // La app cierra su pool al apagarse; el aislamiento de la base lo cierra después. Un `end` doble lanza, así que se lo anulamos a la app.
    .overrideProvider(PG_POOL).useValue(new Proxy(db.pool, { get: (target, prop) => (prop === 'end' ? async () => undefined : (typeof target[prop as keyof typeof target] === 'function' ? (target[prop as keyof typeof target] as (...a: unknown[]) => unknown).bind(target) : target[prop as keyof typeof target])) }))
    .overrideProvider(OBJECT_STORE).useValue(store);
  // Con `realOperatorAuthenticator` se usa el que trae el servicio por defecto (niega a todos), no el [DOBLE].
  if (!options.realOperatorAuthenticator) builder.overrideProvider(OPERATOR_AUTHENTICATOR).useValue(new OperatorAuthenticatorDouble());
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.init();
  return {
    app,
    db,
    publicContract: await loadContract(CONTRACT_PUBLIC),
    backofficeContract: await loadContract(CONTRACT_BACKOFFICE),
    events: await loadEventContract(EVENTS),
    logs,
    server: app.getHttpServer(),
    store,
    async close() {
      await app.close();
      logSink.target = previous;
      await db.drop();
    },
  };
}
