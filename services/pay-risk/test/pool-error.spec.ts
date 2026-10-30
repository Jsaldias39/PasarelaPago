import type { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { backendsOf, directAddress, terminate, type Backend } from './support/pg-cut';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';
import { SQL } from './support/app';
import { json, startWatchmanDouble, type WatchmanDouble } from './support/watchman-double';

/**
 * Un corte de Postgres NO puede matar el proceso, ni con la conexión ociosa ni con la conexión PRESTADA a mitad de una transacción (`pool-guard.ts`).
 * Binario real (`node dist/main.js`) y Postgres real; las conexiones del proceso se identifican por sus puertos locales (`lsof`) para cortar SOLO las
 * suyas. El Watchman es un [DOBLE] que no encuentra nada (esta prueba no es de cribado). Mismo diseño que `pay-connectors/test/pool-error.spec.ts`.
 */
const url = new URL(TEST_DATABASE_URL);
const dbEnv = { DB_NAME: url.pathname.slice(1), DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password) };

let db: IsolatedDatabase;
let admin: Pool;
let watchman: WatchmanDouble;
let service: Started;
let base: string;
let DB_PORT: string;
let seq = 0;

beforeAll(async () => {
  buildService();
  watchman = await startWatchmanDouble((_req, res) => json(res, { entities: null }));
  db = await createIsolatedDatabase(SQL, { max: 4 });
  admin = db.pool;
  const direct = await directAddress(admin);
  DB_PORT = direct.port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  service = startService({
    ...dbEnv,
    DB_HOST: direct.host,
    DB_PORT: direct.port,
    PGOPTIONS: `-c search_path=${db.schema}`,
    PORT: String(port),
    PAY_MODE: 'sandbox',
    LOG_LEVEL: 'trace',
    WATCHMAN_URL: watchman.url,
    SANCTIONS_DENY_SCORE: '0.80',
    SANCTIONS_REVIEW_SCORE: '0.60',
    PAYER_HASH_KEY: 'pool-error-test-key-0123456789',
  });
  const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
  if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
}, 240_000);

afterAll(async () => {
  await stop(service);
  await watchman.close();
  await db.drop();
});

const alive = (): boolean => service.child.exitCode === null && service.child.signalCode === null;
const mine = (): Promise<Backend[]> => backendsOf(admin, service.child.pid as number, DB_PORT);
const idle = async (): Promise<Backend[]> => (await mine()).filter((b) => b.state === 'idle');

async function gone(pids: readonly number[]): Promise<void> {
  expect(await until(async () => ((await mine()).every((b) => !pids.includes(b.pid)) ? true : undefined), 15_000)).toBe(true);
}

function assessment(key: string) {
  const intent = `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`;
  const body = { merchant_id: 'mc_pooltest00001', payment_intent_id: intent, amount_minor: 5000, currency: 'BOB', method: 'qr', screening: { merchant_name: 'COMERCIO SINTETICO' } };
  return { intent, request: { headers: { 'x-service-id': 'pay-payments', 'idempotency-key': key, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) } };
}
const post = (request: { headers: Record<string, string>; body: string }) => fetch(`${base}/assessments`, { method: 'POST', headers: request.headers, body: request.body });

