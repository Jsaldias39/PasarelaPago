import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId, repoPath } from './helpers/app';
import { waitFor } from './helpers/wait';

/**
 * Gate «Fallos» (PLAN-MAESTRO §7): experimento de inyección de fallos sobre el ledger REAL. Se levanta un TigerBeetle propio en otro puerto (no
 * toca el de desarrollo), se lo mata con SIGKILL en medio del servicio y se observa: (1) lo que el cliente ve mientras está caído, (2) que no queda
 * ningún efecto a medias, (3) que al volver el mismo reintento —con la MISMA clave— termina y mueve el dinero UNA vez, (4) que el invariante global
 * cuadra. Documentado en docs/trabajo/ola-3/P2/GATES.md (gate «Fallos»).
 */
const PORT = 54302;
const BINARY = repoPath('.tools/tigerbeetle/tigerbeetle');
const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
const leg = (debit_account: string, credit_account: string, amount_minor: number, code = 'charge') => ({ debit_account, credit_account, amount_minor, code });

const portOpen = (): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

let dir: string;
let tb: ChildProcess | undefined;
const startTb = async () => {
  tb = spawn(BINARY, ['start', `--addresses=127.0.0.1:${PORT}`, join(dir, '0_0.tigerbeetle')], { stdio: 'ignore' });
  expect(await waitFor(portOpen, 20_000, 200)).toBe(true);
};
const killTb = async () => {
  const proc = tb;
  tb = undefined;
  if (!proc) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGKILL');
  await exited;
  expect(await waitFor(async () => !(await portOpen()), 10_000, 100)).toBe(true);
};

