import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

const DB = { DB_HOST: '127.0.0.1', DB_NAME: 'pay_schedules', DB_USER: 'pay_schedules', DB_PASSWORD: 'dev_only_schedules', DB_PORT: '54321' };
const SCHED = { LEDGER_URL: 'http://127.0.0.1:3105', RETRY_DELAYS_SECONDS: '3600,7200' };

describe('PAY_MODE (configuración de la plantilla)', () => {
  it('es obligatorio, SIN valor por defecto, y solo admite sandbox | live', () => {
    expect(() => loadConfig({ ...DB })).toThrow(/PAY_MODE/);
    expect(() => loadConfig({ ...DB, PAY_MODE: '' })).toThrow(/PAY_MODE/);
    for (const bad of ['test', 'SANDBOX', 'prod', 'sandbox ']) expect(() => loadConfig({ ...DB, PAY_MODE: bad })).toThrow(/PAY_MODE inválido/);
    expect(loadConfig({ ...DB, PAY_MODE: 'live' }).payMode).toBe('live');
  });
});

/** Arranque REAL del servicio compilado (`dist/main.js`) como proceso. Se mata por PID (nunca por patrón). */
const MAIN = join(process.cwd(), 'dist/main.js');
function boot(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...DB, NATS_URL: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => out, ended };
}

async function healthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/live`)).status === 200) return true;
    } catch {
      // todavía no escucha
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('arranque real del proceso (dist/main.js)', () => {
  it('el servicio está compilado (yarn build antes de las pruebas de arranque)', () => {
    expect(existsSync(MAIN)).toBe(true);
  });

  it.each([
    ['sin PAY_MODE', { ...SCHED }, /PAY_MODE/],
    ['PAY_MODE inválido', { ...SCHED, PAY_MODE: 'produccion' }, /PAY_MODE/],
    ['sin la política de reintentos (sin valor por defecto)', { PAY_MODE: 'sandbox', LEDGER_URL: SCHED.LEDGER_URL }, /RETRY_DELAYS_SECONDS/],
    ['sin LEDGER_URL', { PAY_MODE: 'sandbox', RETRY_DELAYS_SECONDS: SCHED.RETRY_DELAYS_SECONDS }, /LEDGER_URL/],
    ['live con un interruptor de pruebas (ejecutor apagado)', { ...SCHED, PAY_MODE: 'live', DISABLE_BACKGROUND_JOBS: '1' }, /DISABLE_BACKGROUND_JOBS/],
  ])('%s ⇒ se niega a arrancar (salida ≠ 0) y dice por qué', async (_name, env, message) => {
    const { output, ended } = boot({ PORT: '3398', ...env });
    expect((await ended).code).not.toBe(0);
    expect(output()).toMatch(message);
  }, 30000);

  it('sandbox con todo declarado ARRANCA, responde /health/live, niega por defecto lo que no es de pay-edge y se apaga limpio', async () => {
    const port = 3300 + Math.floor(Math.random() * 600);
    const { child, ended } = boot({ PORT: String(port), PAY_MODE: 'sandbox', ...SCHED });
    try {
      expect(await healthy(port, 20000)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/mandates`, { headers: { 'x-service-id': 'pay-payments', 'x-merchant-id': 'mc_aaaaaaaaaaaa', 'x-pay-mode': 'test' } });
      expect(res.status).toBe(403);
    } finally {
      child.kill('SIGTERM');
    }
    const end = await ended;
    expect(end.code === 0 || end.signal === 'SIGTERM').toBe(true);
  }, 40000);

  it('live ARRANCA con la configuración real (este servicio no embebe ningún doble)', async () => {
    const port = 3300 + Math.floor(Math.random() * 600);
    const { child, ended } = boot({ PORT: String(port), PAY_MODE: 'live', ...SCHED });
    try {
      expect(await healthy(port, 20000)).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
    const end = await ended;
    expect(end.code === 0 || end.signal === 'SIGTERM').toBe(true);
  }, 40000);
});
