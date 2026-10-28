/**
 * `yarn seed:sandbox` — siembra SINTÉTICA y DECLARADA de la capa sandbox (platform/compose.mock.yml). Idempotente: la segunda corrida inserta 0.
 * Requisitos: el Compose arriba (`up -d --wait`) y `node platform/scripts/sandbox-secrets.mjs` hecho (la clave privada del operador sintético vive en
 * platform/.sandbox/operator-private.pem). Escribe platform/.sandbox/seed-state.json (modo 0600) con las claves `sk_test_` de los comercios sembrados.
 * Variables (todas opcionales): SANDBOX_MERCHANTS_URL (http://127.0.0.1:3107), SANDBOX_EDGE_URL (http://127.0.0.1:3101), SANDBOX_LEDGER_URL (http://127.0.0.1:3105),
 * SANDBOX_OPERATOR_ISSUER (pay-sandbox-identity), SANDBOX_DIR (platform/.sandbox). Solo contra loopback salvo SANDBOX_ALLOW_REMOTE=1. Nunca con PAY_MODE=live.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/infra.ts';
import { loadState, realDeps, remoteTarget, runSeed, saveState } from './lib/sandbox-seed.ts';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

async function main(): Promise<number> {
  if (process.env.PAY_MODE === 'live') {
    process.stderr.write('seed:sandbox: PAY_MODE=live. Esta siembra es solo de sandbox y no se corre nunca contra producción.\n');
    return 2;
  }
  const endpoints = {
    merchants: process.env.SANDBOX_MERCHANTS_URL ?? 'http://127.0.0.1:3107',
    edge: process.env.SANDBOX_EDGE_URL ?? 'http://127.0.0.1:3101',
    ledger: process.env.SANDBOX_LEDGER_URL ?? 'http://127.0.0.1:3105',
  };
  if (process.env.SANDBOX_ALLOW_REMOTE !== '1') {
    const remote = Object.values(endpoints).filter((url) => !LOOPBACK.test(url));
    if (remote.length > 0) {
      process.stderr.write(`seed:sandbox: se niega a sembrar contra destinos que no son de esta máquina (${remote.join(', ')}). Con SANDBOX_ALLOW_REMOTE=1 se permite, bajo tu responsabilidad.\n`);
      return 2;
    }
  }
  const dir = process.env.SANDBOX_DIR ?? join(ROOT, 'platform/.sandbox');
  let privateKey: string;
  try {
    privateKey = readFileSync(join(dir, 'operator-private.pem'), 'utf8');
  } catch {
    process.stderr.write(`seed:sandbox: falta ${join(dir, 'operator-private.pem')}. Corré primero: node platform/scripts/sandbox-secrets.mjs\n`);
    return 2;
  }
  const issuer = process.env.SANDBOX_OPERATOR_ISSUER ?? 'pay-sandbox-identity';
  const stateFile = join(dir, 'seed-state.json');
  const report = await runSeed(realDeps(remoteTarget(endpoints, privateKey), issuer), loadState(stateFile), (state) => saveState(stateFile, state));
  process.stdout.write(`${JSON.stringify({ declaracion: 'SEMILLA SINTÉTICA DE SANDBOX: ningún dato es real', ...report }, null, 2)}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`seed:sandbox falló: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
