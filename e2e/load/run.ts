/**
 * `yarn load` — prueba de carga de T-01 contra el stack REAL (API pública de pay-edge con claves `sk_test_`). NO levanta nada: el stack tiene que estar arriba
 * (`platform/compose.mock.yml` + `yarn seed:sandbox`, o `yarn e2e:up`). El criterio de aceptación está escrito ANTES en docs/trabajo/ola-3/P1/CARGA.md.
 *
 *   yarn load [--base http://127.0.0.1:3101] [--seed-state platform/.sandbox/seed-state.json | --key sk_test_… (repetible)]
 *             [--rps 25] [--ramp-seconds 60] [--minutes 5] [--amounts 10000,10003] [--duplicates 0.02]
 *             [--settle-seconds 120] [--timeout-seconds 30] [--max-in-flight 1500]
 *             [--ledger-url http://127.0.0.1:3105 | off] [--cpu auto|proc|docker|none] [--out <carpeta>] [--allow-remote]
 *
 * Salida 0 = APRUEBA · 1 = NO APRUEBA · 3 = NO CONCLUYENTE (reservas: 429, generador saturado, algo sin medir) · 2 = uso. Escribe report.json y resumen.txt en --out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/infra.ts';
import { executeLoad } from './execute.ts';
import { exitCodeOf } from './report.ts';
import { newRunId, type LoadConfig } from './runner.ts';
import { startSampler } from './sampler.ts';

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;

function parseArgs(argv: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!flag.startsWith('--')) throw new Error(`argumento inesperado: ${flag}`);
    const name = flag.slice(2);
    if (name === 'allow-remote') {
      map.set(name, ['1']);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`falta el valor de ${flag}`);
    map.set(name, [...(map.get(name) ?? []), value]);
    i += 1;
  }
  return map;
}

const number = (args: Map<string, string[]>, name: string, fallback: number): number => {
  const raw = args.get(name)?.[0];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} no es un número: ${raw}`);
  return value;
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const base = args.get('base')?.[0] ?? 'http://127.0.0.1:3101';
  if (!LOOPBACK.test(base) && !args.has('allow-remote')) {
    process.stderr.write(`load: se niega a cargar un destino que no es de esta máquina (${base}). Con --allow-remote se permite, bajo tu responsabilidad (y solo sandbox).\n`);
    return 2;
  }

  // Claves y, si se conocen, el comercio de cada una (para leer el ledger).
  const keys: string[] = [...(args.get('key') ?? [])];
  const merchantByKey = new Map<string, string>();
  if (keys.length === 0) {
    const stateFile = args.get('seed-state')?.[0] ?? join(ROOT, 'platform/.sandbox/seed-state.json');
    if (!existsSync(stateFile)) {
      process.stderr.write(`load: faltan claves. Pasá --key sk_test_… o sembrá con \`yarn seed:sandbox\` (${stateFile}).\n`);
      return 2;
    }
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { merchants: Record<string, { merchantId: string; token: string }> };
    for (const m of Object.values(state.merchants)) {
      keys.push(m.token);
      merchantByKey.set(m.token, m.merchantId);
    }
  }
  for (const key of keys) {
    if (!key.startsWith('sk_test_')) {
      process.stderr.write('load: solo se admiten claves sk_test_ (sandbox).\n');
      return 2;
    }
  }

  const minutes = number(args, 'minutes', 5);
  const config: LoadConfig = {
    baseUrl: base.replace(/\/$/, ''),
    keys,
    peakRps: number(args, 'rps', 25),
    rampSeconds: number(args, 'ramp-seconds', 60),
    durationSeconds: minutes * 60,
    amounts: (args.get('amounts')?.[0] ?? '10000').split(',').map(Number),
    duplicateFraction: number(args, 'duplicates', 0.02),
    requestTimeoutMs: number(args, 'timeout-seconds', 30) * 1000,
    settleTimeoutSeconds: number(args, 'settle-seconds', 120),
    pollConcurrency: 25,
    maxInFlight: number(args, 'max-in-flight', 1500),
    runId: newRunId(),
  };
  if (config.amounts.some((a) => !Number.isInteger(a) || a <= 0)) throw new Error('--amounts: enteros positivos separados por coma (unidades menores)');

  // Quién mide la CPU: procesos del arnés (state.json) o contenedores pay-*.
  const cpuArg = args.get('cpu')?.[0] ?? 'auto';
  const stateJson = join(ROOT, 'e2e/.run/state.json');
  let sampler: ReturnType<typeof startSampler>;
  if ((cpuArg === 'auto' || cpuArg === 'proc') && existsSync(stateJson)) {
    const state = JSON.parse(readFileSync(stateJson, 'utf8')) as { pids: Record<string, number> };
    sampler = startSampler({ mode: 'proc', pids: state.pids });
  } else if (cpuArg === 'docker' || (cpuArg === 'auto' && dockerHasPayContainers())) {
    sampler = startSampler({ mode: 'docker' });
  } else {
    sampler = startSampler({ mode: 'none' });
  }

  const ledgerUrl = args.get('ledger-url')?.[0] ?? 'http://127.0.0.1:3105';
  const outDir = args.get('out')?.[0] ?? join(ROOT, 'docs/trabajo/ola-3/P1/evidencia', `carga-${config.runId}`);
  const merchantIds = await merchantIdsOf(config, merchantByKey);
  const report = await executeLoad({ config, sampler, ledgerUrl: ledgerUrl === 'off' ? undefined : ledgerUrl, merchantIds, outDir });
  return exitCodeOf(report);
}

async function merchantIdsOf(config: LoadConfig, known: Map<string, string>): Promise<(string | undefined)[]> {
  return Promise.all(
    config.keys.map(async (key) => {
      const hit = known.get(key);
      if (hit) return hit;
      const res = await fetch(`${config.baseUrl}/v1/merchants/me`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (!res || res.status !== 200) return undefined;
      return ((await res.json().catch(() => undefined)) as { id?: string } | undefined)?.id;
    }),
  );
}

function dockerHasPayContainers(): boolean {
  try {
    return execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8', timeout: 10_000 }).split('\n').some((n) => /^pay-pay-(edge|payments)/.test(n));
  } catch {
    return false;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`load falló: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
