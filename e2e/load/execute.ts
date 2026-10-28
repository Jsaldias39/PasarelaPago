import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCaptureLines, readPending, type StatementLine } from './ledger-check.ts';
import { buildReport, renderReport, type FullReport } from './report.ts';
import { runLoad, type LoadConfig } from './runner.ts';
import type { Sampler } from './sampler.ts';

/**
 * Una corrida completa de carga, una vez que ya hay un stack: genera la carga, mide la CPU, lee el ledger REAL («ningún doble asiento»), evalúa el criterio de
 * CARGA.md y escribe `report.json` (sin claves) y `resumen.txt`. Lo usan `yarn load` (stack ya arriba, puertos fijos) y `yarn load:harness` (un solo proceso que levanta
 * el stack del arnés, siembra, carga y apaga).
 */
export async function executeLoad(options: {
  readonly config: LoadConfig;
  readonly sampler: Sampler;
  /** URL base de pay-ledger; `undefined` ⇒ el ledger no se mide (NO CONCLUYENTE). */
  readonly ledgerUrl: string | undefined;
  /** Comercio de cada clave, en el mismo orden que `config.keys` (`undefined` ⇒ desconocido). */
  readonly merchantIds: readonly (string | undefined)[];
  readonly outDir: string;
}): Promise<FullReport> {
  const result = await runLoad(options.config);
  const cpu = options.sampler.stop();

  let ledger: FullReport['ledger'] = null;
  if (options.ledgerUrl !== undefined) {
    try {
      if (options.merchantIds.some((m) => m === undefined)) throw new Error('no se pudo saber el comercio de alguna clave (GET /v1/merchants/me)');
      const linesByMerchant = new Map<string, readonly StatementLine[]>();
      for (const id of new Set(options.merchantIds as string[])) linesByMerchant.set(id, await readPending({ baseUrl: options.ledgerUrl.replace(/\/$/, ''), from: result.startedAt }, id));
      ledger = checkCaptureLines(
        result.succeeded.map((s) => ({ id: s.id, merchantId: options.merchantIds[s.merchantIndex]!, netMinor: s.netMinor })),
        linesByMerchant,
      );
    } catch (error) {
      ledger = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const report = buildReport(result, cpu, ledger, cpu.machine.cores);
  mkdirSync(options.outDir, { recursive: true });
  // El informe no lleva las claves ni la lista completa de intentos.
  writeFileSync(join(options.outDir, 'report.json'), JSON.stringify({ ...report, result: { ...report.result, intents: undefined, succeeded: undefined } }, null, 2));
  const text = renderReport(report);
  writeFileSync(join(options.outDir, 'resumen.txt'), `${text}\n`);
  process.stdout.write(`\n${text}\n\nInforme en ${options.outDir}\n`);
  return report;
}
