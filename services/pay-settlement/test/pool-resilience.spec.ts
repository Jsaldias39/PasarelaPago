import { jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { Controller, Get, Inject, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/core';
import { Client, type Pool } from 'pg';
import { DatabaseModule, PG_POOL } from '../src/database.module';
import { ServiceConfigModule } from '../src/config.module';
import { inTransaction } from '../src/settlement/unit-of-work';
import { ProblemFilter } from '../src/problem.filter';
import { waitFor } from './helpers/wait';

/**
 * Un `pg.Pool` sin manejador de `error` tira el proceso entero cuando Postgres corta una conexión (reinicio, failover, `pg_terminate_backend`):
 * un evento `error` sin escucha es una excepción no capturada. Se prueba con el módulo REAL (el `PG_POOL` que usa el servicio y el pool del ORM)
 * contra Postgres real: si algo tirara el proceso, Jest lo reporta como excepción no capturada y la prueba falla.
 */
@Controller('probe')
class ProbeController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('one')
  async one() {
    return (await this.pool.query('SELECT 1 AS ok')).rows[0];
  }

  @Get('sleep')
  async sleep() {
    await this.pool.query('SELECT pg_sleep(30) /* consulta-larga */');
    return { ok: true };
  }
}

let app: INestApplication;
let pool: Pool;
let orm: MikroORM;
let admin: Client;
let url: string;
/** Con el rol del propio servicio (un rol puede cortar sus propias conexiones; no necesita superusuario). */
const dbUrl = `postgres://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
const warn = jest.spyOn(Logger.prototype, 'warn');
const error = jest.spyOn(Logger.prototype, 'error');

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ServiceConfigModule, DatabaseModule], controllers: [ProbeController] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemFilter());
  await app.listen(0, '127.0.0.1');
  url = await app.getUrl();
  pool = moduleRef.get<Pool>(PG_POOL);
  orm = moduleRef.get(MikroORM);
  admin = new Client({ connectionString: dbUrl });
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
  await app.close();
});
beforeEach(() => {
  warn.mockClear();
  error.mockClear();
});

const terminate = async (pids: number[]) => (await admin.query('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [pids])).rows.every((r) => r.ok);
/** pids de `n` conexiones DISTINTAS del pool (consultas simultáneas ⇒ el pool abre `n`). */
const openConnections = async (n: number) => {
  const pids = await Promise.all(Array.from({ length: n }, async () => (await pool.query('SELECT pg_backend_pid() AS pid, pg_sleep(0.3)')).rows[0].pid as number));
  return [...new Set(pids)];
};
/** El pool se repone solo: tras el corte, una consulta termina bien (puede que la primera tropiece con la conexión recién muerta). */
const recovered = () => waitFor(async () => pool.query('SELECT pg_backend_pid() AS pid').then((r) => r.rows[0].pid as number).catch(() => false), 10_000, 100);
const warnedAboutIdleConnection = () => warn.mock.calls.some((c) => JSON.stringify(c).includes('Conexión ociosa cortada'));
const loggedText = () => JSON.stringify([...warn.mock.calls, ...error.mock.calls]);

describe('el pool de la aplicación sobrevive a que Postgres corte conexiones', () => {
  it('control negativo: un `Pool` SIN manejador mata el proceso cuando le cortan una conexión ociosa; el del servicio sí tiene manejador', async () => {
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    const script = `
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.POOL_TEST_URL, max: 1 });
      (async () => {
        const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const admin = new (require('pg').Client)({ connectionString: process.env.POOL_TEST_URL });
        await admin.connect();
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
        await new Promise((r) => setTimeout(r, 1500));
        console.log('VIVO');
        process.exit(0);
      })();`;
    const run = spawnSync(process.execPath, ['-e', script], { cwd: process.cwd(), env: { ...process.env, POOL_TEST_URL: dbUrl }, encoding: 'utf8', timeout: 20_000 });
    expect(run.stdout).not.toContain('VIVO');
    expect(run.status).not.toBe(0);
  });

  it('correcto: se corta UNA conexión ociosa, el proceso sigue y el pool repone la conexión', async () => {
    const [pid] = await openConnections(1);
    expect(await terminate([pid])).toBe(true);
    // Ociosa: nadie la está usando cuando Postgres la corta ⇒ el pool emite `error` (sin manejador, esto tiraba el proceso).
    await waitFor(async () => pool.totalCount === 0 && warnedAboutIdleConnection(), 5000, 50);
    const next = await recovered();
    expect(next).not.toBe(pid);
    expect((await fetch(`${url}/probe/one`)).status).toBe(200);
  });

  it('límite: se cortan TODAS las ociosas a la vez (y la del ORM) y todo sigue funcionando', async () => {
    const pids = await openConnections(6);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    const [{ pid: ormPid }] = (await orm.em.getConnection().execute('SELECT pg_backend_pid() AS pid')) as { pid: number }[];
    expect(await terminate([...pids, ormPid])).toBe(true);
    await waitFor(async () => pool.totalCount === 0 && warnedAboutIdleConnection(), 5000, 50);
    await recovered();
    expect((await openConnections(4)).length).toBeGreaterThanOrEqual(1);
    await waitFor(async () => orm.em.getConnection().execute('SELECT 1 AS ok').then(() => true).catch(() => false), 10_000, 100);
    expect((await fetch(`${url}/probe/one`)).status).toBe(200);
  });

  it('límite: corte EN MEDIO de una consulta ⇒ esa petición falla con un error del contrato (500 problem+json, sin SQL ni mensaje) y el proceso sigue', async () => {
    const pending = fetch(`${url}/probe/sleep`);
    const pid = await waitFor(async () => (await admin.query(`SELECT pid FROM pg_stat_activity WHERE query LIKE '%consulta-larga%' AND pid <> pg_backend_pid() AND state = 'active' AND usename = current_user`)).rows[0]?.pid as number | undefined, 10_000, 100);
    expect(await terminate([pid])).toBe(true);
    const res = await pending;
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body).toMatchObject({ status: 500, code: 'internal_error' });
    expect(JSON.stringify(body)).not.toMatch(/pg_sleep|terminat|SELECT|FATAL/i);
    await recovered();
    expect((await fetch(`${url}/probe/one`)).status).toBe(200);
  });

  it('límite: la conexión PRESTADA (transacción esperando a otro sistema) se corta entre dos consultas ⇒ la operación falla, el ROLLBACK no tapa el error y la conexión muerta se descarta', async () => {
    let victim = 0;
    const work = inTransaction(pool, async (client) => {
      victim = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      // «esperando a TigerBeetle»: la conexión está prestada y ociosa mientras alguien la corta
      await waitFor(async () => (await terminate([victim])) && false, 300, 100).catch(() => undefined);
      for (let i = 0; i < 50; i += 1) {
        await client.query('SELECT 1');
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    await expect(work).rejects.toThrow(/terminat|Connection/i);
    expect(victim).toBeGreaterThan(0);
    await recovered();
    expect((await fetch(`${url}/probe/one`)).status).toBe(200);
    expect(pool.totalCount).toBeLessThanOrEqual(10);
  });

  it('inválido: lo que queda en el log es solo el NOMBRE del error: ni mensaje de Postgres ni SQL ni datos de la conexión', async () => {
    const pids = await openConnections(3);
    await terminate(pids);
    await waitFor(async () => pool.totalCount === 0 && warnedAboutIdleConnection(), 5000, 50);
    await recovered();
    const text = loggedText();
    expect(text).toContain('Conexión ociosa cortada');
    expect(text).not.toMatch(/terminating connection|administrator command|57P01|FATAL|SELECT|pg_backend_pid|pg_sleep|password|127\.0\.0\.1/i);
  });
});
