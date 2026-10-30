import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { loadSettings, operatorSettings } from '../src/settings';
import { PUBLIC_KEY_PEM } from './support/operator-jwt';

const OPERATOR_ENV = { OPERATOR_TOKEN_PUBLIC_KEY: PUBLIC_KEY_PEM.replace(/\n/g, '\\n'), OPERATOR_TOKEN_ISSUER: 'pay-sandbox-identity', OPERATOR_TOKEN_AUDIENCE: 'pay-merchants' };
const BASE_DB = { DB_HOST: '127.0.0.1', DB_NAME: 'pay_merchants', DB_USER: 'pay_merchants', DB_PASSWORD: 'dev_only_merchants' };

describe('PAY_MODE y guardias de arranque (configuración)', () => {
  it('PAY_MODE es obligatorio y SIN valor por defecto, y solo admite sandbox | live', () => {
    expect(() => loadConfig({ ...BASE_DB })).toThrow(/PAY_MODE/);
    expect(() => loadConfig({ ...BASE_DB, PAY_MODE: '' })).toThrow(/PAY_MODE/);
    for (const bad of ['test', 'SANDBOX', 'prod', 'sandbox ', 'true']) expect({ bad, throws: (() => { try { loadConfig({ ...BASE_DB, PAY_MODE: bad }); return false; } catch { return true; } })() }).toEqual({ bad, throws: true });
    expect(loadConfig({ ...BASE_DB, PAY_MODE: 'sandbox' }).payMode).toBe('sandbox');
    expect(() => loadSettings({})).toThrow(/PAY_MODE/);
  });

  it('sandbox: arranca sin credencial de operador (falla cerrado: nadie es operador) y con ella completa', () => {
    expect(loadSettings({ PAY_MODE: 'sandbox' }).operator).toBeUndefined();
    expect(loadSettings({ PAY_MODE: 'sandbox', ...OPERATOR_ENV }).operator).toMatchObject({ issuer: 'pay-sandbox-identity', audience: 'pay-merchants' });
  });

  it.each(['OPERATOR_TOKEN_PUBLIC_KEY', 'OPERATOR_TOKEN_ISSUER', 'OPERATOR_TOKEN_AUDIENCE'])('la credencial se configura COMPLETA: sin %s no arranca, ni en sandbox', (name) => {
    const env: Record<string, string | undefined> = { PAY_MODE: 'sandbox', ...OPERATOR_ENV };
    delete env[name];
    expect(() => loadSettings(env)).toThrow(name);
  });

  it('una clave pública que no es RSA, o basura, no arranca (no se niega a todos en silencio)', () => {
    expect(() => loadSettings({ PAY_MODE: 'sandbox', ...OPERATOR_ENV, OPERATOR_TOKEN_PUBLIC_KEY: 'basura' })).toThrow(/RSA/);
  });

  it('LIVE: sin credencial de operador NO arranca; con ella, tampoco mientras el almacén de KYC sea el doble [DEV] o haya interruptores de prueba', () => {
    expect(() => loadSettings({ PAY_MODE: 'live', KYC_STORE_BACKEND: 'fs' })).toThrow(/KYC_STORE_BACKEND=fs es un doble/);
    expect(() => loadSettings({ PAY_MODE: 'live' })).toThrow(/doble/);
    expect(() => loadSettings({ PAY_MODE: 'live', DISABLE_BACKGROUND_JOBS: '1', ...OPERATOR_ENV })).toThrow(/DISABLE_BACKGROUND_JOBS=1 es un interruptor de pruebas/);
    // Aun con todo lo demás en regla, el almacén de producción no existe: live no arranca (honesto, no se simula).
    expect(() => loadSettings({ PAY_MODE: 'live', ...OPERATOR_ENV })).toThrow(/KYC_STORE_BACKEND=fs es un doble/);
  });

  it('LIVE exige la credencial de operador completa (se prueba la regla aislada: con el almacén de KYC de desarrollo live ni llega acá)', () => {
    expect(() => operatorSettings({}, 'live')).toThrow(/exige la credencial de operador/);
    expect(() => operatorSettings({ OPERATOR_TOKEN_ISSUER: 'x' }, 'live')).toThrow(/OPERATOR_TOKEN_PUBLIC_KEY/);
    expect(operatorSettings(OPERATOR_ENV, 'live')).toMatchObject({ audience: 'pay-merchants' });
    expect(operatorSettings({}, 'sandbox')).toBeUndefined();
  });

  it('KYC_STORE_BACKEND desconocido no arranca', () => {
    expect(() => loadSettings({ PAY_MODE: 'sandbox', KYC_STORE_BACKEND: 's3' })).toThrow(/no soportado/);
  });
});

/** Arranque REAL del servicio compilado (`dist/main.js`) como proceso. Se mata por PID (nunca por patrón). */
const MAIN = join(process.cwd(), 'dist/main.js');
function boot(env: NodeJS.ProcessEnv): { child: ChildProcess; output: () => string; exited: Promise<number | null>; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...BASE_DB, DB_PORT: '54321', NATS_URL: '' };
  const child = spawn(process.execPath, [MAIN], { env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (out += c.toString()));
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const exited = ended.then((e) => e.code);
  return { child, output: () => out, exited, ended };
}

async function healthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (res.status === 200) return true;
    } catch {
      // todavía no escucha
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('arranque real del proceso (dist/main.js)', () => {
  const available = existsSync(MAIN);
  it('el servicio está compilado (yarn build antes de las pruebas de arranque)', () => {
    expect(available).toBe(true);
  });

  it.each([
    ['sin PAY_MODE', {}, /PAY_MODE/],
    ['PAY_MODE inválido', { PAY_MODE: 'produccion' }, /PAY_MODE/],
    ['live con el almacén de KYC de desarrollo (doble)', { PAY_MODE: 'live', ...OPERATOR_ENV }, /doble/],
    ['live sin credencial de operador', { PAY_MODE: 'live' }, /doble|credencial/],
    ['credencial de operador a medias en sandbox', { PAY_MODE: 'sandbox', OPERATOR_TOKEN_ISSUER: 'x' }, /OPERATOR_TOKEN/],
  ])('%s ⇒ se niega a arrancar (salida ≠ 0) y dice por qué', async (_name, env, message) => {
    const { output, exited } = boot({ PORT: '3399', ...env });
    const code = await exited;
    expect(code).not.toBe(0);
    expect(output()).toMatch(message);
  }, 30000);

  it('sandbox con la credencial completa ARRANCA, responde /health/live y se apaga limpio', async () => {
    const port = 3300 + Math.floor(Math.random() * 600);
    const { child, output, ended } = boot({ PORT: String(port), PAY_MODE: 'sandbox', KYC_STORE_DIR: '/tmp/pay-merchants-boot-kyc', ...OPERATOR_ENV });
    try {
      expect(await healthy(port, 20000)).toBe(true);
      // Sin credencial de operador en la petición, el back-office responde 401 (la configuración está activa: no es deny-all genérico).
      const res = await fetch(`http://127.0.0.1:${port}/merchants/mc_aaaaaaaaaaaa`, { headers: { 'x-service-id': 'pay-backoffice' } });
      expect(res.status).toBe(401);
    } finally {
      child.kill('SIGTERM');
    }
    const end = await ended; // se apagó por la señal (Nest la relanza tras cerrar) o con salida 0
    expect(end.code === 0 || end.signal === 'SIGTERM').toBe(true);
    expect(output()).not.toMatch(/PRIVATE KEY/);
  }, 40000);
});
