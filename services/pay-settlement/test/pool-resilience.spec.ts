import { jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { Controller, Get, Inject, Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/core';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { IdempotencyStore, guardPool } from '@pay/idempotency';
import { OutboxRelay, processOnce, type CloudEvent, type EventPublisher } from '@pay/outbox';
import { TEST_DATABASE_URL } from '@pay/testing';
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
// Las conexiones de «control» de la prueba también son un `Pool` envuelto: en un Postgres compartido otras suites cortan conexiones (por base o por rol) y un
// `Client` suelto sin manejador tumbaría la suite entera por una conexión que no es la que se está probando.
let admin: Pool;
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
  admin = guardPool(new Pool({ connectionString: dbUrl, max: 1 }));
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
  it('el PG_POOL del módulo real está envuelto por `guardPool` (manejador del pool + manejador de cada cliente que presta)', () => {
    expect(pool.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(pool.listenerCount('connect')).toBeGreaterThanOrEqual(1);
  });

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

/**
 * Los clientes que PRESTAN las librerías compartidas (`@pay/idempotency`, `@pay/outbox`): hacen `pool.connect()` y esperan a otro sistema entre consultas.
 * Se prueban con el pool envuelto EXACTAMENTE como el de producción (`guardPool`) sobre un esquema desechable con el DDL del modelo. Regla 11: un corte en
 * medio de una operación es AMBIGUO, no un fallo definitivo: nunca queda un efecto a medias, y reintentar con la misma clave converge sin duplicar.
 */
/**
 * Esquema desechable con el DDL del modelo, como `createIsolatedDatabase` de `@pay/testing`, pero con TODOS sus pools envueltos en `guardPool`: el de la librería
 * deja un pool auxiliar sin manejador abierto toda la suite, y en un Postgres compartido otra suite que corte conexiones (por base o por rol) lo tumba con un
 * `Unhandled error` que hace fallar ESTA suite aunque lo que se prueba esté bien.
 */
async function guardedIsolatedDatabase(ddlFile: string): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const auxiliary = guardPool(new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }));
  await auxiliary.query(`CREATE SCHEMA ${schema}`);
  const isolated = guardPool(new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 6 }));
  await isolated.query(readFileSync(ddlFile, 'utf8'));
  return {
    pool: isolated,
    drop: async () => {
      await isolated.end();
      await auxiliary.query(`DROP SCHEMA ${schema} CASCADE`);
      await auxiliary.end();
    },
  };
}

