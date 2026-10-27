import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { type IsolatedDatabase, TEST_DATABASE_URL, createIsolatedDatabase } from '@pay/testing';
import { repoPath } from './app';
import { waitFor } from './wait';

/** Un puerto libre que el sistema operativo nos da. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export interface RealLedger {
  readonly url: string;
  readonly db: IsolatedDatabase;
  /** POST firmado como `pay-payments` (el llamador del ledger que registra cobros). */
  post(path: string, body: object, key?: string, mode?: 'test' | 'live'): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

/**
 * Arranca el pay-ledger REAL (`services/pay-ledger/dist/main.js`, el binario que se despliega) como un proceso aparte, contra
 * TigerBeetle real y un esquema aislado de Postgres. pay-settlement no importa su código: solo le habla por HTTP, como en producción.
 */
export async function startRealLedger(): Promise<RealLedger> {
  const entry = repoPath('services/pay-ledger/dist/main.js');
  if (!existsSync(entry)) throw new Error('Falta services/pay-ledger/dist/main.js: corré `yarn build` en services/pay-ledger');
  const db = await createIsolatedDatabase([
    repoPath('services/pay-ledger/sql/001_ledger.sql'),
    repoPath('contracts/packages/outbox/sql/001_outbox_inbox.sql'),
    repoPath('contracts/packages/idempotency/sql/001_idempotency_keys.sql'),
  ]);
  const port = await freePort();
  const url = new URL(TEST_DATABASE_URL);
  const child: ChildProcess = spawn('node', [entry], {
    cwd: repoPath('services/pay-ledger'),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PORT: String(port),
      LOG_LEVEL: 'warn',
      DB_HOST: url.hostname,
      DB_PORT: url.port || '5432',
      DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username),
      DB_PASSWORD: decodeURIComponent(url.password),
      PGOPTIONS: `-c search_path=${db.schema}`,
      TB_ADDRESS: process.env.TB_ADDRESS ?? '127.0.0.1:54300',
      // Ids de TigerBeetle propios de este proceso: las cuentas de plataforma (platform:fees, payout:clearing) son de nombre fijo y el
      // TigerBeetle de desarrollo lo comparten otras suites; sin esto los saldos absolutos dependerían de quién corrió antes.
      LEDGER_ID_NAMESPACE: `it${db.schema.slice(2)}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString().slice(0, 2000)));
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`pay-ledger terminó (${child.exitCode}): ${stderr}`);
      return fetch(`${base}/health/ready`).then((r) => r.ok, () => false);
    }, 30_000, 200);
  } catch (error) {
    child.kill('SIGTERM');
    await db.drop();
    throw error;
  }
  return {
    url: base,
    db,
    async post(path, body, key = `seed-${Math.random().toString(36).slice(2, 14)}`, mode = 'test') {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-id': 'pay-payments', 'x-pay-mode': mode, 'idempotency-key': key }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    async stop() {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      child.stderr?.destroy();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
      await db.drop();
    },
  };
}
