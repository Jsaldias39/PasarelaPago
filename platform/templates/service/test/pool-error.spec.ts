import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database.module';

/**
 * Hallazgo transversal de P5 (gate de fallos F2): un `pg.Pool` sin manejador de `error` tira el PROCESO cuando Postgres corta una conexión ociosa
 * (reinicio, failover, `pg_terminate_backend`). Todo servicio nuevo hereda el manejador de esta plantilla. Acá se cortan de verdad, contra el Postgres real,
 * TODAS las sesiones ociosas del servicio (las del pool de `pg` y las del ORM). Correcto: ninguna excepción no capturada y el pool repone la conexión.
 * Límite: se cortan varias a la vez. Privacidad: al log va solo el NOMBRE del error, nunca su mensaje.
 */
describe('__NAME__: una conexión ociosa cortada por Postgres no tumba el proceso', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  const uncaught: unknown[] = [];
  const warnings: unknown[][] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get<Pool>(PG_POOL);
    close = () => app.close();
    process.on('uncaughtException', onUncaught);
    Logger.overrideLogger({ log: () => undefined, error: () => undefined, warn: (...args: unknown[]) => void warnings.push(args) });
  });
  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    Logger.overrideLogger(['log', 'error', 'warn']);
    await close();
  });

  const idleBackends = async (count: number): Promise<number[]> => {
    const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
    const pids = await Promise.all(clients.map(async (c) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
    clients.forEach((c) => c.release());
    return pids;
  };
  /** Corta esos backends (y las demás sesiones ociosas de ESTE servicio, por `application_name`, como las del ORM; nunca las de otros servicios ni otros roles) desde una conexión APARTE. */
  const terminateAllIdle = async (pids: number[]) => {
    const killer = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max: 1 });
    try {
      const res = await killer.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND application_name = \'__NAME__\' AND pid <> pg_backend_pid() AND (pid = ANY($1::int[]) OR state = \'idle\')', [pids]);
      expect(res.rows.length).toBeGreaterThan(0);
    } finally {
      await killer.end();
    }
  };

  it('correcto: se corta una conexión ociosa, no hay excepción no capturada y la siguiente consulta funciona', async () => {
    const [pid] = await idleBackends(1);
    await terminateAllIdle([pid!]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    expect(uncaught).toEqual([]);
  });

  it('límite: se cortan TODAS las conexiones ociosas a la vez y el pool se repone', async () => {
    const pids = await idleBackends(5);
    await terminateAllIdle(pids);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const results = await Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT 1 AS ok')));
    expect(results.map((r) => r.rows[0])).toEqual(Array.from({ length: 5 }, () => ({ ok: 1 })));
    expect(uncaught).toEqual([]);
  });

  it('privacidad: al log va solo el NOMBRE del error, nunca su mensaje', async () => {
    const pids = await idleBackends(2);
    warnings.length = 0;
    await terminateAllIdle(pids);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(warnings.length).toBeGreaterThan(0);
    const logged = JSON.stringify(warnings);
    expect(logged).toContain('"err"');
    expect(logged).not.toMatch(/terminating connection|administrator command|57P01|postgres:\/\/|dev_only/);
    expect(uncaught).toEqual([]);
  });
});
