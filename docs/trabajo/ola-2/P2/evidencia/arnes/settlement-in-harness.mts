// Arranca SOLO el pay-ledger con las funciones del arnés e2e (e2e/lib/*), tal como lo hace `startStack`: TigerBeetle privado, base reiniciada con su DDL,
// el entorno EXACTO que arma `envFor` y nada heredado. Después ejercita una operación real. No toca los streams de NATS ni el estado del arnés.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_INFRA, SERVICES, envFor, generateSecrets, type EnvContext, type ServiceName } from '/home/user/pasarelapago/e2e/lib/services.ts';
import { ROOT, resetDatabase, startPrivateTigerBeetle } from '/home/user/pasarelapago/e2e/lib/infra.ts';
import { freePorts, spawnNode, tailLog, terminate, waitFor } from '/home/user/pasarelapago/e2e/lib/process.ts';

const runId = `p2s${Date.now().toString(36)}`;
const runDir = join(process.env.SCRATCH as string, runId);
mkdirSync(runDir, { recursive: true });
const ports = await freePorts(SERVICES.length + 2);
const portOf = Object.fromEntries(SERVICES.map((n, i) => [n, ports[i]])) as Record<ServiceName, number>;
const tbPort = ports[SERVICES.length + 1];
const ctx: EnvContext = { runId, ports: portOf, infra: { ...DEFAULT_INFRA, tigerbeetleAddress: `127.0.0.1:${tbPort}` }, secrets: generateSecrets(), receiverPort: ports[SERVICES.length], receiverCaFile: join(runDir, 'x.pem'), kycDir: join(runDir, 'kyc') };
const out: Record<string, unknown> = {};
let settlement: ReturnType<typeof spawnNode> | undefined;
try {
  await resetDatabase(DEFAULT_INFRA, 'pay-settlement', true);
  const env = envFor(ctx, 'pay-settlement');
  out.env_keys = Object.keys(env).sort();
  const started = Date.now();
  settlement = spawnNode('pay-settlement', join(ROOT, 'services/pay-settlement'), 'dist/main.js', env, join(runDir, 'pay-settlement.log'));
  const base = `http://127.0.0.1:${portOf['pay-settlement']}`;
  const ready = await waitFor(async () => (await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(1500) })).status === 200, 60_000, () => (settlement?.exit ? 'el proceso salió' : undefined));
  out.ready = ready.ok;
  out.ready_ms = Date.now() - started;
  const get = async (mode: string | null) => (await fetch(`${base}/payouts`, { headers: { 'x-service-id': 'pay-backoffice', ...(mode ? { 'x-pay-mode': mode } : {}) } })).status;
  out.get_payouts_test_in_sandbox = await get('test');
  out.get_payouts_live_in_sandbox = await get('live');
  out.get_payouts_no_mode = await get(null);
  out.get_payouts_old_name_pay_console = (await fetch(`${base}/payouts`, { headers: { 'x-service-id': 'pay-console', 'x-pay-mode': 'test' } })).status;
} finally {
  if (settlement) out.settlement_stop = await terminate(settlement, 8000);
  await resetDatabase(DEFAULT_INFRA, 'pay-settlement', false).catch(() => undefined);
  rmSync(runDir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
