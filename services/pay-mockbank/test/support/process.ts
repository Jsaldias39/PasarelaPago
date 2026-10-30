import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const SERVICES_DIR = join(process.cwd(), '..');

/** Compila un servicio (si hace falta): las pruebas de arranque ejecutan `dist/main.js`, el mismo binario que se despliega. */

/** Fecha de modificación más reciente de los `.ts` bajo `src/` (sin entrar a node_modules). */
function newestSource(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(path));
    else if (entry.name.endsWith('.ts')) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * Compila solo si hace falta (`dist/main.js` más viejo que algún `src/**\/*.ts`) y bajo un candado de archivo: dos suites que corren en paralelo
 * no reescriben el mismo `dist/` ni lanzan un proceso mientras otro lo está escribiendo.
 */
function buildIfStale(dir: string): void {
  const fresh = (): boolean => existsSync(join(dir, 'dist/main.js')) && statSync(join(dir, 'dist/main.js')).mtimeMs >= newestSource(join(dir, 'src'));
  if (fresh()) return;
  const lock = `/tmp/pay-build-${dir.split('/').pop() ?? 'svc'}.lock`;
  execFileSync('flock', [lock, 'sh', '-c', `cd "${dir}" && yarn build`], { stdio: 'pipe' });
}

export function buildService(name: string): void {
  buildIfStale(join(SERVICES_DIR, name));
}

/** Un puerto libre del sistema operativo (se cierra antes de devolverlo). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Started {
  readonly child: ChildProcess;
  readonly output: () => string;
  /** Resuelve con el código de salida cuando el proceso termina. */
  readonly exited: Promise<number | null>;
}

/**
 * Lanza `node dist/main.js` de un servicio con un entorno ARMADO DESDE CERO: solo `PATH` y lo que se pasa. Así una variable heredada del
 * entorno de pruebas (por ejemplo el `PAY_MODE=sandbox` de `test/env.ts`) no puede tapar la ausencia que se quiere probar.
 */
export function startService(name: string, env: Record<string, string | undefined>): Started {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
  const dir = join(SERVICES_DIR, name);
  const child = spawn(process.execPath, [join(dir, 'dist/main.js')], { cwd: dir, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => (buffer += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (buffer += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output: () => buffer, exited };
}

/** Espera por condición (no por tiempo fijo): reintenta `probe` hasta que devuelva algo o venza `timeoutMs`. */
export async function until<T>(probe: () => Promise<T | undefined>, timeoutMs: number, abort?: Promise<unknown>): Promise<T | undefined> {
  let aborted = false;
  void abort?.then(() => (aborted = true));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !aborted) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/** Baja el proceso con SIGTERM (apagado ordenado) y espera a que termine; si no, SIGKILL. */
export async function stop(started: Started): Promise<void> {
  if (started.child.exitCode !== null || started.child.signalCode !== null) return;
  started.child.kill('SIGTERM');
  const timeout = setTimeout(() => started.child.kill('SIGKILL'), 10_000);
  await started.exited;
  clearTimeout(timeout);
}
