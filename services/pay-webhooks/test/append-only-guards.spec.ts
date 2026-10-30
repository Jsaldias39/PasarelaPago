import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { checkAppendOnlyGuards } from '../src/append-only-guards';
import { SQL_FILES, startWebhooks, type WebhooksHarness } from './harness';

/**
 * RE-REVISION-DINERO F-D1 para pay-webhooks: `/health/ready` informa `checks.append_only_guards: { ok, missing }` consultando `pg_trigger`.
 * Bajo `PAY_MODE=live` un guardián ausente ⇒ 503; en sandbox sigue listo con `ok:false` visible. Contra Postgres real, con el DDL nuevo y con una base creada
 * con el DDL ANTERIOR (sin los triggers).
 */
const GUARDS = ['webhook_delivery_attempts_immutable', 'webhook_delivery_attempts_no_truncate'];
const TABLE = 'webhook_delivery_attempts';

/** El DDL de antes de ola 5: el mismo archivo SIN los dos triggers (y sin su `DROP TRIGGER`), escrito en un archivo temporal. */
function legacyDdlFiles(): string[] {
  const ddl = readFileSync(SQL_FILES[0], 'utf8');
  const legacy = ddl
    .split('\n')
    .filter((line) => !/webhook_delivery_attempts_(immutable|no_truncate)/.test(line))
    .join('\n');
  if (legacy === ddl || /CREATE TRIGGER/.test(legacy)) throw new Error('el DDL anterior no se pudo reconstruir');
  const file = join(mkdtempSync(join(tmpdir(), 'fb-legacy-ddl-')), 'ddl.sql');
  writeFileSync(file, legacy);
  return [file];
}

describe('checkAppendOnlyGuards (pg_trigger real)', () => {
  let db: IsolatedDatabase | undefined;
  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  it('CORRECTO: con el DDL vigente están los dos guardianes ⇒ ok:true, missing vacío', async () => {
    db = await createIsolatedDatabase(SQL_FILES);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: true, missing: [] });
  });

  it('INVÁLIDO: una base creada con el DDL anterior (sin triggers) ⇒ ok:false y faltan los dos', async () => {
    db = await createIsolatedDatabase(legacyDdlFiles());
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: GUARDS });
  });

  it('LÍMITE: uno solo ausente ⇒ falta ese; uno deshabilitado (DISABLE TRIGGER) cuenta como ausente; reaplicar el DDL idempotente lo repone', async () => {
    db = await createIsolatedDatabase(SQL_FILES);
    await db.pool.query(`DROP TRIGGER webhook_delivery_attempts_no_truncate ON ${TABLE}`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: ['webhook_delivery_attempts_no_truncate'] });
    await db.pool.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER webhook_delivery_attempts_immutable`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: GUARDS });
    // procedimiento del runbook: reaplicar el DDL del servicio (idempotente: DROP TRIGGER IF EXISTS + CREATE)
    await db.pool.query(readFileSync(SQL_FILES[0], 'utf8'));
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: true, missing: [] });
  });

  it('INVÁLIDO: un trigger con el nombre esperado pero OTRA función o OTRO evento no cuenta (no es el guardián)', async () => {
    db = await createIsolatedDatabase(SQL_FILES);
    await db.pool.query(`DROP TRIGGER webhook_delivery_attempts_immutable ON ${TABLE}`);
    await db.pool.query('CREATE FUNCTION fb_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$');
    await db.pool.query(`CREATE TRIGGER webhook_delivery_attempts_immutable BEFORE INSERT ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION fb_noop()`);
    expect(await checkAppendOnlyGuards(db.pool)).toEqual({ ok: false, missing: ['webhook_delivery_attempts_immutable'] });
  });

  it('INVÁLIDO: si la consulta no puede hacerse (base inaccesible) es fail-closed: ok:false con todo faltante, no un verde falso', async () => {
    const broken = { query: async () => Promise.reject(new Error('sin base')) } as never;
    expect(await checkAppendOnlyGuards(broken)).toEqual({ ok: false, missing: GUARDS });
  });
});

describe.each([
  ['sandbox', 200],
  ['live', 503],
] as const)('GET /health/ready con PAY_MODE=%s y una base SIN guardianes (DDL anterior)', (payMode, expectedStatus) => {
  let h: WebhooksHarness;
  beforeAll(async () => {
    h = await startWebhooks({
      sqlFiles: legacyDdlFiles(),
      env: payMode === 'live' ? { PAY_MODE: 'live', WEBHOOKS_RETRY_SCHEDULE_MS: '', WEBHOOKS_ENGINE: 'svix', WEBHOOKS_SVIX_URL: 'https://svix.interno.example', WEBHOOKS_SVIX_AUTH_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcmdfcHJ1ZWJhIn0.c2lnbmF0dXJhLWRlLXBydWViYQ', WEBHOOKS_SVIX_NAMESPACE: 'prod-bo' } : {},
    });
  });
  afterAll(async () => h.stop());

  it(`responde ${expectedStatus} y expone checks.append_only_guards con el mismo nombre y forma`, async () => {
    const res = await h.http().get('/health/ready');
    expect(res.status).toBe(expectedStatus);
    expect(res.body.checks).toEqual({ append_only_guards: { ok: false, missing: GUARDS } });
    expect(res.body.checks.append_only_guards).not.toHaveProperty('status');
    if (payMode === 'sandbox') expect(res.body.info.database.status).toBe('up');
  });
});

describe('GET /health/ready con la base y el DDL vigentes', () => {
  let h: WebhooksHarness;
  beforeAll(async () => {
    h = await startWebhooks();
  });
  afterAll(async () => h.stop());

  it('CORRECTO: ok:true, missing vacío, 200; reaplicando el DDL a una base sin guardianes vuelve a ok sin reiniciar el servicio', async () => {
    const res = await h.http().get('/health/ready').expect(200);
    expect(res.body.checks).toEqual({ append_only_guards: { ok: true, missing: [] } });
    await h.db.pool.query(`DROP TRIGGER webhook_delivery_attempts_immutable ON ${TABLE}`);
    const broken = await h.http().get('/health/ready').expect(200); // sandbox: sigue listo, pero se ve
    expect(broken.body.checks.append_only_guards).toEqual({ ok: false, missing: ['webhook_delivery_attempts_immutable'] });
    await h.db.pool.query(readFileSync(SQL_FILES[0], 'utf8'));
    expect((await h.http().get('/health/ready').expect(200)).body.checks).toEqual({ append_only_guards: { ok: true, missing: [] } });
  });
});
