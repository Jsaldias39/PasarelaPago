import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { DatabaseModule, PG_POOL } from '../src/database.module';

/**
 * Hallazgo transversal de P5 (gate de fallos F2): un `pg.Pool` sin manejador de `error` tira el PROCESO cuando Postgres corta una conexión
 * ociosa (reinicio, failover, `pg_terminate_backend`). Acá se corta de verdad una conexión ociosa del pool de pay-edge contra el Postgres real.
 * Correcto: el proceso sigue vivo (ninguna excepción no capturada) y el pool repone la conexión. Límite: se cortan TODAS las ociosas a la vez.
 * Inválido/privacidad: al log va solo el NOMBRE del error, nunca su mensaje (puede traer host, usuario o texto de consulta).
 */
describe('pay-edge: una conexión ociosa cortada por Postgres no tumba el proceso', () => {
  let pool: Pool;
  let close: () => Promise<void>;
  const uncaught: unknown[] = [];
  const warnings: unknown[][] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DatabaseModule.forRoot(loadConfig({ ...process.env, LOG_LEVEL: 'silent' }))] }).compile();
    await moduleRef.init();
    pool = moduleRef.get<Pool>(PG_POOL);
    close = () => moduleRef.close();
    process.on('uncaughtException', onUncaught);
    Logger.overrideLogger({ log: () => undefined, error: () => undefined, warn: (...args: unknown[]) => void warnings.push(args) });
  });
  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    Logger.overrideLogger(['log', 'error', 'warn']);
    await close();
  });

  /** Abre `count` conexiones a la vez, las devuelve ociosas y devuelve sus PID de backend. */
  const idleBackends = async (count: number): Promise<number[]> => {
    const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
    const pids = await Promise.all(clients.map(async (c) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
    clients.forEach((c) => c.release());
    return pids;
  };
  /** Corta esos backends desde una conexión APARTE (el mismo rol puede terminar sus propias sesiones). */
  const terminate = async (pids: number[]) => {
    const killer = new Pool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, max: 1 });
    try {
      const res = await killer.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [pids]);
      expect(res.rows.every((r) => r.ok)).toBe(true);
    } finally {
      await killer.end();
    }
  };
  it('correcto: se corta una conexión ociosa, no hay excepción no capturada y la siguiente consulta funciona', async () => {
    const [pid] = await idleBackends(1);
    await terminate([pid!]);
    await new Promise((resolve) => setTimeout(resolve, 300)); // el evento `error` llega por el socket cerrado
    expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    expect(uncaught).toEqual([]);
  });

  it('límite: se cortan TODAS las conexiones ociosas a la vez y el pool se repone', async () => {
    const pids = await idleBackends(5);
    await terminate(pids);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const results = await Promise.all(Array.from({ length: 5 }, () => pool.query('SELECT 1 AS ok')));
    expect(results.map((r) => r.rows[0])).toEqual(Array.from({ length: 5 }, () => ({ ok: 1 })));
    expect(uncaught).toEqual([]);
  });

  it('límite: una conexión PRESTADA cortada en MEDIO de una transacción (entre dos sentencias) NO tumba el proceso; quien la usa recibe el rechazo y el pool sigue sirviendo', async () => {
    const client = await pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await client.query('CREATE TEMP TABLE medio (n int)');
    await terminate([pid]);
    // El `error` del cliente llega con la conexión prestada y sin consulta en vuelo: sin `guardPool` este evento no tiene escucha y mata el proceso.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(uncaught).toEqual([]);
    await expect(client.query('INSERT INTO medio VALUES (1)')).rejects.toBeInstanceOf(Error);
    client.release(true);
    expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
  });

  it('privacidad: al log va solo el NOMBRE del error, nunca su mensaje', async () => {
    const pids = await idleBackends(2);
    warnings.length = 0;
    await terminate(pids);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(warnings.length).toBeGreaterThan(0);
    const logged = JSON.stringify(warnings);
    expect(logged).toContain('"err"');
    expect(logged).not.toMatch(/terminating connection|administrator command|57P01|postgres:\/\/|dev_only/);
    expect(uncaught).toEqual([]);
  });
});
