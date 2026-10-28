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
import { LEDGER_CONFIG, loadLedgerConfig } from '../../src/ledger/ledger.config';
import { LedgerService } from '../../src/ledger/ledger.service';
import { TB_ENGINE, TigerBeetleEngine } from '../../src/ledger/tb-engine';
import { ProblemFilter } from '../../src/problem.filter';

/** Ruta desde la raíz del repo. Jest corre con `cwd` = la carpeta del servicio (services/pay-ledger). */
export const repoPath = (...segments: string[]) => resolve(process.cwd(), '../..', ...segments);

export type Deployment = 'sandbox' | 'live';

export interface LedgerTestContext {
  readonly app: INestApplication;
  readonly db: IsolatedDatabase;
  readonly engine: TigerBeetleEngine;
  readonly contract: ContractValidator;
  /** Despliegue `sandbox` (opera con claves `test`). */
  readonly baseUrl: string;
  /** Despliegue `live` (opera con claves `live`), sobre la MISMA base y el MISMO TigerBeetle: así se prueba el aislamiento entre modos. */
  readonly liveBaseUrl: string;
  readonly invariant: InvariantService;
  readonly holds: HoldService;
  /**
   * Cliente HTTP con la identidad de servicio ya puesta. `mode` por defecto `test` (D-28); `null` no manda la cabecera. Va al despliegue que
   * corresponde a la clave (`test` → sandbox, `live` → live) salvo que se pida otro con `deployment` (para probar el cruce).
   */
  as(service: string, mode?: string | null, deployment?: Deployment): {
    get(path: string): request.Test;
    post(path: string, body?: object): request.Test;
  };
  close(): Promise<void>;
}

const withMode = (req: request.Test, mode: string | null): request.Test => (mode === null ? req : req.set('x-pay-mode', mode));

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
    repoPath('services/pay-ledger/sql/ddl.sql'), // vendorizado del modelo (D-18): trae también las tablas de outbox, inbox e idempotencia
  ]);
  const config = loadLedgerConfig();
  const engine = new TigerBeetleEngine(config.tb);
  // Dos despliegues (PAY_MODE sandbox y live) sobre la misma base y el mismo motor, como si compartieran el almacenamiento.
  const build = async (payMode: Deployment) => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LedgerController, PublicLedgerController],
      providers: [
        { provide: PG_POOL, useValue: db.pool },
        { provide: TB_ENGINE, useValue: engine },
        { provide: LEDGER_CONFIG, useValue: { ...config, payMode } },
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
    return { moduleRef, app, baseUrl: await app.getUrl() };
  };
  const sandbox = await build('sandbox');
  const live = await build('live');
  const contract = await loadContract(repoPath('contracts/openapi/internal-ledger-v1.yaml'));
  const urlOf = (mode: string | null, deployment?: Deployment) => ((deployment ?? (mode === 'live' ? 'live' : 'sandbox')) === 'live' ? live.baseUrl : sandbox.baseUrl);
  return {
    app: sandbox.app,
    baseUrl: sandbox.baseUrl,
    liveBaseUrl: live.baseUrl,
    db,
    engine,
    contract,
    invariant: sandbox.moduleRef.get(InvariantService),
    holds: sandbox.moduleRef.get(HoldService),
    // Por defecto `test` (D-28); `null` no manda la cabecera, para probar el 403.
    as: (service, mode = 'test', deployment) => ({
      get: (path) => withMode(request(urlOf(mode, deployment)).get(path).set('x-service-id', service), mode),
      post: (path, body) => withMode(request(urlOf(mode, deployment)).post(path).set('x-service-id', service).send(body ?? {}), mode),
    }),
    async close() {
      await sandbox.app.close();
      await live.app.close();
      engine.destroy();
      await db.drop();
    },
  };
}

/** Valida la respuesta contra el contrato y la devuelve, para que cada prueba la use ya validada. */
export function checked(ctx: LedgerTestContext, method: string, path: string, res: request.Response): request.Response {
  const input = { method, path: path.split('?')[0], status: res.status, body: res.body };
  ctx.contract.assertResponse(input);
  return res;
}
