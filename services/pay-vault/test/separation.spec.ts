import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PG_POOL } from '../src/database.module';

/**
 * Regla de separación #1 (PLAN-MAESTRO §3.2 y §7, gate «Separación»): el servicio arranca con el rol de SU base y ese rol no tiene
 * permisos sobre las demás. El rol es el REAL del Compose (`platform/postgres/init-databases.sh`: `pay_<svc>` / `dev_only_<svc>`),
 * no un doble: las credenciales de abajo son las de desarrollo local y están escritas a propósito (no se leen del entorno, para que
 * un `DB_USER` de superusuario en el entorno no pueda volver verde esta prueba).
 */
const SERVICE = 'vault';
const ROLE = `pay_${SERVICE}`;
const OWN_DB = `pay_${SERVICE}`;
const PASSWORD = `dev_only_${SERVICE}`;
const HOST = process.env.DB_HOST ?? '127.0.0.1';
const PORT = Number(process.env.DB_PORT ?? 54321);

const connect = async (database: string, user = ROLE, password = PASSWORD): Promise<Pool> => {
  const pool = new Pool({ host: HOST, port: PORT, user, password, database, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => undefined);
  return pool;
};
/** Código SQLSTATE con el que Postgres rechaza el intento de conectarse (42501 = insufficient_privilege). */
const connectError = async (database: string): Promise<string | null> => {
  const pool = await connect(database);
  try {
    await pool.query('SELECT 1');
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  } finally {
    await pool.end();
  }
};

describe(`separación — pay-${SERVICE} arranca con ${ROLE} y ese rol no tiene nada en las demás bases`, () => {
  let own: Pool;
  let databases: string[];
  beforeAll(async () => {
    own = await connect(OWN_DB);
    databases = (await own.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1')).rows.map((r) => r.datname);
  });
  afterAll(async () => own.end());

  it('el rol del Compose entra a su base y se llama como debe', async () => {
    expect((await own.query('SELECT current_user AS u, current_database() AS d')).rows[0]).toEqual({ u: ROLE, d: OWN_DB });
  });

  it('el rol no es superusuario ni puede crear bases, roles, replicar ni saltarse la seguridad por filas; no pertenece a otro rol', async () => {
    const role = (await own.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await own.query('SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = current_user')).rows[0].n).toBe(0);
  });

  it('hay una base por servicio más las de mantenimiento: la lista que se prueba no está vacía por accidente', () => {
    expect(databases).toEqual(expect.arrayContaining(['pay_edge', 'pay_ledger', 'pay_payments', 'pay_vault', 'pay_test', 'postgres']));
  });

  it('CONNECT está concedido SOLO sobre la base propia: en cada base de servicio, en pay_test y en postgres el privilegio es falso', async () => {
    const privileges = (await own.query<{ datname: string; ok: boolean }>("SELECT datname, has_database_privilege(current_user, datname, 'CONNECT') AS ok FROM pg_database WHERE datallowconn")).rows;
    const granted = privileges.filter((p) => p.ok && p.datname !== 'template1').map((p) => p.datname);
    expect(granted).toEqual([OWN_DB]);
  });

  it('control: la misma sonda SÍ detecta una conexión permitida (la base propia devuelve null), así que un 42501 de abajo es un rechazo real', async () => {
    expect(await connectError(OWN_DB)).toBeNull();
  });

  it('intentar conectarse con el rol a CADA base de otro servicio, a pay_test y a postgres es 42501 (permission denied), no otra causa', async () => {
    const others = databases.filter((d) => d !== OWN_DB && d !== 'template1');
    expect(others.length).toBeGreaterThanOrEqual(12);
    const results = await Promise.all(others.map(async (d) => [d, await connectError(d)] as const));
    expect(results.filter(([, code]) => code !== '42501')).toEqual([]);
  });

  // GAP conocido, del carril P1 (`platform/postgres/init-databases.sh`): falta `REVOKE ALL ON DATABASE template1 FROM PUBLIC`. template1 no tiene datos
  // de negocio, pero cualquier rol de servicio puede abrirla. `failing` pasa mientras el hueco exista y FALLA cuando P1 lo cierre (entonces: quitar `.failing`).
  it.failing('template1 también está cerrada al rol de servicio', async () => {
    expect(await connectError('template1')).toBe('42501');
  });

  it('un rol de OTRO servicio tampoco entra a esta base (el espejo de lo anterior)', async () => {
    const pool = new Pool({ host: HOST, port: PORT, user: 'pay_edge', password: 'dev_only_edge', database: OWN_DB, max: 1, connectionTimeoutMillis: 5000 });
    pool.on('error', () => undefined);
    await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: '42501' });
    await pool.end();
  });

  describe('la aplicación completa arranca con ESE rol', () => {
    const saved: Record<string, string | undefined> = {};
    let app: INestApplication;
    beforeAll(async () => {
      for (const [k, v] of Object.entries({ DB_HOST: HOST, DB_PORT: String(PORT), DB_NAME: OWN_DB, DB_USER: ROLE, DB_PASSWORD: PASSWORD })) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });
    afterAll(async () => {
      await app.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('/health/ready responde 200 con la base propia y el pool de la aplicación es de ese rol', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(response.body.info.database.status).toBe('up');
      const pool = app.get<Pool>(PG_POOL);
      expect((await pool.query('SELECT current_user AS u, current_database() AS d')).rows[0]).toEqual({ u: ROLE, d: OWN_DB });
    });

    it('desde el pool de la aplicación, leer o escribir en otra base es imposible: no hay manera de cruzar de base dentro de una conexión', async () => {
      const pool = app.get<Pool>(PG_POOL);
      await expect(pool.query('SELECT 1 FROM pay_ledger.public.ledger_transactions')).rejects.toMatchObject({ code: '0A000' }); // cross-database references are not implemented
    });
  });
});
