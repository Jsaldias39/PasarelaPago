import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

/** Reserva `count` puertos libres a la vez (todos abiertos hasta tenerlos, así no se repiten) y los suelta. */
export async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server));
    })),
  );
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}

export interface Managed {
  readonly name: string;
  readonly child: ChildProcess;
  readonly pid: number;
  readonly logFile: string;
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  readonly exited: Promise<void>;
}

/** Arranca `node dist/main.js` del servicio como proceso hijo, con SOLO el entorno que se le arma (nada heredado). */
export function spawnNode(name: string, cwd: string, entry: string, env: Record<string, string>, logFile: string): Managed {
  return spawnProcess(name, process.execPath, [entry], cwd, env, logFile);
}

/** Arranca cualquier ejecutable como proceso hijo con un entorno mínimo; su salida va a `logFile`. */
export function spawnProcess(name: string, command: string, args: string[], cwd: string, env: Record<string, string>, logFile: string): Managed {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(command, args, {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const managed: Managed = {
    name,
    child,
    pid: child.pid ?? -1,
    logFile,
    exit: undefined,
    exited: new Promise<void>((resolve) => {
      child.once('exit', (code, signal) => {
        managed.exit = { code, signal };
        resolve();
      });
      child.once('error', () => {
        managed.exit = { code: -1, signal: null };
        resolve();
      });
    }),
  };
  return managed;
}

export function tailLog(file: string, lines = 12): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(sin log)';
  }
}

/** Espera una condición (sondeo corto, nunca una pausa fija). `check` devuelve un motivo de fallo definitivo o `undefined` si sigue esperando. */
export async function waitFor(probe: () => Promise<boolean>, timeoutMs: number, abort?: () => string | undefined, intervalMs = 150): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe().catch(() => false)) return { ok: true };
    const reason = abort?.();
    if (reason) return { ok: false, reason };
    if (Date.now() > deadline) return { ok: false, reason: `no estuvo listo en ${timeoutMs} ms` };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Pide un cierre ordenado (SIGTERM) y, si no sale a tiempo, lo mata (SIGKILL) por su PID. */
export async function terminate(managed: Managed, graceMs = 10_000): Promise<'exited' | 'killed' | 'already'> {
  if (managed.exit) return 'already';
  managed.child.kill('SIGTERM');
  const result = await Promise.race([managed.exited.then(() => 'exited' as const), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs).unref())]);
  if (result === 'exited') return 'exited';
  managed.child.kill('SIGKILL');
  await managed.exited;
  return 'killed';
}

/** ¿Sigue vivo ese PID y es realmente un `node` con ese directorio de trabajo? (para limpiar restos sin matar procesos ajenos) */
export function isOurProcess(pid: number, cwdEndsWith: string): boolean {
  try {
    return readlinkSync(`/proc/${pid}/cwd`).endsWith(cwdEndsWith);
  } catch {
    return false;
  }
}
