import { createSign, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type ContractValidator, type IsolatedDatabase, createIsolatedDatabase, loadContract } from '@pay/testing';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { PG_POOL } from '../../src/database.module';
import { ProblemFilter } from '../../src/problem.filter';
import { BatchService } from '../../src/settlement/batch.service';
import { SettlementConsumers } from '../../src/settlement/consumers';
import { AccountingExportService } from '../../src/settlement/export.service';
import { NettingService } from '../../src/settlement/netting.service';
import { JwtOperatorVerifier } from '../../src/settlement/operator-token';
import { PayoutService, type RailMap } from '../../src/settlement/payout.service';
import { CONNECTORS_PORT, type ConnectorsPort, LEDGER_PORT, type LedgerPort, OPERATOR_VERIFIER, PAYOUT_RAILS } from '../../src/settlement/ports';
import { AcquirerSettlementRail, BankTransferRail } from '../../src/settlement/rails';
import { ReconciliationService } from '../../src/settlement/reconciliation.service';
import { SETTLEMENT_CONFIG, type SettlementConfig } from '../../src/settlement/settlement.config';
import { SettlementController } from '../../src/settlement/settlement.controller';
import { FakeConnectors, FakeLedger } from './fakes';

/** Ruta desde la raíz del repo. Jest corre con `cwd` = la carpeta del servicio (services/pay-settlement). */
export const repoPath = (...segments: string[]) => resolve(process.cwd(), '../..', ...segments);

export const unique = () => randomBytes(6).toString('hex');
export const merchantId = () => `mc_${unique()}k3m9`;
export const key = () => `key-${randomBytes(8).toString('hex')}`;

const PRIVATE_KEY = (globalThis as { __OPERATOR_TEST_PRIVATE_KEY__?: string }).__OPERATOR_TEST_PRIVATE_KEY__;
export const ISSUER = process.env.OPERATOR_TOKEN_ISSUER as string;
export const AUDIENCE = process.env.OPERATOR_TOKEN_AUDIENCE as string;

const b64 = (value: object | Buffer) => Buffer.from(value instanceof Buffer ? value : JSON.stringify(value)).toString('base64url');

/** Token de operador de prueba firmado con la clave privada de la corrida (RS256). `overrides` rompe lo que cada prueba necesite. */
export function operatorToken(
  roles: string[],
  options: { sub?: string; claims?: Record<string, unknown>; header?: Record<string, unknown>; privateKey?: string; now?: number } = {},
): string {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const header = b64({ alg: 'RS256', typ: 'JWT', ...options.header });
  const payload = b64({ iss: ISSUER, aud: AUDIENCE, sub: options.sub ?? 'op_maria01', roles, iat: now, exp: now + 300, ...options.claims });
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign((options.privateKey ?? PRIVATE_KEY) as string);
  return `${header}.${payload}.${b64(signature)}`;
}

export function testConfig(overrides: Partial<SettlementConfig> = {}): SettlementConfig {
  return {
    ledgerUrl: 'http://ledger.test',
    connectorsUrl: 'http://connectors.test',
    httpTimeoutMs: 2000,
    transferConnector: 'mock',
    mode: 'bank',
    payMode: 'sandbox',
    cutoffWeekday: 1,
    tzOffsetMinutes: -240,
    releaseDays: 7,
    payoutHoldTtlSeconds: 7 * 86_400,
    sweepIntervalMs: 0,
    stuckAfterMs: 0,
    statementFormats: {},
    operator: { publicKeyPem: (process.env.OPERATOR_TOKEN_PUBLIC_KEY as string).replace(/\\n/g, '\n'), issuer: ISSUER, audience: AUDIENCE },
    ...overrides,
  };
}

