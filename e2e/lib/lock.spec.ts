import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_INFRA } from './services.ts';
import { acquireStackLock, isHolderAlive, lockPathOf, peekLock, processStartTime, StackBusyError } from './lock.ts';
import { cleanupLeftovers, startStack } from '../stack.ts';

/**
 * El candado del stack es ATÓMICO y temprano (defecto hallado por P5: dos arranques con 9 s de diferencia reiniciaron las bases y borraron los streams del primero).
 * Estas pruebas NO levantan ningún stack: usan una carpeta temporal como `e2e/.run`, procesos hijos reales para las carreras y una infraestructura inalcanzable
 * para demostrar que quien pierde no tocó nada (si hubiera llegado a las bases, a NATS o a los puertos, fallaría con OTRO mensaje).
 */
const LOCK_TS = join(__dirname, 'lock.ts');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stacklock-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Un proceso hijo que intenta adquirir el candado. Imprime `WON <pid>` o `LOST <mensaje>`. El ganador NO retiene el candado por un plazo fijo: lo retiene hasta que el padre
 * le CIERRA la entrada estándar, y el padre lo hace cuando TODOS los hijos ya informaron. Así el resultado no depende de cuánto tarde cada hijo en arrancar (carga de la
 * máquina, caché de transformación en frío): un plazo fijo permitía que un hijo tardío llegara cuando el ganador ya había soltado y ganara otra vez.
 * `delayMs` simula un arranque lento de ese hijo.
 */
const RACER = `
  const [lockModule, root, delayMs] = process.argv.slice(1);
  new Promise((resolve) => setTimeout(resolve, Number(delayMs))).then(() => import(lockModule)).then(async (m) => {
    try {
      const lock = m.acquireStackLock(root, 'racer' + process.pid);
      console.log('WON ' + process.pid + (lock.reclaimed ? ' RECLAIMED ' + lock.reclaimed.runId : ''));
      await new Promise((resolve) => { process.stdin.on('end', resolve); process.stdin.resume(); });
      lock.release();
    } catch (error) {
      console.log('LOST ' + error.message);
    }
  });`;
/** Lanza `count` hijos a la vez (cada uno con su retraso de arranque) y espera, por condición, a que todos informen; recién entonces suelta al ganador. */
const race = async (count: number, delays: readonly number[] = []): Promise<string[]> => {
  const children = Array.from({ length: count }, (_, i) => spawn(process.execPath, ['--no-warnings', '-e', RACER, '--', LOCK_TS, root, String(delays[i] ?? 0)], { stdio: ['pipe', 'pipe', 'inherit'] }));
  const lines = await Promise.all(
    children.map(
      (child) =>
        new Promise<string>((resolve) => {
          let out = '';
          child.stdout!.on('data', (c: Buffer) => {
            out += c.toString();
            if (out.includes('\n')) resolve(out.trim());
          });
          child.once('exit', () => resolve(out.trim())); // un hijo que muere sin informar queda como línea vacía y la aserción lo delata
        }),
    ),
  );
  for (const child of children) child.stdin!.end(); // todos informaron: ahora sí el ganador suelta
  await Promise.all(children.map((child) => new Promise((resolve) => (child.exitCode !== null ? resolve(undefined) : child.once('exit', resolve)))));
  return lines;
};
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
};
/** Espera la primera línea del hijo; si el hijo muere antes (p. ej. no pudo cargar el módulo), falla en vez de colgar la prueba. */
const firstLine = (child: ReturnType<typeof spawn>) =>
  new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`el proceso hijo terminó (código ${String(code)}) antes de adquirir el candado`)));
  });
const writeOrphan = (info: Record<string, unknown>) => writeFileSync(lockPathOf(root), JSON.stringify(info));

