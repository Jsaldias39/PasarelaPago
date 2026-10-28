import type { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { backendsOf, directAddress, terminate, type Backend } from './support/pg-cut';
import { buildService, freePort, startService, stop, until, type Started } from './support/process';
import { SQL } from './support/app';
import { CONTRACT_LEDGER } from './support/app';
import { startLedgerDouble, type LedgerDouble } from './doubles/ledger.double';

/**
 * Un corte de Postgres NO puede matar el proceso, ni con la conexión ociosa ni con la conexión PRESTADA a mitad de una transacción (`pool-guard.ts`).
 * Binario real (`node dist/main.js`) y Postgres real; las conexiones del proceso se identifican por sus puertos locales (`lsof`) para cortar SOLO las
 * suyas. El libro mayor es el [DOBLE] HTTP de `test/doubles/ledger.double.ts`, con las mismas reglas del contrato (idempotencia por `business_ref` + intento). Mismo diseño que `pay-connectors/test/pool-error.spec.ts`.
 */
const url = new URL(TEST_DATABASE_URL);
const dbEnv = { DB_NAME: url.pathname.slice(1), DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password) };

let db: IsolatedDatabase;
let admin: Pool;
let ledger: LedgerDouble;
let service: Started;
let base: string;
let DB_PORT: string;
let seq = 0;

beforeAll(async () => {
  buildService();
  ledger = await startLedgerDouble(CONTRACT_LEDGER);
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
    LEDGER_URL: ledger.url,
    RETRY_DELAYS_SECONDS: '1,1,1',
    RUN_INTERVAL_SECONDS: '1',
    LEASE_SECONDS: '2',
  });
  const ready = await until(async () => ((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status === 200 ? true : undefined), 60_000, service.exited);
  if (!ready) throw new Error(`el servicio no llegó a estar listo:\n${service.output()}`);
}, 240_000);

afterAll(async () => {
  await stop(service);
  await ledger.close();
  await db.drop();
});

const alive = (): boolean => service.child.exitCode === null && service.child.signalCode === null;
const mine = (): Promise<Backend[]> => backendsOf(admin, service.child.pid as number, DB_PORT);
const idle = async (): Promise<Backend[]> => (await mine()).filter((b) => b.state === 'idle');

async function gone(pids: readonly number[]): Promise<void> {
  expect(await until(async () => ((await mine()).every((b) => !pids.includes(b.pid)) ? true : undefined), 15_000)).toBe(true);
}

const edge = (merchantId: string, extra: Record<string, string> = {}) => ({ 'x-service-id': 'pay-edge', 'x-merchant-id': merchantId, 'x-pay-mode': 'test', connection: 'close', ...extra });
const list = (merchantId: string) => fetch(`${base}/mandates`, { headers: edge(merchantId) });
const merchant = (): string => `mc_pool${String(Date.now()).slice(-6)}${String((seq += 1)).padStart(4, '0')}`;
const today = (): string => new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);

