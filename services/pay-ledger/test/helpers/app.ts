import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { type ContractValidator, type IsolatedDatabase, createIsolatedDatabase, loadContract } from '@pay/testing';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { PG_POOL } from '../../src/database.module';
import { AccountRegistry } from '../../src/ledger/account-registry';
import { HoldService } from '../../src/ledger/hold.service';
import { InvariantService } from '../../src/ledger/invariant.service';
import { LedgerController, PublicLedgerController } from '../../src/ledger/ledger.controller';
import { loadLedgerConfig } from '../../src/ledger/ledger.config';
import { LedgerService } from '../../src/ledger/ledger.service';
import { TB_ENGINE, TigerBeetleEngine } from '../../src/ledger/tb-engine';
import { ProblemFilter } from '../../src/problem.filter';

/** Ruta desde la raíz del repo. Jest corre con `cwd` = la carpeta del servicio (services/pay-ledger). */
export const repoPath = (...segments: string[]) => resolve(process.cwd(), '../..', ...segments);

export interface LedgerTestContext {
  readonly app: INestApplication;
  readonly db: IsolatedDatabase;
  readonly engine: TigerBeetleEngine;
  readonly contract: ContractValidator;
  readonly baseUrl: string;
  readonly invariant: InvariantService;
  readonly holds: HoldService;
  /** Cliente HTTP con la identidad de servicio ya puesta. */
  as(service: string): {
    get(path: string): request.Test;
    post(path: string, body?: object): request.Test;
  };
  close(): Promise<void>;
}

/** Identificadores únicos por prueba: TigerBeetle es compartido por todas las corridas y no se limpia. */
export const unique = () => randomBytes(6).toString('hex');
export const merchantId = () => `mc_${unique()}k3m9`;
export const businessRef = (op = 'capture') => `pi_${unique()}x7q2:${op}`;

/**
 * Arma el ledger real (controladores, servicios, TigerBeetle de verdad, Postgres de verdad en un esquema propio) sin el
 * resto de la plantilla. Los eventos se quedan en el outbox: las pruebas los leen de ahí.
 */
export async function createLedgerContext(): Promise<LedgerTestContext> {
  const db = await createIsolatedDatabase([
    repoPath('services/pay-ledger/sql/001_ledger.sql'),
    repoPath('contracts/packages/outbox/sql/001_outbox_inbox.sql'),
    repoPath('contracts/packages/idempotency/sql/001_idempotency_keys.sql'),
  ]);
  const config = loadLedgerConfig();
  const engine = new TigerBeetleEngine(config.tb);
  const moduleRef = await Test.createTestingModule({
    controllers: [LedgerController, PublicLedgerController],
    providers: [
      { provide: PG_POOL, useValue: db.pool },
      { provide: TB_ENGINE, useValue: engine },
      ServiceIdentityGuard,
      AccountRegistry,
      LedgerService,
      HoldService,
      InvariantService,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  const contract = await loadContract(repoPath('contracts/openapi/internal-ledger-v1.yaml'));
  return {
    app,
    baseUrl,
    db,
    engine,
    contract,
    invariant: moduleRef.get(InvariantService),
    holds: moduleRef.get(HoldService),
    as: (service) => ({
      get: (path) => request(baseUrl).get(path).set('x-service-id', service),
      post: (path, body) => request(baseUrl).post(path).set('x-service-id', service).send(body ?? {}),
    }),
    async close() {
      await app.close();
      engine.destroy();
      await db.drop();
    },
  };
}

/**
 * Divergencias CONOCIDAS entre el contrato y el servicio: el contrato declara 400 para un cuerpo, ruta o consulta inválidos pero el
 * catálogo de `@pay/problem` no tiene un código de 400 genérico, así que el servicio responde 422 `validation_failed` (como en el resto
 * del contrato). Ver PROPUESTAS.md #4. El cuerpo se valida igual como `Problem`; la lista es exacta (otra prueba la sostiene) para que
 * una divergencia nueva falle y una corregida obligue a borrar la entrada.
 */
export const KNOWN_422_GAPS = new Set(['GET /balances', 'GET /statements', 'POST /holds/{id}/void', 'GET /transactions/{business_ref}', 'GET /holds/{id}']);
export const usedGaps = new Set<string>();

/** Valida la respuesta contra el contrato y la devuelve, para que cada prueba la use ya validada. */
export function checked(ctx: LedgerTestContext, method: string, path: string, res: request.Response): request.Response {
  const input = { method, path: path.split('?')[0], status: res.status, body: res.body };
  const errors = ctx.contract.validateResponse(input);
  if (errors.length === 0) return res;
  const template = ctx.contract.operations().find((op) => {
    const [m, t] = op.split(' ');
    return m === method.toUpperCase() && new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(input.path);
  });
  if (res.status === 422 && template && KNOWN_422_GAPS.has(template) && ctx.contract.validateResponse({ ...input, status: 400 }).length === 0) {
    usedGaps.add(template);
    return res;
  }
  ctx.contract.assertResponse(input);
  return res;
}
