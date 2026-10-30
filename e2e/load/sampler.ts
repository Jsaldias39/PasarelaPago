import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Lectura de CPU (ticks) de un proceso desde /proc/<pid>/stat: utime + stime (campos 14 y 15). El nombre del comando va entre paréntesis y puede traer espacios. */
export function parseProcStat(stat: string): { ticks: number } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(' '); // fields[0] = estado (campo 3)
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(utime) && Number.isFinite(stime) ? { ticks: utime + stime } : null;
}

/** Ticks de CPU de toda la máquina (línea `cpu` de /proc/stat): total y ociosos (idle + iowait). */
export function parseMachineStat(text: string): { total: number; idle: number } | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 5 || values.some((v) => !Number.isFinite(v))) return null;
  return { total: values.reduce((a, b) => a + b, 0), idle: values[3]! + (values[4] ?? 0) };
}

/** `docker stats --format '{{.Name}} {{.CPUPerc}}'` ⇒ CPU por contenedor (100 % = un núcleo). */
export function parseDockerStats(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\S+)\s+([0-9.]+)%\s*$/.exec(line.trim());
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

export interface CpuReport {
  readonly mode: 'proc' | 'docker' | 'none';
  readonly samples: number;
  /** Por proceso o contenedor: media y máximo, en % de UN núcleo (400 % = los 4 núcleos). */
  readonly perProcess: Record<string, { avg: number; max: number }>;
  /** CPU ocupada de TODA la máquina (0 a 100) y carga del sistema. */
  readonly machine: { busyAvg: number | null; busyMax: number | null; loadavgMax: number | null; cores: number };
  /** Los procesos que más CPU usaron (media), de mayor a menor: dónde está el cuello. */
  readonly top: { name: string; avg: number }[];
}

export interface Sampler {
  stop(): CpuReport;
}

/**
 * Muestrea cada `intervalMs` mientras corre la prueba. `proc`: PIDs conocidos (por ejemplo los de `e2e/.run/state.json`); `docker`: contenedores `pay-*`; `none`: solo la
 * máquina. Siempre mide la máquina entera y la carga del sistema: es lo que dice si el resultado habla del diseño o del hardware de prueba.
 */
export function startSampler(options: { mode: 'proc' | 'docker' | 'none'; pids?: Record<string, number>; intervalMs?: number; cores?: number }): Sampler {
  const interval = options.intervalMs ?? 5000;
  const clk = Number(process.env.CLK_TCK ?? 100);
  const perProc = new Map<string, number[]>();
  const machine: number[] = [];
  const loads: number[] = [];
  let samples = 0;
  const lastTicks = new Map<string, number>();
  let lastMachine = parseMachineStat(readSafe('/proc/stat'));
  let lastAt = Date.now();
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const elapsed = (now - lastAt) / 1000;
      lastAt = now;
      samples += 1;
      const m = parseMachineStat(readSafe('/proc/stat'));
      if (m && lastMachine && m.total > lastMachine.total) machine.push((1 - (m.idle - lastMachine.idle) / (m.total - lastMachine.total)) * 100);
      lastMachine = m;
      const load = Number(readSafe('/proc/loadavg').split(' ')[0]);
      if (Number.isFinite(load)) loads.push(load);
      if (options.mode === 'proc') {
        for (const [name, pid] of Object.entries(options.pids ?? {})) {
          const parsed = parseProcStat(readSafe(`/proc/${pid}/stat`));
          if (!parsed) continue;
          const before = lastTicks.get(name);
          lastTicks.set(name, parsed.ticks);
          if (before !== undefined && elapsed > 0) push(perProc, name, ((parsed.ticks - before) / clk / elapsed) * 100);
        }
      } else if (options.mode === 'docker') {
        const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}}'], { timeout: 15_000 });
        for (const [name, cpu] of parseDockerStats(stdout)) if (/(^|[-_])pay[-_]/.test(name)) push(perProc, name, cpu);
      }
    } catch {
      // una muestra perdida no invalida la prueba
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), interval);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      const perProcess: Record<string, { avg: number; max: number }> = {};
      for (const [name, values] of perProc) perProcess[name] = { avg: mean(values), max: Math.max(...values) };
      const top = Object.entries(perProcess).map(([name, v]) => ({ name, avg: v.avg })).sort((a, b) => b.avg - a.avg).slice(0, 5);
      return {
        mode: options.mode,
        samples,
        perProcess,
        machine: { busyAvg: machine.length ? mean(machine) : null, busyMax: machine.length ? Math.max(...machine) : null, loadavgMax: loads.length ? Math.max(...loads) : null, cores: options.cores ?? cpuCount() },
        top,
      };
    },
  };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const push = (map: Map<string, number[]>, key: string, value: number) => map.set(key, [...(map.get(key) ?? []), value]);
function readSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
function cpuCount(): number {
  return readSafe('/proc/cpuinfo').split('\n').filter((l) => l.startsWith('processor')).length || 1;
}