/** Un mandato que vence hoy, con los fondos del pagador en el libro mayor simulado. */
async function dueMandate(amount = 100_000): Promise<{ payer: string; beneficiary: string; mandateId: string }> {
  const payer = merchant();
  const beneficiary = merchant();
  for (const id of [payer, beneficiary]) await admin.query(`INSERT INTO merchant_replica (merchant_id, status, as_of) VALUES ($1, 'active', now())`, [id]); // [DOBLE] de la réplica por NATS
  ledger.fund('test', `merchant:${payer}:available`, amount);
  const day = today();
  const body = { kind: 'pay_obligation', beneficiary_merchant_id: beneficiary, amount_minor: amount, currency: 'BOB', schedule: { frequency: 'monthly', day_of_month: Math.min(Number(day.slice(8)), 28), start_date: day } };
  const res = await fetch(`${base}/mandates`, { method: 'POST', headers: edge(payer, { 'idempotency-key': `pool-mandate-${payer}`, 'content-type': 'application/json' }), body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  const mandateId = ((await res.json()) as { id: string }).id;
  if (Number(day.slice(8)) > 28) await admin.query(`UPDATE mandates SET next_run_on = $1::date WHERE id = $2`, [day, mandateId]); // [DOBLE DEL RELOJ] días 29–31
  return { payer, beneficiary, mandateId };
}

describe('conexión ociosa cortada por Postgres: el proceso sobrevive y el pool se repone', () => {
  it('correcto: una conexión ociosa cortada con pg_terminate_backend NO mata el proceso y el servicio sigue operando', async () => {
    expect((await list(merchant())).status).toBe(200);
    const victim = (await idle())[0] as Backend;
    expect(victim).toBeDefined();
    await terminate(admin, [victim.pid]);
    await gone([victim.pid]);
    expect(alive()).toBe(true);
    expect((await fetch(`${base}/health/ready`, { headers: { connection: 'close' } })).status).toBe(200);
    expect((await list(merchant())).status).toBe(200);
    expect(service.output()).toMatch(/Conexión ociosa cortada por Postgres; el pool la repone/);
  }, 60_000);

  it('límite: se cortan TODAS las conexiones ociosas a la vez; las siguientes peticiones, incluso concurrentes, se atienden', async () => {
    await Promise.all([1, 2, 3].map(() => list(merchant())));
    const all = await idle();
    expect(all.length).toBeGreaterThan(1);
    await terminate(admin, all.map((b) => b.pid));
    await gone(all.map((b) => b.pid));
    expect(alive()).toBe(true);
    const responses = await Promise.all([1, 2, 3].map(() => list(merchant())));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
  }, 60_000);
});

describe('conexión PRESTADA cortada a mitad de una transacción', () => {
  afterEach(async () => {
    await admin.query('DROP TRIGGER IF EXISTS test_slow_executed ON scheduled_payments');
  });

  it('regla 11: corte mientras se anota «ejecutado» (el dinero YA se movió): el proceso sigue vivo, el pago NO queda ejecutado a medias ni se anula, y el reintento usa las MISMAS claves y converge en UNA ejecución', async () => {
    // [FIXTURE de la prueba, en el esquema aislado] Anotar «ejecutado» tarda 5 s: da tiempo a cortar justo ahí, con la transacción abierta.
    await admin.query(`CREATE OR REPLACE FUNCTION test_slow_executed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER test_slow_executed BEFORE UPDATE ON scheduled_payments FOR EACH ROW WHEN (NEW.status = 'executed' AND OLD.status <> 'executed') EXECUTE FUNCTION test_slow_executed()`);
    const { payer, beneficiary, mandateId } = await dueMandate();
    const victim = await until(async () => (await mine()).find((b) => b.state === 'active' && /status = 'executed'/.test(b.query)), 30_000);
    expect(victim).toBeDefined();
    // En este instante el libro mayor ya confirmó la retención y la liberación al beneficiario.
    const releasedBefore = ledger.calls.filter((c) => c.method === 'POST' && c.path === '/transactions').length;
    expect(releasedBefore).toBeGreaterThanOrEqual(1);
    await terminate(admin, [(victim as Backend).pid]);
    expect(await until(async () => ((await mine()).every((b) => b.pid !== (victim as Backend).pid) ? true : undefined), 15_000)).toBe(true);
    expect(alive()).toBe(true);
    // La transacción se deshizo: el pago NO consta ejecutado, tampoco fallido ni anulado, y no hay evento de ejecución.
    const midway = (await admin.query('SELECT status, phase, ledger_transaction_id FROM scheduled_payments WHERE mandate_id = $1', [mandateId])).rows;
    expect(midway).toHaveLength(1);
    expect(midway[0].status).not.toBe('executed');
    expect(['failed', 'canceled']).not.toContain(midway[0].status);
    expect((await admin.query(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'scheduled_payment.executed' AND envelope->'data'->>'mandate_id' = $1`, [mandateId])).rows[0].n).toBe(0);
    await admin.query('DROP TRIGGER test_slow_executed ON scheduled_payments');
    // El ejecutor reintenta solo (el arriendo vence a los 2 s): converge en UNA ejecución.
    const done = await until(async () => ((await admin.query(`SELECT status FROM scheduled_payments WHERE mandate_id = $1 AND status = 'executed'`, [mandateId])).rows.length === 1 ? true : undefined), 60_000);
    expect(done).toBe(true);
    const final = (await admin.query('SELECT status, phase, ledger_transaction_id, needs_review FROM scheduled_payments WHERE mandate_id = $1', [mandateId])).rows;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ status: 'executed', phase: 'done', needs_review: false });
    expect(final[0].ledger_transaction_id).toMatch(/^tx_/);
    expect((await admin.query(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'scheduled_payment.executed' AND envelope->'data'->>'mandate_id' = $1`, [mandateId])).rows[0].n).toBe(1);
    // Libro mayor: una retención, una liberación (varias peticiones con la MISMA clave), nunca /void, y el dinero movió UNA vez.
    const holds = ledger.calls.filter((c) => c.method === 'POST' && c.path === '/holds' && c.body?.debit_account === `merchant:${payer}:available`);
    const releases = ledger.calls.filter((c) => c.method === 'POST' && c.path === '/transactions' && c.body?.legs?.[0]?.credit_account === `merchant:${beneficiary}:available`);
    expect(new Set(holds.map((c) => c.headers['idempotency-key'])).size).toBe(1);
    expect(releases.length).toBeGreaterThanOrEqual(2);
    expect(new Set(releases.map((c) => c.headers['idempotency-key'])).size).toBe(1);
    expect(ledger.calls.some((c) => /\/void/.test(c.path))).toBe(false);
    expect(ledger.balanceOf('test', `merchant:${payer}:available`)).toBe(0);
    expect(ledger.balanceOf('test', `merchant:${beneficiary}:available`)).toBe(100_000);
    expect(ledger.violations).toEqual([]);
  }, 120_000);

  it('inválido: el registro del proceso no trae el mensaje de Postgres, el SQL ni la contraseña; sí el nombre del error', () => {
    const log = service.output();
    expect(log).toMatch(/"err":"error"/);
    expect(log).not.toMatch(/terminating connection|administrator command|57P01/i);
    expect(log).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\b[^"\n]*\b(mandates|scheduled_payments)\b/);
    expect(log).not.toContain(dbEnv.DB_PASSWORD);
    expect(log).not.toMatch(/password=|postgres(ql)?:\/\//i);
  });
});