describe('candado del stack — nivel CORRECTO', () => {
  it('adquiere con pid, runId y fecha; el segundo falla con «stack en uso por runId X pid Y desde HH:MM»; liberar lo deja tomable', () => {
    const first = acquireStackLock(root, 'runA');
    expect(JSON.parse(readFileSync(first.path, 'utf8'))).toMatchObject({ pid: process.pid, runId: 'runA' });
    expect(peekLock(root)).toMatchObject({ alive: true, info: { runId: 'runA' } });
    const error = (() => {
      try {
        acquireStackLock(root, 'runB');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(StackBusyError);
    expect(error!.message).toMatch(new RegExp(`^stack en uso por runId runA pid ${process.pid} desde \\d{2}:\\d{2}`));
    first.release();
    expect(existsSync(first.path)).toBe(false);
    const second = acquireStackLock(root, 'runB');
    expect(second.reclaimed).toBeUndefined();
    second.release();
  });

  it('liberar es idempotente y NUNCA borra el candado de otro (el dueño nuevo conserva el suyo)', () => {
    const a = acquireStackLock(root, 'runA');
    a.release();
    const b = acquireStackLock(root, 'runB');
    a.release(); // el viejo vuelve a soltar: no debe llevarse el de B
    expect(peekLock(root)?.info.runId).toBe('runB');
    b.release();
    expect(peekLock(root)).toBeUndefined();
  });
});

describe('candado del stack — nivel LÍMITE: carreras y huérfanos', () => {
  it('DOS arranques simultáneos ⇒ exactamente UNO gana; los otros fallan claro (8 procesos reales a la vez)', async () => {
    const results = await race(8);
    const won = results.filter((r) => r.startsWith('WON'));
    const lost = results.filter((r) => r.startsWith('LOST'));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const message of lost) expect(message).toMatch(/stack en uso por runId racer\d+ pid \d+ desde \d{2}:\d{2}/);
    expect(existsSync(lockPathOf(root))).toBe(false); // el ganador lo soltó al terminar
    expect(readdirSync(root)).toEqual([]); // y no quedó ningún temporal
  });

  it('el resultado NO depende de cuánto tarde cada hijo en arrancar: con arranques escalonados hasta 2,5 s (más que cualquier plazo fijo anterior) sigue ganando exactamente uno', async () => {
    const results = await race(6, [0, 400, 900, 1600, 2000, 2500]);
    expect(results.filter((r) => r.startsWith('WON'))).toHaveLength(1);
    expect(results.filter((r) => r.startsWith('LOST'))).toHaveLength(5);
  });

  it('candado huérfano (pid muerto) ⇒ se reclama y se dice de quién era', () => {
    writeOrphan({ pid: deadPid(), startTime: '123', runId: 'huerfano', startedAt: new Date(Date.now() - 3600_000).toISOString() });
    const lock = acquireStackLock(root, 'runNuevo');
    expect(lock.reclaimed).toMatchObject({ runId: 'huerfano' });
    expect(peekLock(root)?.info.runId).toBe('runNuevo');
    lock.release();
  });

  it('un PID REUTILIZADO por otro proceso (mismo pid vivo, distinto instante de inicio) cuenta como huérfano', () => {
    writeOrphan({ pid: process.pid, startTime: '1', runId: 'pid-reutilizado', startedAt: new Date().toISOString() });
    expect(isHolderAlive(peekLock(root)!.info)).toBe(false);
    const lock = acquireStackLock(root, 'runNuevo');
    expect(lock.reclaimed?.runId).toBe('pid-reutilizado');
    lock.release();
  });

  it('el instante de inicio de este proceso se lee de /proc y el dueño real SÍ está vivo', () => {
    expect(processStartTime(process.pid)).toMatch(/^\d+$/);
    expect(isHolderAlive({ pid: process.pid, startTime: processStartTime(process.pid), runId: 'x', startedAt: new Date().toISOString() })).toBe(true);
  });

  it('VARIOS procesos reclamando el MISMO huérfano a la vez ⇒ exactamente uno gana', async () => {
    writeOrphan({ pid: deadPid(), startTime: '123', runId: 'huerfano', startedAt: new Date().toISOString() });
    const results = await race(8);
    expect(results.filter((r) => r.startsWith('WON'))).toHaveLength(1);
    expect(results.filter((r) => r.startsWith('WON'))[0]).toContain('RECLAIMED huerfano');
    expect(results.filter((r) => r.startsWith('LOST'))).toHaveLength(7);
  });

  it('el dueño muere con SIGKILL (no pudo soltar nada) ⇒ el candado queda y el siguiente lo reclama', async () => {
    const child = spawn(process.execPath, ['--no-warnings', '-e', RACER, '--', LOCK_TS, root, '0'], { stdio: ['pipe', 'pipe', 'inherit'] });
    await firstLine(child);
    expect(peekLock(root)).toMatchObject({ alive: true, info: { pid: child.pid } });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    expect(peekLock(root)).toMatchObject({ alive: false });
    const lock = acquireStackLock(root, 'despues');
    expect(lock.reclaimed?.pid).toBe(child.pid);
    lock.release();
  });

  it('SIGTERM al dueño (sin otros escuchas) ⇒ suelta el candado y el proceso muere por la señal', async () => {
    const script = `
      import(process.argv[1]).then((m) => { m.acquireStackLock(process.argv[2], 'conSenal'); console.log('LISTO'); setInterval(() => undefined, 1000); });`;
    const child = spawn(process.execPath, ['--no-warnings', '-e', script, '--', LOCK_TS, root], { stdio: ['ignore', 'pipe', 'inherit'] });
    await firstLine(child);
    expect(existsSync(lockPathOf(root))).toBe(true);
    child.kill('SIGTERM');
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    expect(exit.signal).toBe('SIGTERM');
    expect(existsSync(lockPathOf(root))).toBe(false);
  });
});

describe('candado del stack — nivel INVÁLIDO', () => {
  it('un archivo de candado ilegible (basura) se trata como huérfano, no como un dueño vivo', () => {
    writeFileSync(lockPathOf(root), 'esto no es json');
    const lock = acquireStackLock(root, 'runNuevo');
    expect(lock.reclaimed).toBeUndefined(); // no se sabe de quién era, pero se reclamó
    expect(peekLock(root)?.info.runId).toBe('runNuevo');
    lock.release();
  });

  it('un candado con campos que faltan también es huérfano', () => {
    writeOrphan({ pid: 'no-es-numero' });
    expect(() => acquireStackLock(root, 'runNuevo').release()).not.toThrow();
  });
});

describe('startStack y cleanupLeftovers con el candado (sin levantar un stack real)', () => {
  const unreachable = {
    ...DEFAULT_INFRA,
    postgres: { host: '127.0.0.1', port: 1, adminUrl: 'postgres://x:y@127.0.0.1:1' },
    natsUrl: 'nats://127.0.0.1:1',
    redisUrl: 'redis://127.0.0.1:1',
    temporalAddress: '127.0.0.1:1',
    watchmanUrl: 'http://127.0.0.1:1',
  };

  it('con el candado ocupado por un stack vivo, startStack falla ANTES de tocar nada: sin carpeta de corrida, sin state.json, sin pasar por la infraestructura', async () => {
    const holder = acquireStackLock(root, 'stack-vivo');
    const before = readdirSync(root).sort();
    const error = await startStack({ runRoot: root, infra: unreachable, tolerateFailures: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StackBusyError);
    expect((error as Error).message).toContain('runId stack-vivo');
    // Si hubiera pasado el candado, habría fallado con «Falta infraestructura» (la infra es inalcanzable): no llegó ni a comprobarla.
    expect((error as Error).message).not.toContain('Falta infraestructura');
    expect(readdirSync(root).sort()).toEqual(before); // solo stack.lock
    expect(peekLock(root)?.info.runId).toBe('stack-vivo'); // y el candado sigue siendo del dueño
    holder.release();
  });

  it('si el arranque falla después de ganar el candado (infraestructura caída), el candado se LIBERA', async () => {
    const error = await startStack({ runRoot: root, infra: unreachable, tolerateFailures: false }).catch((e: unknown) => e);
    expect((error as Error).message).toContain('Falta infraestructura');
    expect(existsSync(lockPathOf(root))).toBe(false);
  });

  it('cleanupLeftovers (yarn e2e:down) NO reinicia bases ni borra streams mientras haya un stack vivo; deja intacto su state.json', async () => {
    const holder = acquireStackLock(root, 'stack-vivo');
    writeFileSync(join(root, 'state.json'), JSON.stringify({ runId: 'stack-vivo', runDir: root, pids: {} }));
    const error = await cleanupLeftovers(unreachable, { runRoot: root }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StackBusyError);
    expect(existsSync(join(root, 'state.json'))).toBe(true);
    holder.release();
  });

  it('cleanupLeftovers sin stack vivo toma el candado mientras limpia y lo suelta al terminar', async () => {
    const result = await cleanupLeftovers(unreachable, { runRoot: root });
    expect(result).toEqual({ killed: [], state: false });
    expect(existsSync(lockPathOf(root))).toBe(false);
  });
});