let ctx: LedgerTestContext;
const saved = { address: process.env.TB_ADDRESS, timeout: process.env.TB_TIMEOUT_MS };
beforeAll(async () => {
  expect(existsSync(BINARY)).toBe(true); // lo deja platform/scripts/tigerbeetle-dev.sh start
  dir = mkdtempSync(join(tmpdir(), 'pay-ledger-faults-'));
  const format = spawnSync(BINARY, ['format', '--cluster=0', '--replica=0', '--replica-count=1', join(dir, '0_0.tigerbeetle')], { encoding: 'utf8' });
  expect(format.status).toBe(0);
  await startTb();
  process.env.TB_ADDRESS = `127.0.0.1:${PORT}`;
  process.env.TB_TIMEOUT_MS = '1500'; // el servicio responde 503 en ~1,5 s en vez de colgarse
  ctx = await createLedgerContext();
}, 60_000);
afterAll(async () => {
  await ctx?.close();
  await killTb();
  rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of [['TB_ADDRESS', saved.address], ['TB_TIMEOUT_MS', saved.timeout]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const post = async (path: string, payload: object | undefined, idempotencyKey: string, caller = 'pay-settlement') => ctx.as(caller).post(path, payload).set('idempotency-key', idempotencyKey);
const balance = async (account: string) => {
  const res = await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(account)}`);
  return res.status === 404 ? 0 : (res.body as { balance_minor: number }).balance_minor;
};
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);

describe('TigerBeetle muerto con SIGKILL en medio del servicio (ledger real)', () => {
  it('mientras está caído: 503 ledger_unavailable en escrituras y lecturas, sin efectos a medias; al volver, el MISMO reintento termina una sola vez y el invariante cuadra', async () => {
    const m = merchantId();
    const fundRef = businessRef();
    const fund = { business_ref: fundRef, attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 5000)] };
    expect((await post('/transactions', fund, key(), 'pay-payments')).status).toBe(201);
    const release = { business_ref: businessRef('release'), attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:pending`, `merchant:${m}:available`, 5000, 'release')] };
    expect((await post('/transactions', release, key())).status).toBe(201);
    const holdBody = { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 2000, currency: 'BOB', expires_in_seconds: 300 };
    const hold = checked(ctx, 'POST', '/holds', await post('/holds', holdBody, key()));
    expect(hold.status).toBe(201);
    expect(await balance(`merchant:${m}:available`)).toBe(3000);

    await killTb();

    // — escrituras con TigerBeetle caído —
    const txRef = businessRef();
    const tx = { business_ref: txRef, attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 700)] };
    const started = Date.now();
    const down = await post('/transactions', tx, key(), 'pay-payments');
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('ledger_unavailable');
    expect(Date.now() - started).toBeLessThan(6000); // timeout acotado, no se cuelga
    const newHold = { ...holdBody, business_ref: businessRef('payout'), amount_minor: 100 };
    expect((await post('/holds', newHold, key())).status).toBe(503);
    const postKey = key();
    expect((await post(`/holds/${hold.body.id}/post`, undefined, postKey)).status).toBe(503);
    const voidKey = key();
    expect((await post(`/holds/${hold.body.id}/void`, undefined, voidKey)).status).toBe(503);
    expect((await ctx.as('pay-settlement').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`)).status).toBe(503); // lecturas también: nunca un saldo viejo
    // sin efectos a medias: ni filas del movimiento fallido, ni de la retención nueva, ni evento; la retención previa sigue pendiente
    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE business_ref = $1', [txRef])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM ledger_holds WHERE business_ref = $1', [newHold.business_ref])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM outbox_events WHERE envelope::text LIKE '%' || $1 || '%'", [txRef])).toBe(0);
    expect((await ctx.db.pool.query('SELECT status FROM ledger_holds WHERE id = $1', [hold.body.id])).rows[0].status).toBe('pending');

    // — vuelve TigerBeetle (mismos datos): los MISMOS reintentos, con las MISMAS claves —
    await startTb();
    const okTx = await waitFor(async () => (await post('/transactions', tx, key(), 'pay-payments')).status === 201, 20_000, 500);
    expect(okTx).toBe(true); // el cliente de TigerBeetle se reconecta solo
    const posted = await post(`/holds/${hold.body.id}/post`, undefined, postKey);
    expect(posted.status).toBe(200); // el 503 NO quedó guardado como respuesta final de esa clave
    expect(posted.headers['idempotency-replayed']).toBeUndefined();
    const again = await post(`/holds/${hold.body.id}/post`, undefined, postKey);
    expect(again.status).toBe(200);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect((await post(`/holds/${hold.body.id}/void`, undefined, voidKey)).status).toBe(409); // ya confirmada: la anulación no la deshace

    expect(await count('SELECT count(*)::int AS n FROM ledger_legs WHERE business_ref = $1', [txRef])).toBe(1);
    expect(await balance(`merchant:${m}:pending`)).toBe(700);
    expect(await balance(`merchant:${m}:available`)).toBe(3000);
    expect(await balance('payout:clearing')).toBe(2000);
    const report = await ctx.invariant.check();
    expect(report.ok).toBe(true);
  }, 90_000);

  it('la retención vencida durante la caída se resuelve sola al volver: el monto no se pierde ni se duplica', async () => {
    const m = merchantId();
    expect((await post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [leg(CLEARING, `merchant:${m}:pending`, 900)] }, key(), 'pay-payments')).status).toBe(201);
    expect((await post('/transactions', { business_ref: businessRef('release'), attempt: 1, currency: 'BOB', legs: [leg(`merchant:${m}:pending`, `merchant:${m}:available`, 900, 'release')] }, key())).status).toBe(201);
    const hold = await post('/holds', { business_ref: businessRef('payout'), attempt: 1, debit_account: `merchant:${m}:available`, credit_account: 'payout:clearing', amount_minor: 900, currency: 'BOB', expires_in_seconds: 2 }, key());
    expect(hold.status).toBe(201);
    await killTb();
    await new Promise((resolve) => setTimeout(resolve, 3000)); // espera deliberada: el tiempo de la retención corre mientras TigerBeetle está caído
    await startTb();
    const restored = await waitFor(async () => (await balance(`merchant:${m}:available`)) === 900, 20_000, 500);
    expect(restored).toBe(true);
    expect(await balance('payout:clearing')).toBeGreaterThanOrEqual(0);
    expect((await ctx.invariant.check()).ok).toBe(true);
  }, 60_000);
});
