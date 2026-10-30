// REVISION-DINERO F-D1 · guardianes de solo-agregar en `/health/ready` de pay-settlement. Los triggers `<tabla>_immutable` y `<tabla>_no_truncate` solo existen en bases creadas con el DDL
// nuevo (`sandbox-migrate.mjs` no toca una base que ya tiene tablas). Aquí se verifica que el servicio LO VE: `checks.append_only_guards: { ok, missing }`; bajo PAY_MODE=live `ok:false`
// ⇒ 503 (no listo); en sandbox sigue listo pero `ok:false` es visible y se avisa en el log (una vez por cambio). Postgres real, esquema descartable; la base «vieja» se simula
// quitando los triggers (el procedimiento con el DDL viejo de git está en docs/runbooks/sandbox-a-produccion.md). Tres niveles: correcto, límite, inválido.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { APPEND_ONLY_TABLES, checkAppendOnlyGuards } from '../src/append-only-guards';
import { PG_POOL } from '../src/database.module';
import { HealthController } from '../src/health.controller';
import { SETTLEMENT_CONFIG } from '../src/settlement/settlement.config';

const DDL = join(process.cwd(), 'sql/ddl.sql');
const TABLES = ['settlement_audit'];
const ALL_GUARDS = TABLES.flatMap((table) => [`${table}_immutable`, `${table}_no_truncate`]).sort();

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await createIsolatedDatabase([DDL]);
});
afterAll(async () => db.drop());

const q = (sql: string) => db.pool.query(sql);
/** Una base creada con el DDL VIEJO: sin ningún guardián. */
const dropAllGuards = async () => {
  for (const table of TABLES) {
    await q(`DROP TRIGGER IF EXISTS ${table}_immutable ON ${table}`);
    await q(`DROP TRIGGER IF EXISTS ${table}_no_truncate ON ${table}`);
  }
};
/** El procedimiento del runbook: reaplicar el DDL idempotente. */
const reapplyDdl = async () => {
  await q(readFileSync(DDL, 'utf8'));
};
const sorted = (names: string[]) => [...names].sort();

describe('checkAppendOnlyGuards · qué ve el servicio en pg_trigger', () => {
  beforeEach(reapplyDdl);

  it('correcto · la lista de tablas es exactamente la de las tablas de solo-agregar del servicio', () => {
    expect([...APPEND_ONLY_TABLES].sort()).toEqual([...TABLES].sort());
  });

  it('correcto · base creada con el DDL nuevo ⇒ ok:true, missing vacío', async () => {
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: true, missing: [] });
  });

  it('inválido · base creada con el DDL VIEJO (sin guardianes) ⇒ ok:false y missing nombra los 2 triggers', async () => {
    await dropAllGuards();
    const report = await checkAppendOnlyGuards(db.pool);
    expect(report.ok).toBe(false);
    expect(sorted(report.missing)).toEqual(ALL_GUARDS);
  });

  it('límite · reaplicar el DDL idempotente (el procedimiento del runbook) a la base vieja ⇒ ok:true; reaplicarlo otra vez no cambia nada', async () => {
    await dropAllGuards();
    expect((await checkAppendOnlyGuards(db.pool)).ok).toBe(false);
    await reapplyDdl();
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: true, missing: [] });
    await reapplyDdl();
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: true, missing: [] });
  });

  it('límite · UN solo guardián apagado (DISABLE TRIGGER) o solo para réplica (ENABLE REPLICA) ⇒ solo ese falta', async () => {
    const [table] = TABLES as [string, ...string[]];
    await q(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_immutable`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: [`${table}_immutable`] });
    await q(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${table}_immutable`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: [`${table}_immutable`] });
    await q(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_immutable`);
    expect((await checkAppendOnlyGuards(db.pool)).ok).toBe(true);
  });

  it('inválido · un trigger con el NOMBRE correcto pero el evento equivocado (solo UPDATE, o a nivel de sentencia) no cuenta', async () => {
    const [table] = TABLES as [string, ...string[]];
    await q(`DROP TRIGGER ${table}_immutable ON ${table}`);
    await q(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: [`${table}_immutable`] });
  });

  it('inválido · un trigger con el nombre correcto que llama a OTRA función no cuenta', async () => {
    const [table] = TABLES as [string, ...string[]];
    await q(`CREATE OR REPLACE FUNCTION noop_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$`);
    await q(`DROP TRIGGER ${table}_no_truncate ON ${table}`);
    await q(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION noop_trigger()`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: [`${table}_no_truncate`] });
  });

  it('inválido · una tabla que no existe en la base ⇒ sus guardianes faltan (no es un error)', async () => {
    const report = await checkAppendOnlyGuards(db.pool, [...TABLES, 'tabla_que_no_existe']);
    expect(report).toEqual({ ok: false, missing: ['tabla_que_no_existe_immutable', 'tabla_que_no_existe_no_truncate'] });
  });

  it('inválido · si la consulta falla (no se puede verificar) es FAIL-CLOSED: ok:false con todos los guardianes como faltantes', async () => {
    const broken = { query: async () => { throw new Error('conexión caída'); } };
    const report = await checkAppendOnlyGuards(broken as never);
    expect(report.ok).toBe(false);
    expect(sorted(report.missing)).toEqual(ALL_GUARDS);
  });
});

