import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const SERVICE_DIR = process.cwd();

/** Carpeta de un servicio hermano (`pay-mockbank`, `pay-qr`) o la de este servicio si no se nombra ninguno. */
const dirOf = (service?: string): string => (service ? join(SERVICE_DIR, '..', service) : SERVICE_DIR);

/** Compila el servicio (si hace falta): las pruebas de arranque ejecutan `dist/main.js`, el mismo binario que se despliega. Solo se ejecuta el binario de otro servicio, nunca se importa su código. */

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

export function buildService(service?: string): void {
  buildIfStale(dirOf(service));
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
 * Lanza `node dist/main.js` con un entorno ARMADO DESDE CERO: solo `PATH` y lo que se pasa. Así una variable heredada del entorno de pruebas
 * (por ejemplo el `PAY_MODE=sandbox` de `test/env.ts`) no puede tapar la ausencia que se quiere probar.
 */
export function startService(env: Record<string, string | undefined>, service?: string): Started {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) clean[name] = value;
  const child = spawn(process.execPath, [join(dirOf(service), 'dist/main.js')], { cwd: dirOf(service), env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
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
