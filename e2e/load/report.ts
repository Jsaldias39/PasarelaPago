import type { CpuReport } from './sampler.ts';
import type { LedgerCheck } from './ledger-check.ts';
import { CRITERIA, evaluate, type Evaluation, type Measured } from './criteria.ts';
import type { LoadResult } from './runner.ts';
import { round } from './stats.ts';

export interface FullReport {
  readonly result: LoadResult;
  readonly cpu: CpuReport;
  readonly ledger: LedgerCheck | { error: string } | null;
  readonly evaluation: Evaluation;
  readonly measured: Measured;
  readonly environment: { readonly nproc: number; readonly note: string };
}

export const ENVIRONMENT_NOTE =
  'Esta máquina (4 vCPU compartidas, Postgres/NATS/Redis/Temporal/TigerBeetle/Watchman y los 12 servicios en el MISMO host) NO representa el despliegue de producción (Coolify multiservidor, T-01). El resultado sirve para encontrar cuellos de botella y errores de concurrencia, NO para certificar T-01.';

export function measure(result: LoadResult, cpu: CpuReport, ledger: FullReport['ledger']): Measured {
  const ledgerOk = ledger !== null && !('error' in ledger);
  return {
    sent: result.sent,
    answered: result.answered,
    status5xx: result.status5xx,
    status429: result.status429,
    noResponse: result.noResponse,
    runnerDropped: result.runnerDropped,
    p99Ms: result.createLatencyMs.p99,
    sendLagP99Ms: result.sendLagMs.p99,
    created: result.created,
    stuck: result.stuck,
    doubleEntries: ledgerOk ? ledger.doubleEntries : null,
    idempotencyViolations: result.idempotencyViolations,
    missingEntries: ledgerOk ? ledger.missingEntries : null,
    machineBusyPercentAvg: cpu.machine.busyAvg,
  };
}

export function buildReport(result: LoadResult, cpu: CpuReport, ledger: FullReport['ledger'], nproc: number): FullReport {
  const measured = measure(result, cpu, ledger);
  return { result, cpu, ledger, evaluation: evaluate(measured), measured, environment: { nproc, note: ENVIRONMENT_NOTE } };
}

const ms = (v: number | null) => (v === null ? '—' : `${round(v, 0)} ms`);

export function renderReport(r: FullReport): string {
  const { result: x, cpu, evaluation: ev } = r;
  const lines: string[] = [];
  lines.push(`PRUEBA DE CARGA (T-01) — corrida ${x.config.runId} — ${x.startedAt}`);
  lines.push(`Plan: pico ${x.config.peakRps} rps, rampa ${x.config.rampSeconds} s, duración ${x.config.durationSeconds} s, ${x.config.keys} clave(s) sk_test_, ${(x.config.duplicateFraction * 100).toFixed(1)} % de pedidos repetidos con la misma clave`);
  lines.push(`Enviados ${x.sent} (planificados ${x.planned}) · con respuesta ${x.answered} · sin respuesta (ambiguos) ${x.noResponse} · descartados por el generador ${x.runnerDropped}`);
  lines.push(`Estados HTTP: ${Object.entries(x.byStatus).map(([k, v]) => `${k}×${v}`).join('  ') || '—'}`);
  if (Object.keys(x.byErrorCode).length > 0) lines.push(`Errores por código: ${Object.entries(x.byErrorCode).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  lines.push(`Latencia de POST /v1/payment_intents: p50 ${ms(x.createLatencyMs.p50)} · p95 ${ms(x.createLatencyMs.p95)} · p99 ${ms(x.createLatencyMs.p99)} · máx ${ms(x.createLatencyMs.max)}`);
  lines.push(`Retraso de salida del generador: p99 ${ms(x.sendLagMs.p99)} · máx ${ms(x.sendLagMs.max)}`);
  lines.push(`Intentos creados ${x.created}: ${Object.entries(x.terminalByStatus).map(([k, v]) => `${k}×${v}`).join('  ') || 'ninguno terminal'} · colgados ${x.stuck}${x.stuck ? ` (ej.: ${x.stuckSample.join(', ')})` : ''}`);
  if (Object.keys(x.failedByCode).length > 0) lines.push(`Intentos failed por código: ${Object.entries(x.failedByCode).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  lines.push(`Tiempo hasta terminal: p50 ${ms(x.timeToTerminalMs.p50)} · p95 ${ms(x.timeToTerminalMs.p95)} · p99 ${ms(x.timeToTerminalMs.p99)}`);
  if (r.ledger === null) lines.push('Ledger: NO MEDIDO (sin --ledger-url o sin id de comercio)');
  else if ('error' in r.ledger) lines.push(`Ledger: NO MEDIDO (${r.ledger.error})`);
  else lines.push(`Ledger: ${r.ledger.checkedIntents} intentos succeeded revisados · ${r.ledger.linesRead} líneas leídas · asientos duplicados ${r.ledger.doubleEntries} · faltantes ${r.ledger.missingEntries} · importes distintos ${r.ledger.amountMismatches}`);
  lines.push(`Idempotencia: claves que devolvieron intentos distintos ${x.idempotencyViolations}`);
  lines.push(`Saturación (${cpu.mode}, ${cpu.samples} muestras): CPU de la máquina media ${cpu.machine.busyAvg === null ? '—' : cpu.machine.busyAvg.toFixed(0)} % / máx ${cpu.machine.busyMax === null ? '—' : cpu.machine.busyMax.toFixed(0)} % de ${cpu.machine.cores} núcleos · carga del sistema máx ${cpu.machine.loadavgMax ?? '—'}`);
  if (cpu.top.length > 0) lines.push(`Procesos con más CPU (media, 100 % = un núcleo): ${cpu.top.map((t) => `${t.name} ${t.avg.toFixed(0)} %`).join(' · ')}`);
  lines.push('');
  lines.push(`CRITERIO (escrito antes: docs/trabajo/ola-3/P1/CARGA.md): p99 < ${CRITERIA.p99MaxMs} ms · 5xx < ${(CRITERIA.serverErrorRateMax * 100).toFixed(1)} % · colgados = ${CRITERIA.stuckMax} · doble asiento = ${CRITERIA.doubleEntriesMax}`);
  for (const c of ev.checks) lines.push(`  ${c.result.padEnd(9)} ${c.name}: objetivo ${c.target} · observado ${c.observed}`);
  for (const c of ev.caveats) lines.push(`  RESERVA   ${c}`);
  lines.push(`VEREDICTO: ${ev.verdict.replace('_', ' ')}`);
  lines.push(r.environment.note);
  return lines.join('\n');
}

export const exitCodeOf = (r: FullReport): number => (r.evaluation.verdict === 'APRUEBA' ? 0 : r.evaluation.verdict === 'NO_APRUEBA' ? 1 : 3);
