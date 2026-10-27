import { join } from 'node:path';
import { EntitySchema, MikroORM } from '@mikro-orm/postgresql';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { enqueue } from '@pay/outbox';
import { ormQueryable, toMikroOrmSql, type EntityManagerLike } from './index';

/**
 * Lo que la prueba usa del EntityManager, tipado a mano: con @mikro-orm 7.2.5 los tipos de `core` y de `postgresql` no
 * son compatibles entre sí (la API compila porque resuelve 7.1.7). Ver docs/trabajo/ola-1/P1/PROPUESTAS.md, propuesta 1.
 * El código de producción (`index.ts`) no depende de esos tipos: es estructural.
 */
interface TxEm extends EntityManagerLike {
  persist(entity: unknown): void;
  create(schema: unknown, data: unknown): unknown;
  flush(): Promise<void>;
  fork(): TxEm;
  transactional<T>(callback: (tx: TxEm) => Promise<T>): Promise<T>;
}

interface Order { id?: number; label: string }
const OrderSchema = new EntitySchema<Order>({
  name: 'Order',
  tableName: 'orders',
  properties: { id: { type: 'number', primary: true, autoincrement: true }, label: { type: 'string' } },
});

const OUTBOX_SQL = join(process.cwd(), '../outbox/sql/001_outbox_inbox.sql');
let db: IsolatedDatabase;
const createOrm = (schema: string) => {
  const url = new URL(TEST_DATABASE_URL);
  return MikroORM.init({
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    dbName: url.pathname.slice(1),
    entities: [OrderSchema],
    // el esquema de esta prueba: las tablas del outbox están sin calificar, así que el search_path las encuentra
    driverOptions: { options: `-c search_path=${schema}` },
    discovery: { warnWhenNoEntities: false },
    pool: { min: 1, max: 5 },
  });
};
let orm: Awaited<ReturnType<typeof createOrm>>;
const forkEm = (): TxEm => orm.em.fork() as unknown as TxEm;

beforeAll(async () => {
  db = await createIsolatedDatabase([OUTBOX_SQL]);
  await db.pool.query('CREATE TABLE orders (id serial PRIMARY KEY, label text NOT NULL)');
  orm = await createOrm(db.schema);
});
afterAll(async () => {
  await orm.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('TRUNCATE orders, outbox_events RESTART IDENTITY');
});

const event = (n: number) => ({
  specversion: '1.0' as const,
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  source: '/pay-edge',
  type: 'order.created',
  time: '2026-10-27T15:00:00.000Z',
  datacontenttype: 'application/json' as const,
  data: { n },
});
const counts = async () => ({
  orders: Number((await db.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n),
  outbox: Number((await db.pool.query('SELECT count(*)::int AS n FROM outbox_events')).rows[0].n),
});

describe('ormQueryable (MikroORM 7 + Postgres reales)', () => {
  it('confirmada la transacción: existen la entidad Y su evento, una vez', async () => {
    const em = forkEm();
    await em.transactional(async (tx) => {
      tx.persist(tx.create(OrderSchema, { label: 'a' }));
      await tx.flush();
      await enqueue(ormQueryable(tx), event(1), { aggregateType: 'order', aggregateId: '1', subject: 'pay-edge.order.created' });
    });
    expect(await counts()).toEqual({ orders: 1, outbox: 1 });
    const row = (await db.pool.query('SELECT id, type, subject, envelope FROM outbox_events')).rows[0];
    expect(row.id).toBe(event(1).id);
    expect(row.envelope.data).toEqual({ n: 1 });
  });

  it('deshecha la transacción: NO existen ni la entidad ni el evento', async () => {
    const em = forkEm();
    await expect(
      em.transactional(async (tx) => {
        tx.persist(tx.create(OrderSchema, { label: 'b' }));
        await tx.flush();
        await enqueue(ormQueryable(tx), event(2), { aggregateType: 'order', aggregateId: '2' });
        throw new Error('falla después de encolar');
      }),
    ).rejects.toThrow('falla después de encolar');
    expect(await counts()).toEqual({ orders: 0, outbox: 0 });
  });

  it('el evento se ve DENTRO de la transacción pero no fuera hasta confirmar (misma conexión)', async () => {
    const em = forkEm();
    let visibleOutside = -1;
    await em.transactional(async (tx) => {
      await enqueue(ormQueryable(tx), event(3), { aggregateType: 'order', aggregateId: '3' });
      const inside = await ormQueryable(tx).query('SELECT count(*)::int AS n FROM outbox_events');
      expect(inside.rows[0].n).toBe(1);
      visibleOutside = (await counts()).outbox;
    });
    expect(visibleOutside).toBe(0);
    expect((await counts()).outbox).toBe(1);
  });

  it('un evento repetido (mismo id) hace fallar la transacción entera y no deja nada a medias', async () => {
    const em = forkEm();
    await em.transactional(async (tx) => {
      await enqueue(ormQueryable(tx), event(4), { aggregateType: 'order', aggregateId: '4' });
    });
    await expect(
      forkEm().transactional(async (tx) => {
        tx.persist(tx.create(OrderSchema, { label: 'c' }));
        await tx.flush();
        await enqueue(ormQueryable(tx), event(4), { aggregateType: 'order', aggregateId: '4' });
      }),
    ).rejects.toThrow(/outbox_events_pkey|duplicate key/);
    expect(await counts()).toEqual({ orders: 0, outbox: 1 });
  });

  it('50 transacciones concurrentes: cada una deja su entidad y su evento, ni más ni menos', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_unused, i) =>
        forkEm().transactional(async (tx) => {
          tx.persist(tx.create(OrderSchema, { label: `o${i}` }));
          await tx.flush();
          await enqueue(ormQueryable(tx), event(100 + i), { aggregateType: 'order', aggregateId: String(i) });
        }),
      ),
    );
    expect(await counts()).toEqual({ orders: 50, outbox: 50 });
  });

  describe('toMikroOrmSql', () => {
    it('traduce $n a ? y reordena parámetros repetidos o desordenados', () => {
      expect(toMikroOrmSql('INSERT INTO t (a, b) VALUES ($2, $1) WHERE c = $2', ['x', 'y'])).toEqual({
        sql: 'INSERT INTO t (a, b) VALUES (?, ?) WHERE c = ?',
        params: ['y', 'x', 'y'],
      });
    });
    it('rechaza un ? literal y un marcador sin parámetro', () => {
      expect(() => toMikroOrmSql("SELECT '{}'::jsonb ? 'a'")).toThrow(RangeError);
      expect(() => toMikroOrmSql('SELECT $2', ['solo uno'])).toThrow(RangeError);
    });
  });
});
