/**
 * Comandos del arnés e2e:
 *   yarn e2e:up      levanta el stack y lo deja corriendo hasta Ctrl+C (o SIGTERM), que lo apaga y limpia
 *                    (`--mockbank` agrega pay-mockbank, el banco simulado de la capa sandbox, y se lo conecta a pay-connectors)
 *   yarn e2e:down    limpia los restos de un stack cuyo proceso de control murió
 *   yarn e2e:boot    levanta, imprime qué servicio arrancó y cuál no, y apaga
 *   yarn e2e:smoke   levanta, corre el humo (salud + llamadas internas + borde), apaga; sale con 1 si algo falla
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { ALL_SERVICES, cleanupLeftovers, RUN_DIR, SERVICES, startStack, stopStack, type Stack } from './stack.ts';
import { renderSmoke, runSmoke } from './lib/smoke.ts';

function table(stack: Stack): string {
  const rows = ALL_SERVICES.filter((n) => stack.services[n].error !== 'no pedido').map((n) => {
    const s = stack.services[n];
    return `${n.padEnd(15)} ${String(s.port).padEnd(6)} ${String(s.pid ?? '-').padEnd(8)} ${s.healthy ? 'SANO' : s.started ? 'VIVO-NO-SANO' : 'NO ARRANCA'}${s.startupMs ? ` (${s.startupMs} ms)` : ''}${s.error ? `  ← ${s.error}` : ''}`;
  });
  return ['servicio        puerto pid      estado', ...rows].join('\n');
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'boot';
  if (command === 'down') {
    const result = await cleanupLeftovers();
    process.stdout.write(result.state ? `Limpiado: ${result.killed.length} proceso(s) terminados (${result.killed.join(', ') || 'ninguno'}), bases vaciadas, streams borrados.\n` : 'No había ningún stack registrado.\n');
    return 0;
  }
  if (command === 'envprobe') {
    const { probeEnv } = await import('./lib/envprobe.ts');
    const rows = await probeEnv();
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(`${RUN_DIR}/envprobe.json`, JSON.stringify(rows, null, 2));
    for (const r of rows) process.stdout.write(`${r.service.padEnd(15)} ${r.variable.padEnd(42)} ${r.outcome}${r.detail ? `  ← ${r.detail}` : ''}\n`);
    return 0;
  }
  if (!['up', 'boot', 'smoke'].includes(command)) {
    process.stderr.write('uso: node e2e/cli.ts up|down|boot|smoke|envprobe [--mockbank]\n');
    return 2;
  }

  const mockbank = process.argv.includes('--mockbank');
  const stack = await startStack({ mockbank });
  let exitCode = 0;
  try {
    process.stdout.write(`${table(stack)}\n`);
    if (command === 'up') {
      process.stdout.write(`\nStack ${stack.runId} corriendo. Logs: ${stack.runDir}\nCtrl+C para apagar y limpiar.\n`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    } else if (command === 'smoke') {
      const report = await runSmoke(stack);
      process.stdout.write(`\n${renderSmoke(report)}\n`);
      mkdirSync(RUN_DIR, { recursive: true });
      writeFileSync(`${stack.runDir}/smoke.json`, JSON.stringify(report, null, 2));
      exitCode = report.failures > 0 ? 1 : 0;
    } else {
      exitCode = (mockbank ? ALL_SERVICES : SERVICES).every((n) => stack.services[n].healthy) ? 0 : 1;
    }
  } finally {
    const stop = await stopStack(stack);
    process.stdout.write(`\nApagado: ${JSON.stringify({ terminated: stop.terminated, streamsDeleted: stop.streamsDeleted.length, databasesReset: stop.databasesReset.length, tigerbeetleStopped: stop.tigerbeetleStopped, leftoverPids: stop.leftoverPids })}\n`);
  }
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