export interface SettlementTestContext {
  readonly app: INestApplication;
  readonly db: IsolatedDatabase;
  readonly ledger: FakeLedger;
  readonly connectors: FakeConnectors;
  readonly settlementContract: ContractValidator;
  readonly publicContract: ContractValidator;
  readonly payouts: PayoutService;
  readonly batches: BatchService;
  readonly netting: NettingService;
  readonly reconciliation: ReconciliationService;
  readonly exports: AccountingExportService;
  readonly consumers: SettlementConsumers;
  readonly config: SettlementConfig;
  readonly baseUrl: string;
  /** Cliente HTTP con la identidad de servicio ya puesta. */
  as(service: string): {
    get(path: string): request.Test;
    post(path: string, body?: object): request.Test;
  };
  /** Filas de `outbox_events` de un tipo, ya parseadas. */
  events(type: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * Arma pay-settlement real (controladores, servicios, Postgres de verdad en un esquema propio, outbox/inbox/idempotencia reales) con
 * los dobles DECLARADOS del ledger y de los conectores. Los eventos se quedan en el outbox: las pruebas los leen de ahí.
 */
export async function createSettlementContext(options: { config?: Partial<SettlementConfig>; ledger?: FakeLedger; connectors?: FakeConnectors; connectorsPort?: ConnectorsPort; ledgerPort?: LedgerPort } = {}): Promise<SettlementTestContext> {
  const db = await createIsolatedDatabase([
    repoPath('services/pay-settlement/sql/001_settlement.sql'),
    repoPath('contracts/packages/outbox/sql/001_outbox_inbox.sql'),
    repoPath('contracts/packages/idempotency/sql/001_idempotency_keys.sql'),
  ]);
  const config = testConfig(options.config);
  const ledger = options.ledger ?? new FakeLedger();
  const connectors = options.connectors ?? new FakeConnectors();
  // `connectorsPort` pone el cliente HTTP REAL en lugar del doble en memoria (para probar contra un servidor HTTP).
  const port: ConnectorsPort = options.connectorsPort ?? connectors;
  const rails: RailMap = { bank_transfer: new BankTransferRail(port), acquirer_settlement: new AcquirerSettlementRail() };
  const moduleRef = await Test.createTestingModule({
    controllers: [SettlementController],
    providers: [
      { provide: PG_POOL, useValue: db.pool },
      { provide: SETTLEMENT_CONFIG, useValue: config },
      { provide: LEDGER_PORT, useValue: options.ledgerPort ?? ledger },
      { provide: CONNECTORS_PORT, useValue: port },
      { provide: PAYOUT_RAILS, useValue: rails },
      { provide: OPERATOR_VERIFIER, useValue: new JwtOperatorVerifier(config.operator.publicKeyPem, config.operator.issuer, config.operator.audience) },
      ServiceIdentityGuard,
      SettlementConsumers,
      PayoutService,
      NettingService,
      BatchService,
      ReconciliationService,
      AccountingExportService,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  return {
    app,
    baseUrl,
    db,
    ledger,
    connectors,
    config,
    settlementContract: await loadContract(repoPath('contracts/openapi/internal-settlement-v1.yaml')),
    publicContract: await loadContract(repoPath('contracts/openapi/public-v1.yaml')),
    payouts: moduleRef.get(PayoutService),
    batches: moduleRef.get(BatchService),
    netting: moduleRef.get(NettingService),
    reconciliation: moduleRef.get(ReconciliationService),
    exports: moduleRef.get(AccountingExportService),
    consumers: moduleRef.get(SettlementConsumers),
    as: (service) => ({
      get: (path) => request(baseUrl).get(path).set('x-service-id', service),
      post: (path, body) => request(baseUrl).post(path).set('x-service-id', service).send(body ?? {}),
    }),
    async events(type) {
      const { rows } = await db.pool.query('SELECT envelope FROM outbox_events WHERE type = $1 ORDER BY created_at, id', [type]);
      return rows.map((r) => r.envelope as Record<string, unknown>);
    },
    async close() {
      await moduleRef.get(ReconciliationService).idle();
      await app.close();
      await db.drop();
    },
  };
}

/**
 * Divergencias CONOCIDAS entre el contrato y el servicio: el contrato declara 400 para un cuerpo o consulta inválidos pero el catálogo de
 * `@pay/problem` no tiene un código de 400 genérico, así que el servicio responde 422 `validation_failed` (como el ledger). Ver PROPUESTAS.md.
 */
export const KNOWN_422_GAPS = new Set(['POST /payouts', 'GET /payouts', 'GET /payouts/{id}', 'POST /batches', 'GET /batches', 'POST /reconciliation_runs', 'GET /reconciliation_runs/{id}', 'GET /reconciliation_exceptions', 'POST /reconciliation_exceptions/{id}/resolve']);

/** Valida la respuesta contra el contrato y la devuelve, para que cada prueba la use ya validada. */
export function checked(ctx: SettlementTestContext, method: string, path: string, res: request.Response, contract: ContractValidator = ctx.settlementContract): request.Response {
  const input = { method, path: path.split('?')[0], status: res.status, body: res.body };
  const errors = contract.validateResponse(input);
  if (errors.length === 0) return res;
  const template = contract.operations().find((op) => {
    const [m, t] = op.split(' ');
    return m === method.toUpperCase() && new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(input.path);
  });
  if (res.status === 422 && template && KNOWN_422_GAPS.has(template) && contract.validateResponse({ ...input, status: 400 }).length === 0) return res;
  // El contrato no declara 503 (el ledger o un conector caído): se valida como el `ServerError` que sí declara. Ver PROPUESTAS.md.
  if (res.status === 503 && res.body?.code === 'ledger_unavailable' && contract.validateResponse({ ...input, status: 500 }).length === 0) return res;
  contract.assertResponse(input);
  return res;
}

/** Instante local (UTC−4) de un lunes de corte, a medianoche, como el servicio lo calcula. */
export const cutoffInstant = (date: string) => new Date(`${date}T04:00:00.000Z`);
