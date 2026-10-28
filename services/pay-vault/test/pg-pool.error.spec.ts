import 'reflect-metadata';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { ConsoleLogger, Controller, Get, Inject, Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PublicRoute, ServiceIdentityGuard } from '@pay/service-auth';
import { Pool } from 'pg';
import request from 'supertest';
import { createPgPool } from '../src/pg-pool';
import { ProblemFilter } from '../src/problem.filter';

/**
 * Tanda 3c · un `pg.Pool` sin manejador de `error` tira el proceso cuando Postgres corta una conexión OCIOSA (hallado por P5 en pay-merchants).
 * Tres niveles (regla 65): correcto (se corta una ociosa), límite (se cortan TODAS las ociosas) e inválido (se corta en medio de una consulta),
 * más el log (sin mensaje ni SQL) y un control negativo que demuestra que sin el manejador el proceso SÍ muere.
 */
const SERVICE = 'pay-vault';
const URL = process.env.PAY_TEST_DATABASE_URL as string;
const root = process.cwd();
const RUN = randomBytes(4).toString('hex');
/** Mensajes y SQL que NUNCA deben aparecer en el log del pool. */
const FORBIDDEN_IN_LOG = /terminating connection|administrator command|57P01|pg_sleep|SELECT |FATAL/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(probe: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Se agotó el tiempo esperando: ${label}`);
    await sleep(50);
  }
}
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

let admin: Pool;
beforeAll(() => {
  admin = new Pool({ connectionString: URL, max: 1 });
});
afterAll(async () => admin.end());

/** Corta con `pg_terminate_backend` las conexiones de esa `application_name` que estén en ese estado; devuelve cuántas. */
async function terminate(appName: string, state: 'idle' | 'active', since?: Date): Promise<number> {
  const { rows } = await admin.query(
    `SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity
      WHERE application_name = $1 AND state = $2 AND pid <> pg_backend_pid() AND ($3::timestamptz IS NULL OR backend_start >= $3)`,
    [appName, state, since ?? null],
  );
  return rows.filter((r: { done: boolean }) => r.done).length;
}
const backendsOf = async (appName: string): Promise<number> => (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()', [appName])).rows[0].n;

interface Harness {
  readonly child: ChildProcess;
  readonly app: string;
  send(op: 'ping' | 'spread' | 'sleep'): Promise<{ ok?: boolean; error?: string; code?: string }>;
  /** Todo lo que el proceso escribió, SIN las respuestas del arnés: es el log del servicio. */
  log(): string;
  alive(): boolean;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stop(): Promise<void>;
}

async function harness(bare = false): Promise<Harness> {
  const app = `pool-test-${RUN}-${randomBytes(2).toString('hex')}`;
  const child = spawn(process.execPath, [path.join(root, 'test/helpers/pool-child.cjs')], {
    cwd: root,
    env: { ...process.env, POOL_URL: URL, POOL_APP: app, POOL_BARE: bare ? '1' : '0', NODE_OPTIONS: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  const waiting = new Map<number, (body: Record<string, unknown>) => void>();
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    for (const line of chunk.toString().split('\n')) {
      if (!line.startsWith('REPLY ')) continue;
      const body = JSON.parse(line.slice(6)) as { id: number };
      waiting.get(body.id)?.(body);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await until(async () => output.includes('READY') || undefined, 30_000, 'el arnés del pool');
  let next = 0;
  return {
    child,
    app,
    send: (op) =>
      new Promise((resolve) => {
        const id = ++next;
        waiting.set(id, resolve as never);
        child.stdin?.write(`${JSON.stringify({ id, op })}\n`);
      }),
    log: () => output.split('\n').filter((l) => !l.startsWith('REPLY ') && l !== 'READY').join('\n'),
    alive: () => child.exitCode === null && child.signalCode === null,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); // por PID: nunca por nombre
      await exited;
    },
  };
}

describe('3c · pg.Pool: una conexión cortada por Postgres no tumba el proceso (proceso aparte, dist/pg-pool.js)', () => {
  it('correcto · se corta UNA conexión ociosa: el proceso sigue vivo, el pool repone y la siguiente consulta funciona', async () => {
    const h = await harness();
    try {
      expect(await h.send('ping')).toEqual({ id: expect.any(Number), ok: true });
      await until(async () => (await backendsOf(h.app)) >= 1 || undefined, 10_000, 'la conexión del pool');
      expect(await terminate(h.app, 'idle')).toBeGreaterThanOrEqual(1);
      await sleep(500);
      expect(h.alive()).toBe(true);
      expect(await h.send('ping')).toMatchObject({ ok: true });
      // El pool repuso la conexión: hay al menos una viva otra vez.
      expect(await backendsOf(h.app)).toBeGreaterThanOrEqual(1);
      expect(h.log()).toMatch(/PgPool/);
      expect(h.log()).toMatch(/Conexión ociosa cortada/);
    } finally {
      await h.stop();
    }
  });

  it('límite · se cortan TODAS las ociosas a la vez (el pool llegó a 4): el proceso sigue vivo y vuelve a abrir las que hagan falta', async () => {
    const h = await harness();
    try {
      expect(await h.send('spread')).toMatchObject({ ok: true });
      await until(async () => (await backendsOf(h.app)) >= 4 || undefined, 10_000, 'cuatro conexiones');
      const cut = await terminate(h.app, 'idle');
      expect(cut).toBe(4);
      await sleep(500);
      expect(h.alive()).toBe(true);
      expect(await h.send('spread')).toMatchObject({ ok: true }); // cuatro consultas simultáneas: el pool abre cuatro nuevas
      expect(await backendsOf(h.app)).toBeGreaterThanOrEqual(4);
    } finally {
      await h.stop();
    }
  });

  it('inválido · se corta la conexión EN MEDIO de una consulta: esa consulta rechaza con el error de pg (admin_shutdown), el proceso sigue vivo y la siguiente consulta funciona', async () => {
    const h = await harness();
    try {
      const running = h.send('sleep');
      await until(async () => (await backendsOf(h.app)) >= 1 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'", [h.app])).rowCount === 1 || undefined, 10_000, 'la consulta en curso');
      expect(await terminate(h.app, 'active')).toBe(1);
      const result = await running;
      expect(result).toMatchObject({ error: 'error', code: '57P01' });
      await sleep(300);
      expect(h.alive()).toBe(true);
      expect(await h.send('ping')).toMatchObject({ ok: true });
    } finally {
      await h.stop();
    }
  });

  it('log · el aviso lleva solo el NOMBRE del error: ni el mensaje de Postgres, ni el SQL, ni el SQLSTATE', async () => {
    const h = await harness();
    try {
      await h.send('spread');
      await terminate(h.app, 'idle');
      await sleep(500);
      const log = h.log();
      expect(log).toMatch(/PgPool/);
      expect(log).toMatch(/Error|error/);
      expect(log).not.toMatch(FORBIDDEN_IN_LOG);
      expect(log).not.toContain(URL);
    } finally {
      await h.stop();
    }
  });

  it('CONTROL NEGATIVO · un pg.Pool pelado (sin manejador) SÍ muere cuando Postgres corta una ociosa: la prueba detecta el defecto', async () => {
    const h = await harness(true);
    try {
      await h.send('ping');
      await until(async () => (await backendsOf(h.app)) >= 1 || undefined, 10_000, 'la conexión del pool');
      await terminate(h.app, 'idle');
      const outcome = await Promise.race([h.exited, sleep(8_000).then(() => 'sigue vivo' as const)]);
      expect(outcome).not.toBe('sigue vivo');
      expect(h.log()).toMatch(/Unhandled 'error' event|terminating connection|57P01/);
    } finally {
      await h.stop();
    }
  });
});

@Controller('probe')
@PublicRoute()
class ProbeController {
  constructor(@Inject('POOL') private readonly pool: Pool) {}
  @Get('ping')
  async ping(): Promise<{ ok: true }> {
    await this.pool.query('SELECT 1');
    return { ok: true };
  }
  @Get('slow')
  async slow(): Promise<never> {
    await this.pool.query('SELECT pg_sleep(60)');
    throw new Error('no debía llegar');
  }
}

describe('3c · pg.Pool: la consulta cortada en medio de una petición HTTP falla con el error del contrato (in-process, ProblemFilter real)', () => {
  const appName = `pool-http-${RUN}`;
  let pool: Pool;
  let app: INestApplication;
  const captured: string[] = [];
  const spies: (() => void)[] = [];

  beforeAll(async () => {
    pool = createPgPool({ connectionString: URL, max: 4, application_name: appName });
    @Module({ controllers: [ProbeController], providers: [{ provide: 'POOL', useValue: pool }, { provide: APP_GUARD, useClass: ServiceIdentityGuard }, { provide: APP_FILTER, useClass: ProblemFilter }] })
    class ProbeModule {}
    // Por defecto el módulo de pruebas de Nest silencia `warn`: se pone el logger de consola real para ver lo que saldría en producción.
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).setLogger(new ConsoleLogger()).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // El log de Nest sale por stdout/stderr: se captura para comprobar que no lleva mensaje ni SQL.
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      spies.push(() => (stream.write = original as typeof stream.write));
    }
  });
  afterAll(async () => {
    for (const restore of spies) restore();
    await app.close();
    await pool.end();
  });

  it('inválido · cortar la conexión de una petición en curso ⇒ 500 internal_error (problem+json) sin mensaje ni SQL; el proceso sigue y la siguiente petición responde 200', async () => {
    const slow = request(app.getHttpServer()).get('/probe/slow').set('x-service-id', 'pay-edge').then((r) => r);
    await until(async () => (await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'", [appName])).rowCount === 1 || undefined, 10_000, 'la petición en curso');
    expect(await terminate(appName, 'active')).toBe(1);
    const response = await slow;
    expect(response.status).toBe(500);
    expect(response.type).toBe('application/problem+json');
    expect(response.body.code).toBe('internal_error');
    expect(JSON.stringify(response.body)).not.toMatch(FORBIDDEN_IN_LOG);
    const ok = await request(app.getHttpServer()).get('/probe/ping').set('x-service-id', 'pay-edge');
    expect(ok.status).toBe(200);
    expect(captured.join('')).not.toMatch(/terminating connection|administrator command|pg_sleep/i);
  });

  it('correcto · cortar una ociosa en pleno servicio: el pool emite `error`, el proceso (este worker de Jest) sigue y la siguiente petición responde 200', async () => {
    captured.length = 0; // desde acá solo lo que escribe el pool (el filtro de problemas registra además el SQLSTATE, por diseño)
    await request(app.getHttpServer()).get('/probe/ping').set('x-service-id', 'pay-edge').expect(200);
    await until(async () => (await backendsOf(appName)) >= 1 || undefined, 10_000, 'conexión ociosa');
    expect(await terminate(appName, 'idle')).toBeGreaterThanOrEqual(1);
    await sleep(400);
    await request(app.getHttpServer()).get('/probe/ping').set('x-service-id', 'pay-edge').expect(200);
    const log = captured.join('');
    expect(log).toMatch(/PgPool/);
    expect(log).not.toMatch(FORBIDDEN_IN_LOG);
  });
});

describe('3c · el servicio real (dist/main.js, DatabaseModule + ORM): cortar sus conexiones ociosas no lo tumba', () => {
  it('se cortan TODAS las conexiones ociosas de la aplicación: el proceso sigue vivo y /health/ready vuelve a responder 200 con una conexión repuesta', async () => {
    const port = await freePort();
    const startedAt = new Date(Date.now() - 1000);
    const child = spawn(process.execPath, [path.join(root, 'dist/main.js')], {
      env: { ...process.env, PORT: String(port), CONSUME_EVENTS: 'false', TEMPORAL_RUN_WORKER: 'false', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
    const exited = new Promise<string>((resolve) => child.once('exit', (code, signal) => resolve(`code=${code} signal=${signal}`)));
    const ready = async (): Promise<number | undefined> => fetch(`http://127.0.0.1:${port}/health/ready`).then((r) => r.status).catch(() => undefined);
    try {
      await until(async () => ((await ready()) === 200 ? true : undefined), 60_000, 'la API lista');
      await until(async () => (await backendsOfSince(SERVICE, startedAt)) >= 1 || undefined, 10_000, 'conexiones de la aplicación');
      const cut = await terminate(SERVICE, 'idle', startedAt);
      expect(cut).toBeGreaterThanOrEqual(1);
      await sleep(1500);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await until(async () => ((await ready()) === 200 ? true : undefined), 15_000, 'la API lista otra vez');
      expect(await Promise.race([exited, sleep(300).then(() => 'sigue vivo')])).toBe('sigue vivo');
      expect(output).not.toMatch(/Unhandled 'error' event|uncaughtException|terminating connection|administrator command|57P01/i);
      expect(output).not.toMatch(/pg_terminate_backend/);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL'); // por PID: nunca por nombre
      await exited;
    }
  });
});

async function backendsOfSince(appName: string, since: Date): Promise<number> {
  return (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND backend_start >= $2 AND pid <> pg_backend_pid()', [appName, since])).rows[0].n;
}

describe('3c · todo `pg.Pool` del servicio nace de createPgPool (con manejador): ningún `new Pool(` en src/ fuera de src/pg-pool.ts', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : full.endsWith('.ts') ? [full] : [];
    });
  it('estático', () => {
    const offenders = sources(path.join(root, 'src'))
      .filter((f) => !f.endsWith(`${path.sep}pg-pool.ts`))
      .filter((f) => /new\s+Pool\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f));
    expect(offenders).toEqual([]);
  });
});
