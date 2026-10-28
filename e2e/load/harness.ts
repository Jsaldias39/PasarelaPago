/**
 * `yarn load:harness` — la prueba de carga de T-01 con el stack del ARNÉS, en UN solo proceso (el arnés usa puertos libres al azar, así que `yarn load` y
 * `yarn seed:sandbox`, que apuntan a puertos fijos, no sirven con él):
 *   1. toma el candado (`e2e/.run/stack.lock`) y levanta `startStack({ mockbank: true })` — 12 servicios reales, TigerBeetle propio, calentamiento de pay-risk — con los
 *      topes de tasa del borde subidos SOLO para esta corrida (RATE_LIMIT_IP_PER_WINDOW / RATE_LIMIT_KEY_PER_WINDOW = 1.000.000: el frenado no es lo que se mide);
 *   2. siembra N comercios sintéticos con `seedMerchant` (alta por la API real del back-office; billetera no hace falta) y comprueba CADA uno con un cobro de prueba
 *      que llegue a `succeeded` (si no, aborta: no se mide un sistema que no cobra);
 *   3. lanza el runner de carga (mismos parámetros que `yarn load`) contra el puerto REAL de pay-edge y el ledger real, con el muestreo de CPU de los procesos del stack;
 *   4. apaga el stack SIEMPRE (finally y señales), escribe report.json / resumen.txt en docs/trabajo/ola-3/P1/evidencia/carga-<corrida>/ y sale con 0 (APRUEBA), 1 (NO APRUEBA) o
 *      3 (NO CONCLUYENTE); 2 si no pudo prepararse el ensayo.
 *
 *   yarn load:harness [--rps 25] [--ramp-seconds 60] [--minutes 5] [--amounts 10000,10003] [--duplicates 0.02] [--merchants 3]
 *                     [--settle-seconds 120] [--timeout-seconds 30] [--max-in-flight 1500] [--prod-timeouts] [--out <carpeta>]
 * `--prod-timeouts` quita los dos ajustes de ENTORNO del arnés (RISK_TIMEOUT_MS=2000 y SCREENING_TIMEOUT_MS=250) y deja los valores operativos (300 y 200 ms): es lo que hay que
 * correr si se quiere ver los hallazgos 9 y 10 de ARNES.md bajo carga.
 * ADVERTENCIA (CARGA.md): esta máquina no representa producción; el resultado encuentra cuellos y errores de concurrencia, no certifica T-01.
 */
import { join } from 'node:path';
import { ROOT } from '../lib/infra.ts';
import { publicApi } from '../lib/flow.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';
import { executeLoad } from './execute.ts';
import { exitCodeOf } from './report.ts';
import { newRunId, type LoadConfig } from './runner.ts';
import { startSampler } from './sampler.ts';

function parseArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!flag.startsWith('--')) throw new Error(`argumento inesperado: ${flag}`);
    if (flag === '--prod-timeouts') {
      map.set('prod-timeouts', '1');
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`falta el valor de ${flag}`);
    map.set(flag.slice(2), value);
    i += 1;
  }
  return map;
}

