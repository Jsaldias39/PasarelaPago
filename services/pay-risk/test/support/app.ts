import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { type IsolatedDatabase, type ContractValidator, createIsolatedDatabase, loadContract } from '@pay/testing';
import { AppModule } from '../../src/app.module';
import { PG_POOL } from '../../src/database.module';
import { logSink, type LogTarget } from '../../src/logging.sink';
import { OPERATOR_AUTHENTICATOR } from '../../src/operators/operator-auth';
import { CLOCK } from '../../src/rules/rule-sets.service';
import { RISK_SETTINGS, loadRiskSettings, type RiskSettings } from '../../src/settings';
import { OperatorAuthenticatorDouble } from '../doubles/operator-auth.double';

// En modo ESM no hay __dirname: Jest corre con cwd = la carpeta del servicio.
const SERVICE = process.cwd();
const REPO = resolve(SERVICE, '../..');
export const SQL = [join(REPO, 'contracts/packages/idempotency/sql/001_idempotency_keys.sql'), join(SERVICE, 'sql/001_risk.sql')];
export const CONTRACT_RISK = join(REPO, 'contracts/openapi/internal-risk-v1.yaml');
export const CONTRACT_RULE_SETS = join(REPO, 'docs/trabajo/ola-1/P5/propuestas/internal-risk-rule-sets-v1.yaml');

export interface TestContext {
  app: INestApplication;
  db: IsolatedDatabase;
  contract: ContractValidator;
  ruleSetsContract: ContractValidator;
  logs: string[];
  server: ReturnType<INestApplication['getHttpServer']>;
  /** Reloj del servicio: las pruebas lo mueven para ejercitar ventanas y horarios sin esperar. */
  clock: { now: Date };
  close(): Promise<void>;
}

export interface TestOptions {
  settings?: Partial<RiskSettings>;
  realOperatorAuthenticator?: boolean;
  /** Hora UTC inicial del reloj; por defecto, 2026-03-10 18:00 UTC = 14:00 en La Paz (dentro de horario hábil). */
  now?: Date;
}

/** App completa contra Postgres REAL (esquema propio) y el Watchman REAL del stack local, salvo que `settings.watchmanUrl` apunte a un [DOBLE]. */
export async function createTestContext(options: TestOptions = {}): Promise<TestContext> {
  const db = await createIsolatedDatabase(SQL);
  const logs: string[] = [];
  const capture: LogTarget = { write: (chunk) => (logs.push(String(chunk)), true) };
  const previous = logSink.target;
  logSink.target = capture;
  const clock = { now: options.now ?? new Date('2026-03-10T18:00:00Z') };
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(new Proxy(db.pool, { get: (target, prop) => (prop === 'end' ? async () => undefined : (typeof target[prop as keyof typeof target] === 'function' ? (target[prop as keyof typeof target] as (...a: unknown[]) => unknown).bind(target) : target[prop as keyof typeof target])) }))
    .overrideProvider(RISK_SETTINGS)
    .useValue({ ...loadRiskSettings(), ...options.settings })
    .overrideProvider(CLOCK)
    .useValue(() => new Date(clock.now));
  if (!options.realOperatorAuthenticator) builder.overrideProvider(OPERATOR_AUTHENTICATOR).useValue(new OperatorAuthenticatorDouble());
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.init();
  return {
    app,
    db,
    contract: await loadContract(CONTRACT_RISK),
    ruleSetsContract: await loadContract(CONTRACT_RULE_SETS),
    logs,
    server: app.getHttpServer(),
    clock,
    async close() {
      await app.close();
      logSink.target = previous;
      await db.drop();
    },
  };
}
