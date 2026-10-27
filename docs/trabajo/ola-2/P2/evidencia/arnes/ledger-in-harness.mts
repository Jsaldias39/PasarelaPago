// Arranca SOLO el pay-ledger con las funciones del arnés e2e (e2e/lib/*), tal como lo hace `startStack`: TigerBeetle privado, base reiniciada con su DDL,
// el entorno EXACTO que arma `envFor` y nada heredado. Después ejercita una operación real. No toca los streams de NATS ni el estado del arnés.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_INFRA, SERVICES, envFor, generateSecrets, type EnvContext, type ServiceName } from '/home/user/pasarelapago/e2e/lib/services.ts';
import { ROOT, resetDatabase, startPrivateTigerBeetle } from '/home/user/pasarelapago/e2e/lib/infra.ts';
import { freePorts, spawnNode, tailLog, terminate, waitFor } from '/home/user/pasarelapago/e2e/lib/process.ts';

const runId = `p2c${Date.now().toString(36)}`;
const runDir = join(process.env.SCRATCH as string, runId);
mkdirSync(runDir, { recursive: true });
const ports = await freePorts(SERVICES.length + 2);
const portOf = Object.fromEntries(SERVICES.map((n, i) => [n, ports[i]])) as Record<ServiceName, number>;
const tbPort = ports[SERVICES.length + 1];
const ctx: EnvContext = { runId, ports: portOf, infra: { ...DEFAULT_INFRA, tigerbeetleAddress: `127.0.0.1:${tbPort}` }, secrets: generateSecrets(), receiverPort: ports[SERVICES.length], receiverCaFile: join(runDir, 'x.pem'), kycDir: join(runDir, 'kyc') };
const out: Record<string, unknown> = {};
let tb: Awaited<ReturnType<typeof startPrivateTigerBeetle>> | undefined;
let ledger: ReturnType<typeof spawnNode> | undefined;
try {
  await resetDatabase(DEFAULT_INFRA, 'pay-ledger', true);
  tb = await startPrivateTigerBeetle(runDir, tbPort);
  const env = envFor(ctx, 'pay-ledger');
  out.env_keys = Object.keys(env).sort();
  const started = Date.now();
  ledger = spawnNode('pay-ledger', join(ROOT, 'services/pay-ledger'), 'dist/main.js', env, join(runDir, 'pay-ledger.log'));
  const base = `http://127.0.0.1:${portOf['pay-ledger']}`;
  const ready = await waitFor(async () => (await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1500) })).status === 200, 60_000, () => (ledger?.exit ? 'el proceso salió' : undefined));
  out.ready = ready.ok;
  out.ready_ms = Date.now() - started;
  const call = async (path: string, init: RequestInit & { keyMode?: string | null } = {}) => {
    const headers: Record<string, string> = { 'x-service-id': 'pay-payments', 'idempotency-key': `h-${Math.random().toString(36).slice(2, 12)}`, 'content-type': 'application/json' };
    if (init.keyMode) headers['x-pay-mode'] = init.keyMode;
    const res = await fetch(`${base}${path}`, { ...init, headers });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const m = `mc_${Math.random().toString(36).slice(2, 12).padEnd(10, 'k')}`;
  const tx = (mode: string | null) => call('/transactions', { method: 'POST', keyMode: mode, body: JSON.stringify({ business_ref: `pi_${Math.random().toString(36).slice(2, 12).padEnd(10, 'q')}:capture`, attempt: 1, currency: 'BOB', legs: [{ debit_account: 'connector:mock:clearing', credit_account: `merchant:${m}:pending`, amount_minor: 1234, code: 'charge' }] }) });
  const ok = await tx('test');
  out.post_test_sandbox = ok.status;
  out.post_live_in_sandbox = (await tx('live')).status;
  out.post_no_mode = (await tx(null)).status;
  const bal = await call(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`, { method: 'GET', keyMode: 'test' });
  out.balance_after = bal.body?.balance_minor;
  const logTail = tailLog(join(runDir, 'pay-ledger.log'), 3);
  out.log_has_error = /"level":(50|60)/.test(logTail);
} finally {
  if (ledger) out.ledger_stop = await terminate(ledger, 8000);
  if (tb) out.tb_stop = await terminate(tb.managed, 5000);
  await resetDatabase(DEFAULT_INFRA, 'pay-ledger', false).catch(() => undefined);
  rmSync(runDir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
