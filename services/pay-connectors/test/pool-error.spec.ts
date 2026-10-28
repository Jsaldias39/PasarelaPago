import type { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { backendsOf, directAddress, terminate, type Backend } from './support/pg-cut';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';
import { SQL } from './support/app';

// Defecto transversal: un `pg.Pool` sin manejador de `error` mata el PROCESO cuando Postgres corta una conexión ociosa (reinicio, failover,
// `pg_terminate_backend`). Acá se prueba con el binario real (`node dist/main.js`) y Postgres real: las conexiones del proceso se identifican por
// sus puertos locales (`lsof`) para cortar SOLO las suyas, no las de otra suite que use el mismo rol.
const url = new URL(TEST_DATABASE_URL);
const dbEnv = {
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
const MOCK_SECRET = { PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET: 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==' };
const HEADERS = { 'x-service-id': 'pay-payments', 'x-pay-mode': 'test', 'content-type': 'application/json', connection: 'close' };

let DB_PORT: string;
let db: IsolatedDatabase;
let admin: Pool;
let service: Started;
let base: string;
let seq = 0;

beforeAll(async () => {
  buildService();
  db = await createIsolatedDatabase(SQL, { max: 4 });
  admin = db.pool;
  const direct = await directAddress(admin);
  DB_PORT = direct.port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  service = startService({ ...dbEnv, DB_HOST: direct.host, DB_PORT: direct.port, PGOPTIONS: `-c search_path=${db.schema}`, PORT: String(port), PAY_MODE: 'sandbox', LOG_LEVEL: 'trace', POLLER_INTERVAL_MS: '0', HEALTH_INTERVAL_MS: '0', RECONCILE_INTERVAL_MS: '0', MOCK_PUMP_INTERVAL_MS: '0', ...MOCK_SECRET });
  const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
  if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
}, 240_000);

afterAll(async () => {
  await stop(service);
  await db.drop();
});

const alive = (): boolean => service.child.exitCode === null && service.child.signalCode === null;
const mine = (): Promise<Backend[]> => backendsOf(admin, service.child.pid as number, DB_PORT);
const idle = async (applicationName?: string): Promise<Backend[]> => (await mine()).filter((b) => b.state === 'idle' && (applicationName === undefined || b.applicationName === applicationName));

/** Espera por condición a que los backends `pids` hayan desaparecido de Postgres. */
async function gone(pids: readonly number[]): Promise<void> {
  const done = await until(async () => ((await mine()).every((b) => !pids.includes(b.pid)) ? true : undefined), 15_000);
  expect(done).toBe(true);
}

function chargeRequest(key: string): { headers: Record<string, string>; body: string } {
  const body = { payment_intent_id: `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`, merchant_id: 'mc_clinicasantacruz1', amount_minor: 10000, currency: 'BOB', method: 'bank_transfer', expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  return { headers: { ...HEADERS, 'idempotency-key': key }, body: JSON.stringify(body) };
}
const createCharge = (key: string, request = chargeRequest(key)) => fetch(`${base}/charges`, { method: 'POST', headers: request.headers, body: request.body });

describe('conexión ociosa cortada por Postgres: el proceso sobrevive y el pool se repone', () => {
  it('correcto: una conexión ociosa cortada con pg_terminate_backend NO mata el proceso y el servicio sigue operando', async () => {
    expect((await createCharge('pool-ok-0001-padding')).status).toBe(201);
    const before = await idle();
    expect(before.length).toBeGreaterThan(0);
    const victim = before[0] as Backend;
    await terminate(admin, [victim.pid]);
    await gone([victim.pid]);
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status).toBe(200);
    expect((await createCharge('pool-ok-0002-padding')).status).toBe(201);
    // El pool repuso la conexión: hay backends del proceso y ninguno es el cortado.
    const after = await mine();
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((b) => b.pid)).not.toContain(victim.pid);
  }, 60_000);

  it('correcto: el pool de CANDADOS (LOCK_POOL) también sobrevive al corte y se repone en el siguiente cobro', async () => {
    expect((await createCharge('pool-lock-0001-padding')).status).toBe(201);
    const locks = await idle('pay-connectors-locks');
    expect(locks.length).toBeGreaterThan(0);
    await terminate(admin, locks.map((b) => b.pid));
    await gone(locks.map((b) => b.pid));
    expect(alive()).toBe(true);
    expect(service.output()).toMatch(/PgLockPool/);
    expect((await createCharge('pool-lock-0002-padding')).status).toBe(201);
    expect((await idle('pay-connectors-locks')).length).toBeGreaterThan(0);
  }, 60_000);

  it('límite: se cortan TODAS las conexiones ociosas de todos los pools a la vez; las siguientes peticiones, incluso concurrentes, se atienden', async () => {
    await Promise.all([createCharge('pool-all-0001-padding'), createCharge('pool-all-0002-padding'), createCharge('pool-all-0003-padding')]);
    const all = await idle();
    expect(all.length).toBeGreaterThan(1);
    await terminate(admin, all.map((b) => b.pid));
    await gone(all.map((b) => b.pid));
    expect(alive()).toBe(true);
    expect(service.output()).toMatch(/PgPool/);
    const responses = await Promise.all(['pool-all-0004-padding', 'pool-all-0005-padding', 'pool-all-0006-padding', 'pool-all-0007-padding'].map((key) => createCharge(key)));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(alive()).toBe(true);
  }, 60_000);

  it('límite: corte a MITAD de una consulta de lectura: la petición falla con error del contrato (5xx problem+json, nunca «no existe»), el cobro no se toca y el proceso sigue vivo', async () => {
    const created = await createCharge('pool-mid-read-padding');
    const { id } = (await created.json()) as { id: string };
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE connector_charges IN ACCESS EXCLUSIVE MODE');
      const pending = fetch(`${base}/charges/${id}/status`, { headers: HEADERS });
      const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && b.waitEventType === 'Lock'), 15_000);
      expect(victim).toBeDefined();
      await terminate(admin, [(victim as Backend).pid]);
      const response = await pending;
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get('content-type')).toMatch(/problem\+json/);
      const problem = (await response.json()) as Record<string, unknown>;
      expect(JSON.stringify(problem)).not.toMatch(/resource_not_found|not_found|connector_charges|terminat|SELECT/i);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(alive()).toBe(true);
    // Regla 11: el cobro sigue siendo el mismo, intacto, y se puede consultar de nuevo.
    const row = (await admin.query('SELECT provider_status, ambiguous FROM connector_charges WHERE id = $1', [id])).rows[0];
    expect(row).toBeDefined();
    expect(row.provider_status).toBe('pending');
    const again = await fetch(`${base}/charges/${id}/status`, { headers: HEADERS });
    expect(again.status).toBe(200);
  }, 60_000);

  it('límite (regla 11): corte DESPUÉS de enviar al proveedor, en la escritura de «cobro enviado»: 5xx del contrato, el cobro NO se anula ni se da por inexistente y reintentar con la MISMA clave converge en UN cobro', async () => {
    // [FIXTURE de la prueba, en el esquema aislado] La escritura de «cobro enviado» tarda 5 s: da tiempo a cortar justo ahí.
    await admin.query(`CREATE FUNCTION test_slow_charge_sent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER test_slow_charge_sent BEFORE UPDATE ON connector_charges FOR EACH ROW WHEN (OLD.ambiguous AND NOT NEW.ambiguous AND NEW.provider_reference IS NOT NULL) EXECUTE FUNCTION test_slow_charge_sent()`);
    const key = 'pool-mid-send-padding';
    const request = chargeRequest(key);
    const intent = (JSON.parse(request.body) as { payment_intent_id: string }).payment_intent_id;
    const pending = createCharge(key, request);
    const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && /ambiguous = false/.test(b.query)), 15_000);
    expect(victim).toBeDefined();
    await terminate(admin, [(victim as Backend).pid]);
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('content-type')).toMatch(/problem\+json/);
    expect(JSON.stringify(await response.json())).not.toMatch(/not_found|connector_charges|terminat|SELECT|UPDATE/i);
    expect(alive()).toBe(true);
    // El cobro quedó «en vuelo»: ni cancelado ni fallido, y NO se borró.
    const row = (await admin.query('SELECT id, provider_status, ambiguous FROM connector_charges WHERE payment_intent_id = $1', [intent])).rows;
    expect(row).toHaveLength(1);
    expect(row[0].provider_status).toBe('pending');
    expect(row[0].ambiguous).toBe(true);
    await admin.query('DROP TRIGGER test_slow_charge_sent ON connector_charges');
    const retry = await createCharge(key, request);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { id: string }).id).toBe(row[0].id);
    expect((await admin.query('SELECT count(*)::int AS n FROM connector_charges WHERE payment_intent_id = $1', [intent])).rows[0].n).toBe(1);
  }, 60_000);

  it('inválido: ni el mensaje del error de Postgres, ni el SQL, ni la cadena de conexión llegan al registro del proceso; sí queda el nombre del error (el control positivo)', async () => {
    const log = service.output();
    // Control positivo: el registro no está vacío y SÍ tiene el aviso del pool, solo con el nombre del error.
    expect(log).toMatch(/Conexión ociosa cortada por Postgres; el pool la repone/);
    expect(log).toMatch(/"err":"error"/);
    expect(log).not.toMatch(/terminating connection|administrator command|57P01/i);
    expect(log).not.toMatch(/\b(SELECT|UPDATE|INSERT|DELETE)\b[^"\n]*\bconnector_\w+/);
    expect(log).not.toContain(dbEnv.DB_PASSWORD);
    expect(log).not.toMatch(/password=|postgres(ql)?:\/\//i);
  });
});
