import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

const SERVICE_DIR = process.cwd();

/** Compila el servicio: las pruebas de arranque ejecutan `dist/main.js`, el mismo binario que se despliega. */
export function buildService(): void {
  execFileSync('yarn', ['build'], { cwd: SERVICE_DIR, stdio: 'pipe' });
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
export function startService(env: Record<string, string | undefined>): Started {
  const clean: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [name, value] of Object.entries(env)) if (value !== undefined) clean[name] = value;
  const child = spawn(process.execPath, [join(SERVICE_DIR, 'dist/main.js')], { cwd: SERVICE_DIR, env: clean, stdio: ['ignore', 'pipe', 'pipe'] });
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