describe('conexión ociosa cortada por Postgres: el proceso sobrevive y el pool se repone', () => {
  it('correcto: una conexión ociosa cortada con pg_terminate_backend NO mata el proceso y el servicio sigue operando', async () => {
    expect((await post(assessment('pool-ok-0001-padding').request)).status).toBe(201);
    const victim = (await idle())[0] as Backend;
    expect(victim).toBeDefined();
    await terminate(admin, [victim.pid]);
    await gone([victim.pid]);
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status).toBe(200);
    expect((await post(assessment('pool-ok-0002-padding').request)).status).toBe(201);
    expect(service.output()).toMatch(/Conexión ociosa cortada por Postgres; el pool la repone/);
  }, 60_000);

  it('límite: se cortan TODAS las conexiones ociosas a la vez; las siguientes peticiones, incluso concurrentes, se atienden', async () => {
    // Precondición: más de una conexión ociosa. En un equipo rápido 3 peticiones pueden atenderse sobre una sola conexión, así que la ráfaga concurrente
    // se repite hasta que el pool abrió varias (la aserción sigue exigiendo > 1).
    const all = (await until(async () => {
      await Promise.all(['pool-all-0001-padding', 'pool-all-0002-padding', 'pool-all-0003-padding'].map((k) => post(assessment(k).request)));
      const found = await idle();
      return found.length > 1 ? found : undefined;
    }, 30_000)) as Backend[];
    expect(all.length).toBeGreaterThan(1);
    await terminate(admin, all.map((b) => b.pid));
    await gone(all.map((b) => b.pid));
    expect(alive()).toBe(true);
    const responses = await Promise.all(['pool-all-0004-padding', 'pool-all-0005-padding', 'pool-all-0006-padding'].map((k) => post(assessment(k).request)));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
  }, 60_000);
});

describe('conexión PRESTADA cortada a mitad de una transacción', () => {
  afterEach(async () => {
    await admin.query('DROP TRIGGER IF EXISTS test_slow_assessment ON risk_assessments');
  });

  it('límite (regla 11): corte mientras se escribe la evaluación: 5xx del contrato (nunca 201 ni «no existe»), el proceso sigue vivo, no queda una evaluación a medias y reintentar con la MISMA clave converge en UNA', async () => {
    // [FIXTURE de la prueba, en el esquema aislado] La escritura de la evaluación tarda 5 s: da tiempo a cortar justo ahí, con la transacción abierta.
    await admin.query(`CREATE OR REPLACE FUNCTION test_slow_assessment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER test_slow_assessment BEFORE INSERT ON risk_assessments FOR EACH ROW EXECUTE FUNCTION test_slow_assessment()');
    const key = 'pool-mid-tx-0001-padding';
    const { intent, request } = assessment(key);
    const pending = post(request);
    const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && /INSERT INTO risk_assessments/.test(b.query)), 15_000);
    expect(victim).toBeDefined();
    await terminate(admin, [(victim as Backend).pid]);
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('content-type')).toMatch(/problem\+json/);
    expect(JSON.stringify(await response.json())).not.toMatch(/not_found|risk_assessments|terminat|SELECT|INSERT/i);
    expect(alive()).toBe(true);
    // Postgres deshizo la transacción: no hay evaluación a medias.
    expect((await admin.query('SELECT count(*)::int AS n FROM risk_assessments WHERE payment_intent_id = $1', [intent])).rows[0].n).toBe(0);
    await admin.query('DROP TRIGGER test_slow_assessment ON risk_assessments');
    // Reintento con la MISMA clave: converge en una sola evaluación (o, si la clave sigue «en curso», el contrato lo dice con 409 y el siguiente intento converge).
    let retry = await post(request);
    if (retry.status === 409) retry = (await until(async () => ((await post(request)).status === 201 ? await post(request) : undefined), 30_000)) ?? retry;
    expect([200, 201]).toContain(retry.status);
    expect((await admin.query('SELECT count(*)::int AS n FROM risk_assessments WHERE payment_intent_id = $1', [intent])).rows[0].n).toBe(1);
    expect(alive()).toBe(true);
  }, 90_000);

  it('inválido: el registro del proceso no trae el mensaje de Postgres, el SQL ni la contraseña; sí el nombre del error', () => {
    const log = service.output();
    expect(log).toMatch(/"err":"error"/);
    expect(log).not.toMatch(/terminating connection|administrator command|57P01/i);
    expect(log).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\b[^"\n]*\brisk_\w+/);
    expect(log).not.toContain(dbEnv.DB_PASSWORD);
    expect(log).not.toMatch(/password=|postgres(ql)?:\/\//i);
  });
});
