import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';

const DB = { DB_HOST: '127.0.0.1', DB_NAME: 'pay_risk', DB_USER: 'pay_risk', DB_PASSWORD: 'dev_only_risk', DB_PORT: '54321' };
const RISK = { WATCHMAN_URL: 'http://127.0.0.1:54084', SANCTIONS_DENY_SCORE: '0.80', SANCTIONS_REVIEW_SCORE: '0.60', PAYER_HASH_KEY: 'clave-de-prueba-no-es-un-secreto' };

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
    ['sin PAY_MODE', { ...RISK }, /PAY_MODE/],
    ['PAY_MODE inválido', { ...RISK, PAY_MODE: 'produccion' }, /PAY_MODE/],
    ['live sin declarar las listas vigentes', { ...RISK, PAY_MODE: 'live' }, /WATCHMAN_LISTS=current/],
    ['live con las listas estáticas de 2019 (doble de sandbox)', { ...RISK, PAY_MODE: 'live', WATCHMAN_LISTS: 'static' }, /congeladas de 2019/],
    ['sandbox sin umbral de sanciones (sin valor por defecto)', { PAY_MODE: 'sandbox', WATCHMAN_URL: RISK.WATCHMAN_URL, PAYER_HASH_KEY: RISK.PAYER_HASH_KEY, SANCTIONS_REVIEW_SCORE: '0.6' }, /SANCTIONS_DENY_SCORE/],
  ])('%s ⇒ se niega a arrancar (salida ≠ 0) y dice por qué', async (_name, env, message) => {
    const { output, ended } = boot({ PORT: '3398', ...env });
    expect((await ended).code).not.toBe(0);
    expect(output()).toMatch(message);
  }, 30000);

  it('sandbox con todo declarado ARRANCA, responde /health/live, niega por defecto lo que no es de pay-payments y se apaga limpio', async () => {
    const port = 3300 + Math.floor(Math.random() * 600);
    const { child, ended } = boot({ PORT: String(port), PAY_MODE: 'sandbox', ...RISK });
    try {
      expect(await healthy(port, 20000)).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/assessments/ra_aaaaaaaaaaaa`, { headers: { 'x-service-id': 'pay-edge' } });
      expect(res.status).toBe(403);
    } finally {
      child.kill('SIGTERM');
    }
    const end = await ended;
    expect(end.code === 0 || end.signal === 'SIGTERM').toBe(true);
  }, 40000);

  it('live con las listas vigentes declaradas ARRANCA (no hay otro doble en este servicio)', async () => {
    const port = 3300 + Math.floor(Math.random() * 600);
    const { child, ended } = boot({ PORT: String(port), PAY_MODE: 'live', WATCHMAN_LISTS: 'current', ...RISK });
    try {
      expect(await healthy(port, 20000)).toBe(true);
    } finally {
      child.kill('SIGTERM');
    }
    const end = await ended;
    expect(end.code === 0 || end.signal === 'SIGTERM').toBe(true);
  }, 40000);
});
