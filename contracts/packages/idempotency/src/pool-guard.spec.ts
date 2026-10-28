import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { guardPool } from './pool-guard';

/**
 * Un `pg.Pool` sin manejadores tumba el PROCESO cuando Postgres corta una conexión. Acá se corta de verdad, contra el Postgres real, una conexión OCIOSA y una PRESTADA
 * a mitad de una transacción. Correcto: ninguna excepción no capturada y el pool sigue sirviendo. Límite: se cortan varias a la vez. Inválido/privacidad: al log va
 * solo el NOMBRE del error. Control negativo: sin `guardPool` el mismo corte SÍ produce una excepción no capturada (si no, la prueba no probaría nada).
 */
const TEST_URL = process.env.PAY_TEST_DATABASE_URL ?? 'postgres://postgres:pay@127.0.0.1:54321/pay_test';

describe('guardPool (Postgres real)', () => {
  let db: IsolatedDatabase;
  let killer: Pool;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    db = await createIsolatedDatabase([]);
    killer = db.pool;
    process.on('uncaughtException', onUncaught);
  });
  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    await db.drop();
  });
  beforeEach(() => {
    uncaught.length = 0;
  });

  const newPool = () => new Pool({ connectionString: TEST_URL, max: 5, application_name: `guard-${Math.random().toString(36).slice(2, 8)}` });
  const terminate = async (pids: number[]) => {
    const res = await killer.query<{ ok: boolean }>('SELECT pg_terminate_backend(pid) AS ok FROM unnest($1::int[]) AS pid', [pids]);
    expect(res.rows.every((r) => r.ok)).toBe(true);
  };

  it('CORRECTO — conexión OCIOSA cortada: sin excepción, el pool se repone y el log lleva solo el nombre', async () => {
    const logged: { err: string }[] = [];
    const pool = guardPool(newPool(), (event) => logged.push(event));
    try {
      const clients = await Promise.all(Array.from({ length: 3 }, () => pool.connect()));
      const pids = await Promise.all(clients.map(async (c) => (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
      clients.forEach((c) => c.release());
      await terminate(pids);
      await pause(300);
      expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
      expect(uncaught).toEqual([]);
      expect(logged.length).toBeGreaterThan(0);
      expect(JSON.stringify(logged)).not.toMatch(/terminating connection|administrator command|57P01|postgres:\/\//);
      expect(Object.keys(logged[0]!)).toEqual(['err']);
    } finally {
      await pool.end();
    }
  });

  it('LÍMITE — conexión PRESTADA cortada a MITAD de una transacción: a quien la usa le llega el rechazo, el proceso sigue vivo y el pool sigue sirviendo', async () => {
    const pool = guardPool(newPool());
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await client.query('CREATE TEMP TABLE medio (n int)');
      await terminate([pid]);
      await expect(client.query('INSERT INTO medio VALUES (1)')).rejects.toBeInstanceOf(Error);
      client.release(true);
      await pause(300);
      expect(uncaught).toEqual([]);
      expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await pool.end();
    }
  });

  it('LÍMITE — cortar una conexión prestada que NO está ejecutando nada (entre dos sentencias de la transacción) tampoco tumba el proceso', async () => {
    const pool = guardPool(newPool());
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await terminate([pid]);
      await pause(300); // el `error` del cliente llega con la conexión prestada y ociosa
      expect(uncaught).toEqual([]);
      client.release(true);
      expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await pool.end();
    }
  });

  /** Proceso REAL aparte: toma una conexión prestada dentro de una transacción, la corta desde fuera y espera. Devuelve su código de salida y su salida. */
  const childRun = (guarded: boolean) => {
    const script = `
      const { Pool } = require('pg');
      const { guardPool } = require(${JSON.stringify(join(__dirname, '../dist/index.js'))});
      const url = process.env.U;
      const pool = ${guarded ? 'guardPool(new Pool({ connectionString: url, max: 2 }))' : 'new Pool({ connectionString: url, max: 2 })'};
      (async () => {
        const c = await pool.connect();
        await c.query('BEGIN');
        const { rows } = await c.query('SELECT pg_backend_pid() AS pid');
        const killer = new Pool({ connectionString: url, max: 1 });
        await killer.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
        await killer.end();
        await new Promise((resolve) => setTimeout(resolve, 600));
        c.release(true);
        await pool.end();
        console.log('PROCESO_VIVO');
      })();`;
    const result = spawnSync(process.execPath, ['-e', script], { env: { PATH: process.env.PATH ?? '', U: TEST_URL }, cwd: join(__dirname, '..'), encoding: 'utf8', timeout: 20_000 });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };

  it('CONTROL NEGATIVO — en un proceso real, SIN guardPool el corte de una conexión prestada MATA al proceso; CON guardPool el proceso termina bien', () => {
    const unguarded = childRun(false);
    expect(unguarded.code).not.toBe(0);
    expect(unguarded.output).toMatch(/Unhandled 'error' event|terminating connection|Connection terminated/);
    expect(unguarded.output).not.toContain('PROCESO_VIVO');
    const guarded = childRun(true);
    expect({ code: guarded.code, vivo: guarded.output.includes('PROCESO_VIVO') }).toEqual({ code: 0, vivo: true });
  });
});