describe('las librerías que prestan conexión: corte con pg_terminate_backend EN MEDIO de una transacción', () => {
  let db: Awaited<ReturnType<typeof guardedIsolatedDatabase>>;
  let killer: Pool;
  const rand = () => Math.random().toString(36).slice(2, 12);
  const effects = async () => Number((await db.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_type = 'prueba-corte'")).rows[0].n);
  const effect = (client: { query: Pool['query'] } | { query: (t: string, p?: unknown[]) => Promise<unknown> }, id: string) =>
    client.query(`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, type, subject, envelope) VALUES ($1::uuid, 'prueba-corte', $1::text, 'prueba.corte', 'prueba.corte', jsonb_build_object('id', $1::text))`, [id]);
  /** Corta el backend y sigue consultando por esa conexión hasta que falle: el corte cae «en medio» de la transacción. */
  const cutAndTouch = async (client: { query: (t: string, p?: unknown[]) => Promise<unknown> }, pid: number) => {
    await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    for (let i = 0; i < 100; i += 1) {
      await client.query('SELECT 1');
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  const pidOf = async (client: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;

  beforeAll(async () => {
    db = await guardedIsolatedDatabase(resolve(process.cwd(), 'sql/ddl.sql'));
    killer = guardPool(new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }));
  });
  afterAll(async () => {
    await killer.end();
    await db.drop();
  });

  it('@pay/idempotency: cortar DENTRO de `atomic` ⇒ el proceso sigue, la operación falla, el efecto NO queda, y reintentar con la misma clave lo aplica UNA sola vez', async () => {
    const store = new IdempotencyStore(db.pool);
    const request = { scope: 'prueba:corte', key: `k-${rand()}`, requestHash: 'h1' };
    const id = randomUUID();
    const operation = (cut: boolean) => async (ctx: { atomic: <R>(point: string, work: (c: { query: (t: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<R>) => Promise<R> }) => {
      await ctx.atomic('efecto-aplicado', async (client) => {
        const pid = await pidOf(client);
        await effect(client, id);
        if (cut) await cutAndTouch(client, pid);
      });
      return { status: 201, body: { id } };
    };

    await expect(store.execute(request, operation(true))).rejects.toThrow();
    expect(await effects()).toBe(0); // la transacción se deshizo entera: ni un efecto a medias
    const row = (await db.pool.query('SELECT state, locked_at FROM idempotency_keys WHERE scope = $1 AND key = $2', [request.scope, request.key])).rows[0];
    expect(row).toMatchObject({ state: 'started', locked_at: null }); // la clave quedó libre para el reintento (no «completada» con un fallo)

    const retry = await store.execute(request, operation(false));
    expect(retry).toMatchObject({ status: 201, replayed: false });
    expect(await effects()).toBe(1);
    const again = await store.execute(request, operation(false));
    expect(again).toMatchObject({ status: 201, replayed: true });
    expect(await effects()).toBe(1); // exactamente una vez
  });

  it('@pay/outbox (inbox): cortar dentro de `processOnce` ⇒ ni el efecto ni la marca del evento quedan; el reintento lo procesa una vez y la tercera entrega es duplicado', async () => {
    const eventId = randomUUID();
    const id = randomUUID();
    const before = await effects();
    await expect(
      processOnce(db.pool, 'prueba-corte', eventId, async (client) => {
        const pid = await pidOf(client);
        await effect(client, id);
        await cutAndTouch(client, pid);
      }),
    ).rejects.toThrow();
    expect(await effects()).toBe(before); // el efecto de la transacción cortada no quedó
    const marked = async () => Number((await db.pool.query("SELECT count(*)::int AS n FROM inbox_events WHERE consumer = 'prueba-corte' AND event_id = $1", [eventId])).rows[0].n);
    expect(await marked()).toBe(0);
    expect(await processOnce(db.pool, 'prueba-corte', eventId, async (client) => void (await effect(client, id)))).toBe('processed');
    expect(await effects()).toBe(before + 1);
    expect(await processOnce(db.pool, 'prueba-corte', eventId, async () => undefined)).toBe('duplicate');
    expect(await marked()).toBe(1);
  });

  it('@pay/outbox (relé): cortar con la transacción del relé abierta y el evento ya «publicado» ⇒ `drainOnce` falla, NADA queda marcado como publicado, y el siguiente ciclo lo entrega otra vez (al menos una vez; mismo id para deduplicar)', async () => {
    await db.pool.query("DELETE FROM outbox_events WHERE aggregate_type = 'prueba-corte'"); // solo los eventos de ESTA prueba esperan al relé
    const ids: string[] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await effect(db.pool, id);
    let relayPid = 0;
    const delivered: string[] = [];
    let cutOnce = true;
    const publisher: EventPublisher = {
      publish: async (_subject: string, event: CloudEvent) => {
        delivered.push(event.id);
        if (cutOnce) {
          cutOnce = false;
          await killer.query('SELECT pg_terminate_backend($1)', [relayPid]); // la publicación «salió», pero se pierde la conexión antes de marcarla
          await new Promise((r) => setTimeout(r, 200));
        }
      },
    };
    const spyPool = {
      query: db.pool.query.bind(db.pool),
      connect: async () => {
        const client = await db.pool.connect();
        relayPid = await pidOf(client);
        return client;
      },
    };
    const relay = new OutboxRelay(spyPool as never, publisher);
    const published = async () => Number((await db.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_type = 'prueba-corte' AND aggregate_id = ANY($1) AND published_at IS NOT NULL", [ids])).rows[0].n);

    await expect(relay.drainOnce()).rejects.toThrow();
    expect(await published()).toBe(0); // la transacción del relé se deshizo: ningún evento quedó marcado
    expect(delivered).toHaveLength(1); // …pero el primero ya salió una vez (ambiguo, no fallo)

    let drained = 0;
    while (drained < 3) drained += await relay.drainOnce();
    expect(await published()).toBe(3);
    const mine = delivered.filter((d) => ids.includes(d));
    expect(new Set(mine)).toEqual(new Set(ids)); // todos entregados…
    expect(mine.filter((d) => d === mine[0]).length).toBe(2); // …y el primero DOS veces con el mismo id (el destino deduplica por Nats-Msg-Id)
  });
});
