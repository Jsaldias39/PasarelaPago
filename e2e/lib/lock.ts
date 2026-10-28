import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CANDADO ATÓMICO del stack e2e. Un solo stack a la vez: comparten las bases `pay_*`, los streams `PAY_*` de NATS y el puerto de TigerBeetle, y arrancar otro
 * REINICIA las bases y BORRA los streams del primero (lo vivió P5: dos arranques con 9 s de diferencia pasaron la comprobación de `state.json`, que se escribe tarde).
 *
 * Se adquiere ANTES de tocar bases, NATS o puertos. La creación es atómica: el archivo se escribe COMPLETO con un nombre temporal y se publica con `link(2)`, que falla
 * con EEXIST si ya hay un candado (nunca hay un candado a medio escribir). Un candado ORFANO (su dueño murió, o el PID lo reutiliza otro proceso: se compara el
 * instante de inicio del proceso en /proc) se reclama: se aparta con `rename` —atómico: si dos lo intentan a la vez, gana uno— y se reintenta la creación exclusiva.
 */
export interface LockInfo {
  readonly pid: number;
  /** Instante de inicio del proceso (campo 22 de /proc/<pid>/stat, en ticks): distingue al dueño real de un PID reutilizado. */
  readonly startTime: string | null;
  readonly runId: string;
  readonly startedAt: string;
}

export class StackBusyError extends Error {
  constructor(readonly holder: LockInfo) {
    const at = new Date(holder.startedAt);
    const hhmm = Number.isNaN(at.getTime()) ? holder.startedAt : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    super(`stack en uso por runId ${holder.runId} pid ${holder.pid} desde ${hhmm}. Un solo stack a la vez: esperá a que termine (o, si ese proceso está colgado, matalo; un candado de un proceso muerto se reclama solo).`);
    this.name = 'StackBusyError';
  }
}

/** Instante de inicio de un proceso en ticks (para distinguir reutilización de PID); `null` si no se puede leer (no Linux, proceso muerto). */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // El nombre del comando va entre paréntesis y puede traer espacios y paréntesis: se corta tras el ÚLTIMO «)».
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null; // campo 22 del archivo = índice 19 después de «state» (campo 3)
  } catch {
    return null;
  }
}

/** ¿Está vivo el dueño de este candado (mismo proceso, no un PID reutilizado)? */
export function isHolderAlive(info: LockInfo): boolean {
  try {
    process.kill(info.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false; // ESRCH: no existe
  }
  const now = processStartTime(info.pid);
  // Si ambos instantes se pueden leer y difieren, es otro proceso con el mismo PID: el dueño murió.
  return !(info.startTime !== null && now !== null && info.startTime !== now);
}

export interface StackLock {
  readonly path: string;
  readonly info: LockInfo;
  /** Si se reclamó un candado huérfano, de quién era. */
  readonly reclaimed: LockInfo | undefined;
  /** Libera SOLO si el candado sigue siendo nuestro (mismo runId y pid). Idempotente. */
  release(): void;
}

function readLock(path: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.runId === 'string' && typeof parsed.startedAt === 'string') return { pid: parsed.pid, startTime: parsed.startTime ?? null, runId: parsed.runId, startedAt: parsed.startedAt };
  } catch {
    // inexistente o ilegible
  }
  return undefined;
}

const LOCK_NAME = 'stack.lock';
export const lockPathOf = (runRoot: string): string => join(runRoot, LOCK_NAME);

/** Candado actual (si lo hay y se puede leer), vivo o no. Para informar y para `yarn e2e:down`. */
export function peekLock(runRoot: string): { info: LockInfo; alive: boolean } | undefined {
  const info = readLock(lockPathOf(runRoot));
  return info ? { info, alive: isHolderAlive(info) } : undefined;
}

/**
 * Adquiere el candado o lanza {@link StackBusyError}. NO toca nada más (ni bases, ni NATS, ni puertos): quien pierde no hizo ningún efecto.
 * `pid`/`startTime` se pueden inyectar solo para pruebas.
 */
export function acquireStackLock(runRoot: string, runId: string, options: { pid?: number; startTime?: string | null } = {}): StackLock {
  mkdirSync(runRoot, { recursive: true });
  const path = lockPathOf(runRoot);
  const pid = options.pid ?? process.pid;
  const info: LockInfo = { pid, startTime: options.startTime !== undefined ? options.startTime : processStartTime(pid), runId, startedAt: new Date().toISOString() };
  const temp = `${path}.${pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temp, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
  let reclaimed: LockInfo | undefined;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        linkSync(temp, path); // atómico: falla con EEXIST si ya existe
        return makeLock(path, info, reclaimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = readLock(path);
      if (holder && isHolderAlive(holder)) throw new StackBusyError(holder);
      // Huérfano (o ilegible): se aparta con rename; si otro lo reclamó primero, el rename falla con ENOENT y se reintenta la creación exclusiva.
      const aside = `${path}.stale.${pid}.${Math.random().toString(36).slice(2, 10)}`;
      try {
        renameSync(path, aside);
        if (holder) reclaimed = holder;
        process.stderr.write(`[e2e] candado huérfano reclamado: ${holder ? `runId ${holder.runId} pid ${holder.pid} (${holder.startedAt}) ya no existe` : 'ilegible'}\n`);
        unlinkSync(aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const last = readLock(path);
    if (last) throw new StackBusyError(last);
    throw new Error(`No se pudo adquirir ${path} tras varios intentos`);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // ya no está
    }
  }
}

function makeLock(path: string, info: LockInfo, reclaimed: LockInfo | undefined): StackLock {
  let released = false;
  const signalHandlers: [NodeJS.Signals, () => void][] = [];
  const release = () => {
    if (released) return;
    released = true;
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    process.off('exit', release);
    const current = readLock(path);
    if (current && current.runId === info.runId && current.pid === info.pid) {
      try {
        unlinkSync(path);
      } catch {
        // otro lo borró
      }
    }
  };
  process.once('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      // Si nadie más escucha la señal (solo nosotros), el proceso moriría igual: se suelta el candado y se reenvía la señal con su efecto por defecto.
      // Si hay otros escuchas (cli.ts `up`, que apaga el stack con gracia), ellos llaman a stopStack y éste libera; `exit` es la red de seguridad.
      if (process.listenerCount(signal) <= 1) {
        release();
        process.kill(process.pid, signal);
      }
    };
    signalHandlers.push([signal, handler]);
    process.on(signal, handler);
  }
  return { path, info, reclaimed, release };
}