const num = (args: Map<string, string>, name: string, fallback: number): number => {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} no es un número: ${raw}`);
  return value;
};

/** Por qué se sale con 2 (no se pudo preparar el ensayo), distinto de un resultado de la prueba. */
class SetupError extends Error {}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const merchantsCount = num(args, 'merchants', 3);
  if (!Number.isInteger(merchantsCount) || merchantsCount < 1 || merchantsCount > 50) throw new SetupError('--merchants: entero entre 1 y 50');
  const runId = newRunId();
  const outDir = args.get('out') ?? join(ROOT, 'docs/trabajo/ola-3/P1/evidencia', `carga-${runId}`);

  const rateLimits = { RATE_LIMIT_IP_PER_WINDOW: '1000000', RATE_LIMIT_KEY_PER_WINDOW: '1000000' };
  const prodTimeouts = args.has('prod-timeouts');
  process.stdout.write(`Carga (arnés) ${runId}: levantando el stack real con pay-mockbank; topes de tasa del borde subidos${prodTimeouts ? '; tiempos de riesgo OPERATIVOS (300/200 ms)' : '; tiempos de riesgo del arnés (2000/250 ms, ARNES.md)'}\n`);
  const stack: Stack = await startStack({
    mockbank: true,
    tolerateFailures: false,
    envOverrides: {
      'pay-edge': rateLimits,
      ...(prodTimeouts ? { 'pay-payments': { RISK_TIMEOUT_MS: '300' }, 'pay-risk': { SCREENING_TIMEOUT_MS: '200' } } : {}),
    },
  });

  // El stack se apaga SIEMPRE: al terminar, ante un error y ante SIGINT/SIGTERM.
  let stopping: Promise<unknown> | undefined;
  const shutdown = () => (stopping ??= stopStack(stack, { keepLogs: true }).then((report) => {
    process.stdout.write(`\nApagado: ${JSON.stringify({ leftoverPids: report.leftoverPids, tigerbeetleStopped: report.tigerbeetleStopped, databasesReset: report.databasesReset.length })}\n`);
    return report;
  }));
  const onSignal = (signal: NodeJS.Signals) => {
    process.stderr.write(`\n${signal}: apagando el stack…\n`);
    void shutdown().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (stack.warmedUp && !stack.warmedUp.risk.ready) process.stdout.write('AVISO: el calentamiento de pay-risk no llegó a la racha: la máquina está saturada.\n');

    // 2. Comercios sintéticos, cada uno comprobado con un cobro real de punta a punta.
    const merchants: SeededMerchant[] = [];
    for (let i = 0; i < merchantsCount; i += 1) {
      const merchant = await seedMerchant(stack, { label: `COMERCIO CARGA ${i + 1} (SINTÉTICO)` });
      const known = await waitForEdgeToKnow(stack, merchant);
      if (!known.ok) throw new SetupError(`el borde nunca reconoció la clave del comercio ${i + 1}: ${known.reason}`);
      const api = publicApi(stack, merchant);
      const probe = await api.createQrIntent(10_000, `load-preflight-${runId}-${i}`);
      const settled = probe.status === 201 ? await api.settle(probe.intent.id, 60_000) : undefined;
      if (probe.status !== 201 || settled?.status !== 'succeeded') {
        throw new SetupError(`el cobro de comprobación del comercio ${i + 1} no llegó a succeeded (HTTP ${probe.status}, estado ${settled?.status ?? '—'}${settled?.last_error ? `, ${settled.last_error.code}` : ''}): no se mide un sistema que no cobra`);
      }
      merchants.push(merchant);
    }
    process.stdout.write(`${merchants.length} comercio(s) sembrados y comprobados con un cobro real.\n`);

    // 3. La carga.
    const minutes = num(args, 'minutes', 5);
    const config: LoadConfig = {
      baseUrl: stack.url('pay-edge'),
      keys: merchants.map((m) => m.token),
      peakRps: num(args, 'rps', 25),
      rampSeconds: num(args, 'ramp-seconds', 60),
      durationSeconds: minutes * 60,
      amounts: (args.get('amounts') ?? '10000').split(',').map(Number),
      duplicateFraction: num(args, 'duplicates', 0.02),
      requestTimeoutMs: num(args, 'timeout-seconds', 30) * 1000,
      settleTimeoutSeconds: num(args, 'settle-seconds', 120),
      pollConcurrency: 25,
      maxInFlight: num(args, 'max-in-flight', 1500),
      runId,
    };
    if (config.amounts.some((a) => !Number.isInteger(a) || a <= 0)) throw new SetupError('--amounts: enteros positivos separados por coma (unidades menores)');
    const pids: Record<string, number> = Object.fromEntries([...stack.processes].map(([name, managed]) => [name, managed.pid]));
    if (stack.tigerbeetle) pids.tigerbeetle = stack.tigerbeetle.pid;
    process.stdout.write(`Carga ${runId}: ${config.peakRps} rps pico, rampa ${config.rampSeconds} s, ${minutes} min, ${merchants.length} clave(s) → ${config.baseUrl}\n`);
    const report = await executeLoad({
      config,
      sampler: startSampler({ mode: 'proc', pids }),
      ledgerUrl: stack.url('pay-ledger'),
      merchantIds: merchants.map((m) => m.merchantId),
      outDir,
    });
    return exitCodeOf(report);
  } catch (error) {
    if (error instanceof SetupError) {
      process.stderr.write(`load:harness: ${error.message}\n`);
      return 2;
    }
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await shutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`load:harness falló: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
