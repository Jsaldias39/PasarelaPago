import type { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { backendsOf, directAddress, terminate, type Backend } from './support/pg-cut';
import { SQL, chargeRef, refundRef } from './support/app';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';

// Defecto transversal: un `pg.Pool` sin manejador de `error` mata el PROCESO cuando Postgres corta una conexión (ociosa o en uso). Binario real
// (`node dist/main.js`) y Postgres real; las conexiones del proceso se identifican por sus puertos locales (`lsof`) para cortar SOLO las suyas.
const url = new URL(TEST_DATABASE_URL);
const dbEnv = {
  DB_NAME: url.pathname.slice(1),
  DB_USER: decodeURIComponent(url.username),
  DB_PASSWORD: decodeURIComponent(url.password),
};
const SECRET = { MOCKBANK_WEBHOOK_SECRET: 'whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg==' };
const HEADERS = { 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test', 'content-type': 'application/json', connection: 'close' };

let DB_PORT: string;
let db: IsolatedDatabase;
let admin: Pool;
let service: Started;
let base: string;

beforeAll(async () => {
  buildService('pay-mockbank');
  db = await createIsolatedDatabase(SQL, { max: 4 });
  admin = db.pool;
  const direct = await directAddress(admin);
  DB_PORT = direct.port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  service = startService('pay-mockbank', { ...dbEnv, DB_HOST: direct.host, DB_PORT: direct.port, PGOPTIONS: `-c search_path=${db.schema}`, PORT: String(port), PAY_MODE: 'sandbox', LOG_LEVEL: 'trace', ...SECRET });
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

const createCharge = (reference = chargeRef()) =>
  fetch(`${base}/sandbox/charges`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ reference, amount_minor: 10000, currency: 'BOB', method: 'qr', expires_at: new Date(Date.now() + 3_600_000).toISOString() }) });
const refund = (chargeReference: string, reference = refundRef()) => fetch(`${base}/sandbox/refunds`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ reference, charge_reference: chargeReference, amount_minor: 4000 }) });

describe('conexión cortada por Postgres: el proceso sobrevive y el pool se repone', () => {
  it('correcto: una conexión ociosa cortada con pg_terminate_backend NO mata el proceso y el servicio sigue operando', async () => {
    expect((await createCharge()).status).toBe(201);
    const before = await idle();
    expect(before.length).toBeGreaterThan(0);
    const victim = before[0] as Backend;
    await terminate(admin, [victim.pid]);
    await gone([victim.pid]);
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status).toBe(200);
    expect((await createCharge()).status).toBe(201);
    const after = await mine();
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((b) => b.pid)).not.toContain(victim.pid);
  }, 60_000);

  it('límite: se cortan TODAS las conexiones ociosas a la vez; las siguientes peticiones, incluso concurrentes, se atienden', async () => {
    await Promise.all([createCharge(), createCharge(), createCharge()]);
    const all = await idle();
    expect(all.length).toBeGreaterThan(1);
    await terminate(admin, all.map((b) => b.pid));
    await gone(all.map((b) => b.pid));
    expect(alive()).toBe(true);
    expect(service.output()).toMatch(/PgPool/);
    const responses = await Promise.all([createCharge(), createCharge(), createCharge(), createCharge()]);
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(alive()).toBe(true);
  }, 60_000);

  it('límite: corte a MITAD de una consulta de lectura: error del contrato (5xx problem+json, nunca «no existe»), el cobro no se toca y el proceso sigue vivo', async () => {
    const reference = chargeRef();
    expect((await createCharge(reference)).status).toBe(201);
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE mb_charges IN ACCESS EXCLUSIVE MODE');
      const pending = fetch(`${base}/sandbox/charges/${reference}`, { headers: HEADERS });
      const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && b.waitEventType === 'Lock'), 15_000);
      expect(victim).toBeDefined();
      await terminate(admin, [(victim as Backend).pid]);
      const response = await pending;
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get('content-type')).toMatch(/problem\+json/);
      expect(JSON.stringify(await response.json())).not.toMatch(/charge_not_found|not_found|mb_charges|terminat|SELECT/i);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/sandbox/charges/${reference}`, { headers: HEADERS })).status).toBe(200);
  }, 60_000);

  it('límite: corte a MITAD de una transacción (cliente PRESTADO, el reembolso): error del contrato, proceso vivo, nada a medias, y reintentar con la MISMA referencia converge en UN reembolso', async () => {
    const charge = chargeRef();
    expect((await createCharge(charge)).status).toBe(201);
    const reference = refundRef();
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE mb_refunds IN ACCESS EXCLUSIVE MODE');
      const pending = refund(charge, reference);
      const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && b.waitEventType === 'Lock'), 15_000);
      expect(victim).toBeDefined();
      await terminate(admin, [(victim as Backend).pid]);
      const response = await pending;
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(response.headers.get('content-type')).toMatch(/problem\+json/);
      expect(JSON.stringify(await response.json())).not.toMatch(/mb_refunds|mb_charges|terminat|SELECT|INSERT/i);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(alive()).toBe(true);
    expect((await admin.query('SELECT count(*)::int AS n FROM mb_refunds WHERE reference = $1', [reference])).rows[0].n).toBe(0);
    const retry = await refund(charge, reference);
    expect(retry.status).toBe(201);
    const again = await refund(charge, reference);
    expect(((await again.json()) as { bank_reference: string }).bank_reference).toBe(((await retry.json()) as { bank_reference: string }).bank_reference);
    expect((await admin.query('SELECT count(*)::int AS n FROM mb_refunds WHERE reference = $1', [reference])).rows[0].n).toBe(1);
  }, 60_000);

  it('inválido: ni el mensaje del error de Postgres, ni el SQL, ni la cadena de conexión llegan al registro del proceso; sí queda el nombre del error (control positivo)', () => {
    const log = service.output();
    expect(log).toMatch(/Conexión ociosa cortada por Postgres; el pool la repone/);
    expect(log).toMatch(/"err":"error"/);
    expect(log).not.toMatch(/terminating connection|administrator command|57P01/i);
    expect(log).not.toMatch(/\b(SELECT|UPDATE|INSERT|DELETE)\b[^"\n]*\bmb_\w+/);
    // La contraseña del Compose de desarrollo de este servicio es corta (`pay`): se busca como valor asignado, no como subcadena de cualquier texto.
    expect(log).not.toMatch(new RegExp(`password\\W{0,4}${dbEnv.DB_PASSWORD}\\b`, 'i'));
    expect(log).not.toMatch(/password=|postgres(ql)?:\/\//i);
  });
});
