import { join } from 'node:path';
import type { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { backendsOf, directAddress, terminate, type Backend } from './support/pg-cut';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';

// Defecto transversal: un `pg.Pool` sin manejador de `error` mata el PROCESO cuando Postgres corta una conexión (ociosa o en uso). Binario real
// (`node dist/main.js`) y Postgres real; las conexiones del proceso se identifican por sus puertos locales (`lsof`) para cortar SOLO las suyas.
const SQL = [join(process.cwd(), 'sql/ddl.sql')];
const url = new URL(TEST_DATABASE_URL);
const dbEnv = {
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
const HEADERS = { 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test', 'content-type': 'application/json', connection: 'close' };

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
  service = startService({ ...dbEnv, DB_HOST: direct.host, DB_PORT: direct.port, PGOPTIONS: `-c search_path=${db.schema}`, PORT: String(port), PAY_MODE: 'sandbox', QR_ACCOUNT_GUID: 'guid.provisional', LOG_LEVEL: 'trace' });
  const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
  if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
}, 240_000);

afterAll(async () => {
  await stop(service);
  await db.drop();
});

const alive = (): boolean => service.child.exitCode === null && service.child.signalCode === null;
const mine = (): Promise<Backend[]> => backendsOf(admin, service.child.pid as number, DB_PORT);
const idle = async (): Promise<Backend[]> => (await mine()).filter((b) => b.state === 'idle');

async function gone(pids: readonly number[]): Promise<void> {
  const done = await until(async () => ((await mine()).every((b) => !pids.includes(b.pid)) ? true : undefined), 15_000);
  expect(done).toBe(true);
}

function qrRequest(key: string): { headers: Record<string, string>; body: string } {
  const body = { kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB', amount_minor: 10000, payment_intent_id: `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  return { headers: { ...HEADERS, 'idempotency-key': key }, body: JSON.stringify(body) };
}
const createQr = (key: string, request = qrRequest(key)) => fetch(`${base}/qr`, { method: 'POST', headers: request.headers, body: request.body });

describe('conexión cortada por Postgres: el proceso sobrevive y el pool se repone', () => {
  it('correcto: una conexión ociosa cortada con pg_terminate_backend NO mata el proceso y el servicio sigue operando', async () => {
    expect((await createQr('pool-ok-0001-padding')).status).toBe(201);
    const before = await idle();
    expect(before.length).toBeGreaterThan(0);
    const victim = before[0] as Backend;
    await terminate(admin, [victim.pid]);
    await gone([victim.pid]);
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status).toBe(200);
    expect((await createQr('pool-ok-0002-padding')).status).toBe(201);
    const after = await mine();
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((b) => b.pid)).not.toContain(victim.pid);
  }, 60_000);

  it('límite: se cortan TODAS las conexiones ociosas a la vez; las siguientes peticiones, incluso concurrentes, se atienden', async () => {
    // Precondición: más de una conexión ociosa. En un equipo rápido 3 peticiones pueden atenderse sobre una sola conexión, así que la ráfaga concurrente
    // se repite hasta que el pool abrió varias (la aserción sigue exigiendo > 1).
    const all = (await until(async () => {
      await Promise.all([createQr('pool-all-0001-padding'), createQr('pool-all-0002-padding'), createQr('pool-all-0003-padding')]);
      const found = await idle();
      return found.length > 1 ? found : undefined;
    }, 30_000)) as Backend[];
    expect(all.length).toBeGreaterThan(1);
    await terminate(admin, all.map((b) => b.pid));
    await gone(all.map((b) => b.pid));
    expect(alive()).toBe(true);
    expect(service.output()).toMatch(/PgPool/);
    const responses = await Promise.all(['pool-all-0004-padding', 'pool-all-0005-padding', 'pool-all-0006-padding', 'pool-all-0007-padding'].map((key) => createQr(key)));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(alive()).toBe(true);
  }, 60_000);

  it('límite: corte a MITAD de una consulta de lectura: error del contrato (5xx problem+json, nunca «no existe»), el QR no se toca y el proceso sigue vivo', async () => {
    const created = await createQr('pool-mid-read-padding');
    const { id } = (await created.json()) as { id: string };
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE qr_codes IN ACCESS EXCLUSIVE MODE');
      const pending = fetch(`${base}/qr/${id}`, { headers: HEADERS });
      const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && b.waitEventType === 'Lock'), 15_000);
      expect(victim).toBeDefined();
      await terminate(admin, [(victim as Backend).pid]);
      const response = await pending;
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get('content-type')).toMatch(/problem\+json/);
      expect(JSON.stringify(await response.json())).not.toMatch(/not_found|qr_codes|terminat|SELECT/i);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/qr/${id}`, { headers: HEADERS })).status).toBe(200);
  }, 60_000);

  it('límite: corte a MITAD de una transacción de escritura (cliente PRESTADO, no ocioso): error del contrato, proceso vivo, y reintentar con la MISMA clave converge en UN solo QR', async () => {
    const key = 'pool-mid-write-padding';
    const request = qrRequest(key);
    const intent = (JSON.parse(request.body) as { payment_intent_id: string }).payment_intent_id;
    const holder = await admin.connect();
    let pending: Promise<Response>;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE qr_codes IN ACCESS EXCLUSIVE MODE');
      pending = createQr(key, request);
      const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && b.waitEventType === 'Lock'), 15_000);
      expect(victim).toBeDefined();
      await terminate(admin, [(victim as Backend).pid]);
      const response = await pending;
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get('content-type')).toMatch(/problem\+json/);
      expect(JSON.stringify(await response.json())).not.toMatch(/qr_codes|terminat|SELECT|INSERT/i);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(alive()).toBe(true);
    const retry = await createQr(key, request);
    expect(retry.status).toBe(201);
    const again = await createQr(key, request);
    expect(((await again.json()) as { id: string }).id).toBe(((await retry.json()) as { id: string }).id);
    expect((await admin.query('SELECT count(*)::int AS n FROM qr_codes WHERE payment_intent_id = $1', [intent])).rows[0].n).toBe(1);
  }, 60_000);

  it('inválido: ni el mensaje del error de Postgres, ni el SQL, ni la cadena de conexión llegan al registro del proceso; sí queda el nombre del error (control positivo)', () => {
    const log = service.output();
    expect(log).toMatch(/Conexión ociosa cortada por Postgres; el pool la repone/);
    expect(log).toMatch(/"err":"error"/);
    expect(log).not.toMatch(/terminating connection|administrator command|57P01/i);
    expect(log).not.toMatch(/\b(SELECT|UPDATE|INSERT|DELETE)\b[^"\n]*\bqr_\w+/);
    expect(log).not.toContain(dbEnv.DB_PASSWORD);
    expect(log).not.toMatch(/password=|postgres(ql)?:\/\//i);
  });
});
