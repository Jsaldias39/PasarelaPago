import type { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { backendsOf, directAddress, terminate, type Backend } from './support/pg-cut';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';
import { SQL } from './support/app';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Un corte de Postgres NO puede matar el proceso, ni con la conexión ociosa ni con la conexión PRESTADA a mitad de una transacción (`pool-guard.ts`).
 * Binario real (`node dist/main.js`) y Postgres real; las conexiones del proceso se identifican por sus puertos locales (`lsof`) para cortar SOLO las
 * suyas. Mismo diseño que `pay-connectors/test/pool-error.spec.ts`.
 */
const url = new URL(TEST_DATABASE_URL);
const dbEnv = { DB_NAME: url.pathname.slice(1), DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password) };

let db: IsolatedDatabase;
let admin: Pool;
let service: Started;
let base: string;
let DB_PORT: string;
let seq = 0;
// Credencial de operador SINTÉTICA de sandbox (JWT RS256 atado a `mode: sandbox`), como `scripts/sandbox-operator-token.mjs`.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
function operatorToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: 'pool-error-issuer', aud: 'pay-merchants', sub: 'operador_pool_01', roles: ['merchant_operator'], mode: 'sandbox', iat: now, exp: now + 3600 })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
}

beforeAll(async () => {
  buildService();
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
    KYC_STORE_DIR: mkdtempSync(join(tmpdir(), 'pool-error-kyc-')),
    OPERATOR_TOKEN_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '\\n'),
    OPERATOR_TOKEN_ISSUER: 'pool-error-issuer',
    OPERATOR_TOKEN_AUDIENCE: 'pay-merchants',
  });
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
  expect(await until(async () => ((await mine()).every((b) => !pids.includes(b.pid)) ? true : undefined), 15_000)).toBe(true);
}

function creation(key: string) {
  const n = (seq += 1);
  const taxId = `3${String(Date.now()).slice(-6)}${String(n).padStart(3, '0')}`;
  const body = { display_name: `Comercio Sintético ${n}`, legal_name: `Razón Social Sintética ${n} S.R.L.`, legal_type: 'srl', tax_id: taxId };
  return { taxId, request: { headers: { 'x-service-id': 'pay-backoffice', authorization: `Bearer ${operatorToken()}`, 'idempotency-key': key, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify(body) } };
}
const post = (request: { headers: Record<string, string>; body: string }) => fetch(`${base}/merchants`, { method: 'POST', headers: request.headers, body: request.body });

describe('conexión ociosa cortada por Postgres: el proceso sobrevive y el pool se repone', () => {
  it('correcto: una conexión ociosa cortada con pg_terminate_backend NO mata el proceso y el servicio sigue operando', async () => {
    expect((await post(creation('pool-ok-0001-padding').request)).status).toBe(201);
    const victim = (await idle())[0] as Backend;
    expect(victim).toBeDefined();
    await terminate(admin, [victim.pid]);
    await gone([victim.pid]);
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status).toBe(200);
    expect((await post(creation('pool-ok-0002-padding').request)).status).toBe(201);
    expect(service.output()).toMatch(/Conexión ociosa cortada por Postgres; el pool la repone/);
  }, 60_000);

  it('límite: se cortan TODAS las conexiones ociosas a la vez; las siguientes peticiones, incluso concurrentes, se atienden', async () => {
    await Promise.all(['pool-all-0001-padding', 'pool-all-0002-padding', 'pool-all-0003-padding'].map((k) => post(creation(k).request)));
    const all = await idle();
    expect(all.length).toBeGreaterThan(1);
    await terminate(admin, all.map((b) => b.pid));
    await gone(all.map((b) => b.pid));
    expect(alive()).toBe(true);
    const responses = await Promise.all(['pool-all-0004-padding', 'pool-all-0005-padding', 'pool-all-0006-padding'].map((k) => post(creation(k).request)));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
  }, 60_000);
});

describe('conexión PRESTADA cortada a mitad de una transacción', () => {
  afterEach(async () => {
    await admin.query('DROP TRIGGER IF EXISTS test_slow_merchant ON merchants');
  });

  it('límite (regla 11): corte mientras se escribe el alta del comercio: 5xx del contrato (nunca 201 ni «no existe»), el proceso sigue vivo, no queda un comercio ni un evento a medias y reintentar con la MISMA clave converge en UNO', async () => {
    // [FIXTURE de la prueba, en el esquema aislado] La escritura del comercio tarda 5 s: da tiempo a cortar justo ahí, con la transacción abierta.
    await admin.query(`CREATE OR REPLACE FUNCTION test_slow_merchant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER test_slow_merchant BEFORE INSERT ON merchants FOR EACH ROW EXECUTE FUNCTION test_slow_merchant()');
    const events = async (): Promise<number> => (await admin.query(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'merchant.created'`)).rows[0].n;
    const eventsBefore = await events();
    const { taxId, request } = creation('pool-mid-tx-0001-padding');
    const pending = post(request);
    const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && /INSERT INTO merchants/.test(b.query)), 15_000);
    expect(victim).toBeDefined();
    await terminate(admin, [(victim as Backend).pid]);
    const response = await pending;
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('content-type')).toMatch(/problem\+json/);
    expect(JSON.stringify(await response.json())).not.toMatch(/not_found|terminat|SELECT|INSERT|tax_id|legal_name/i);
    expect(alive()).toBe(true);
    // Postgres deshizo la transacción: ni comercio ni evento a medias.
    expect((await admin.query('SELECT count(*)::int AS n FROM merchants WHERE tax_id = $1', [taxId])).rows[0].n).toBe(0);
    expect(await events()).toBe(eventsBefore);
    await admin.query('DROP TRIGGER test_slow_merchant ON merchants');
    // Reintento con la MISMA clave: converge en un solo comercio y un solo evento.
    let retry = await post(request);
    if (retry.status === 409) retry = (await until(async () => ((await post(request)).status === 201 ? await post(request) : undefined), 30_000)) ?? retry;
    expect([200, 201]).toContain(retry.status);
    expect((await admin.query('SELECT count(*)::int AS n FROM merchants WHERE tax_id = $1', [taxId])).rows[0].n).toBe(1);
    expect(await events()).toBe(eventsBefore + 1);
    expect(alive()).toBe(true);
  }, 90_000);

  it('inválido: el registro del proceso no trae el mensaje de Postgres, el SQL, la contraseña ni la razón social; sí el nombre del error', () => {
    const log = service.output();
    expect(log).toMatch(/"err":"error"/);
    expect(log).not.toMatch(/terminating connection|administrator command|57P01/i);
    expect(log).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\b[^"\n]*\bmerchants\b/);
    expect(log).not.toContain(dbEnv.DB_PASSWORD);
    expect(log).not.toMatch(/password=|postgres(ql)?:\/\/|Razón Social Sintética/i);
  });
});