describe('GET /health/ready · checks.append_only_guards y el modo de despliegue', () => {
  const boot = async (payMode: 'sandbox' | 'live') => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [{ provide: PG_POOL, useValue: db.pool }, { provide: SETTLEMENT_CONFIG, useValue: { payMode, mode: 'bank', transferConnector: 'mock' } }],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };
  const withConfig = (payMode: 'sandbox' | 'live') => (async () => boot(payMode));
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  let error: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(async () => {
    await reapplyDdl();
    warn = jest.spyOn(Logger.prototype, 'warn') as unknown as typeof warn;
    error = jest.spyOn(Logger.prototype, 'error') as unknown as typeof error;
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });
  const guardLogs = (spy: typeof warn) => spy.mock.calls.filter(([payload]: unknown[]) => (payload as { event?: string } | null)?.event === 'append_only_guards_missing');

  it('correcto · live con los guardianes completos ⇒ 200 y checks.append_only_guards = { ok:true, missing:[] }', async () => {
    const app = await withConfig('live')();
    try {
      const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(response.body.checks).toEqual({ append_only_guards: { ok: true, missing: [] } });
      expect(response.body.status).toBe('ok');
      expect(guardLogs(warn)).toHaveLength(0);
      expect(guardLogs(error)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('inválido · live con una base VIEJA ⇒ 503 (no listo), el campo lista lo que falta y el log sale como error; reaplicar el DDL ⇒ 200 otra vez', async () => {
    const app = await withConfig('live')();
    try {
      await dropAllGuards();
      const down = await request(app.getHttpServer()).get('/health/ready').expect(503);
      expect(down.body.checks.append_only_guards.ok).toBe(false);
      expect(sorted(down.body.checks.append_only_guards.missing)).toEqual(ALL_GUARDS);
      expect(down.body.status).toBe('error');
      expect(guardLogs(error)).toHaveLength(1);
      expect(guardLogs(warn)).toHaveLength(0);
      await request(app.getHttpServer()).get('/health/ready').expect(503); // sigue en rojo, pero el aviso no se repite en cada sondeo
      expect(guardLogs(error)).toHaveLength(1);
      await reapplyDdl();
      const up = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(up.body.checks).toEqual({ append_only_guards: { ok: true, missing: [] } });
    } finally {
      await app.close();
    }
  });

  it('límite · sandbox con una base vieja ⇒ sigue LISTO (200) pero ok:false es visible y se avisa con un warn (una sola vez por cambio)', async () => {
    const app = await withConfig('sandbox')();
    try {
      await dropAllGuards();
      const first = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(first.body.checks.append_only_guards.ok).toBe(false);
      expect(sorted(first.body.checks.append_only_guards.missing)).toEqual(ALL_GUARDS);
      expect(first.body.status).toBe('ok');
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(guardLogs(warn)).toHaveLength(1);
      expect(guardLogs(error)).toHaveLength(0);
      expect(JSON.stringify(guardLogs(warn)[0])).not.toMatch(/postgres|password|DB_PASSWORD/i);
    } finally {
      await app.close();
    }
  });

  it('límite · UN guardián apagado en live ⇒ 503 con solo ese nombre en missing', async () => {
    const app = await withConfig('live')();
    try {
      const [table] = TABLES as [string, ...string[]];
      await q(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_no_truncate`);
      const response = await request(app.getHttpServer()).get('/health/ready').expect(503);
      expect(response.body.checks).toEqual({ append_only_guards: { ok: false, missing: [`${table}_no_truncate`] } });
    } finally {
      await app.close();
    }
  });
});
