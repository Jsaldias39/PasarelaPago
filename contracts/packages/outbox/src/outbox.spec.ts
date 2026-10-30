import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect, type NatsConnection, type JetStreamManager } from 'nats';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { newCloudEvent, type CloudEvent } from './cloudevent';
import { enqueue, OutboxRelay, type EventPublisher } from './outbox';
import { processOnce } from './inbox';
import { ensureStream, NatsEventPublisher } from './nats';

const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
let db: IsolatedDatabase;
let nc: NatsConnection;
let jsm: JetStreamManager;

beforeAll(async () => {
  db = await createIsolatedDatabase([join(__dirname, '../sql/001_outbox_inbox.sql')]);
  await db.pool.query('CREATE TABLE effects (id serial PRIMARY KEY, label text NOT NULL)');
  nc = await connect({ servers: NATS_URL });
  jsm = await nc.jetstreamManager();
});
afterAll(async () => {
  await nc.drain();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('TRUNCATE outbox_events, inbox_events, effects');
});

/** Un stream aislado por prueba: nombre y temas únicos. */
async function newStream(): Promise<{ name: string; prefix: string; messages: () => Promise<CloudEvent[]>; drop: () => Promise<void> }> {
  const tag = randomBytes(4).toString('hex');
  const name = `T_${tag}`;
  const prefix = `t-${tag}`;
  await ensureStream(jsm, name, [`${prefix}.>`]);
  return {
    name,
    prefix,
    async messages() {
      const info = await jsm.streams.info(name);
      const out: CloudEvent[] = [];
      for (let seq = info.state.first_seq; seq <= info.state.last_seq && info.state.messages > 0; seq += 1) {
        out.push((await jsm.streams.getMessage(name, { seq })).json<CloudEvent>());
      }
      return out;
    },
    drop: async () => {
      await jsm.streams.delete(name);
    },
  };
}

async function emit(prefix: string, n: number, start = 1): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  for (let i = start; i < start + n; i += 1) {
    const event = newCloudEvent({ source: '/pay-payments', type: 'payment_intent.succeeded', data: { n: i } });
    events.push(event);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await enqueue(client, event, { aggregateType: 'payment_intent', aggregateId: 'pi_1', subject: `${prefix}.payment_intent.succeeded` });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
  return events;
}

describe('outbox + relé + NATS JetStream (reales)', () => {
  it('publica en orden todo lo confirmado', async () => {
    const stream = await newStream();
    const events = await emit(stream.prefix, 25);
    const relay = new OutboxRelay(db.pool, new NatsEventPublisher(nc), { batchSize: 10 });

    let total = 0;
    for (let i = 0; i < 5; i += 1) total += await relay.drainOnce();

    expect(total).toBe(25);
    const received = await stream.messages();
    expect(received.map((e) => e.id)).toEqual(events.map((e) => e.id));
    const pending = await db.pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
    expect(pending.rows[0].n).toBe(0);
    await stream.drop();
  });

  it('una transacción deshecha no deja evento: sin commit no hay evento', async () => {
    const stream = await newStream();
    const client = await db.pool.connect();
    await client.query('BEGIN');
    await enqueue(client, newCloudEvent({ source: '/pay-payments', type: 'payment_intent.succeeded', data: {} }), {
      aggregateType: 'payment_intent',
      aggregateId: 'pi_x',
      subject: `${stream.prefix}.x`,
    });
    await client.query('ROLLBACK');
    client.release();

    const relay = new OutboxRelay(db.pool, new NatsEventPublisher(nc));
    expect(await relay.drainOnce()).toBe(0);
    expect(await stream.messages()).toHaveLength(0);
    await stream.drop();
  });

  it('si la publicación falla se detiene sin saltear el orden y retoma desde ahí', async () => {
    const stream = await newStream();
    const events = await emit(stream.prefix, 6);
    const real = new NatsEventPublisher(nc);
    let failOnce = true;
    const flaky: EventPublisher = {
      async publish(subject, event) {
        if (event.id === events[2].id && failOnce) {
          failOnce = false;
          throw new Error('NATS caído');
        }
        await real.publish(subject, event);
      },
    };
    const errors: string[] = [];
    const relay = new OutboxRelay(db.pool, flaky, { onError: (e) => errors.push(e.message) });

    expect(await relay.drainOnce()).toBe(2); // 1 y 2; se frena en el 3
    expect((await stream.messages()).map((e) => e.id)).toEqual([events[0].id, events[1].id]);
    const failed = (await db.pool.query('SELECT attempts, last_error FROM outbox_events WHERE id = $1', [events[2].id])).rows[0];
    expect(failed).toEqual({ attempts: 1, last_error: 'NATS caído' });
    expect(errors).toEqual(['NATS caído']);

    expect(await relay.drainOnce()).toBe(4); // 3, 4, 5 y 6, en orden
    expect((await stream.messages()).map((e) => e.id)).toEqual(events.map((e) => e.id));
    await stream.drop();
  });

  it('publicó pero el relé murió antes del COMMIT: la republicación NO duplica el mensaje (Nats-Msg-Id)', async () => {
    const stream = await newStream();
    const [event] = await emit(stream.prefix, 1);
    const real = new NatsEventPublisher(nc);
    let crash = true;
    const publishThenCrash: EventPublisher = {
      async publish(subject, e) {
        await real.publish(subject, e); // el mensaje llega a JetStream...
        if (crash) {
          crash = false;
          throw new Error('el proceso murió antes de marcar'); // ...pero el outbox no se entera
        }
      },
    };
    const relay = new OutboxRelay(db.pool, publishThenCrash);

    expect(await relay.drainOnce()).toBe(0);
    expect(await relay.drainOnce()).toBe(1); // se vuelve a publicar el mismo evento
    const received = await stream.messages();
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(event.id);
    await stream.drop();
  });

  it('dos relés a la vez no duplican ni desordenan: el candado deja drenar a uno', async () => {
    const stream = await newStream();
    const events = await emit(stream.prefix, 40);
    const publisher = new NatsEventPublisher(nc);
    const relays = Array.from({ length: 2 }, () => new OutboxRelay(db.pool, publisher, { batchSize: 100 }));

    const counts = await Promise.all(relays.map((r) => r.drainOnce()));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(40);
    expect((await stream.messages()).map((e) => e.id)).toEqual(events.map((e) => e.id));
    await stream.drop();
  });

  it('start() drena solo y stop() lo detiene', async () => {
    const stream = await newStream();
    const relay = new OutboxRelay(db.pool, new NatsEventPublisher(nc), { pollIntervalMs: 20 });
    relay.start();
    await emit(stream.prefix, 3);
    const deadline = Date.now() + 5000;
    while ((await stream.messages()).length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    relay.stop();
    expect(await stream.messages()).toHaveLength(3);
    await stream.drop();
  });
});

describe('stop() del relé', () => {
  it('espera al ciclo en curso: al resolver, ya no hay publicaciones ni consultas pendientes', async () => {
    let started = 0;
    let finished = 0;
    const slowPool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        finished += 1;
        throw new Error('el pool ya se cerró');
      },
    };
    const errors: string[] = [];
    const relay = new OutboxRelay(slowPool, { publish: async () => undefined }, { pollIntervalMs: 10, onError: (e) => errors.push(e.message) });
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 40)); // el primer ciclo está en curso, dentro del connect lento
    expect(started).toBe(1);
    expect(finished).toBe(0);
    await relay.stop();
    expect(finished).toBe(1); // stop() esperó a que ese ciclo terminara
    const errorsAtStop = errors.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(started).toBe(1); // y no arrancó otro
    expect(errors.length).toBe(errorsAtStop);
  });

  it('stop() sin ciclo en curso, o llamado dos veces, no falla', async () => {
    const relay = new OutboxRelay({ query: async () => ({ rows: [], rowCount: 0 }), connect: async () => { throw new Error('x'); } }, { publish: async () => undefined });
    await expect(relay.stop()).resolves.toBeUndefined();
    relay.start();
    await relay.stop();
    await expect(relay.stop()).resolves.toBeUndefined();
  });
});

describe('relé ante una base caída', () => {
  it('espacia los reintentos en vez de martillar: con 20 ms de sondeo hace pocos intentos en 700 ms', async () => {
    const errors: string[] = [];
    const brokenPool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => { throw new Error('base caída'); } };
    const relay = new OutboxRelay(brokenPool, { publish: async () => undefined }, { pollIntervalMs: 20, onError: (e) => errors.push(e.message) });
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 700));
    relay.stop();
    // Sin retroceso serían ~35 intentos; con 40, 80, 160, 320 ms son 4 o 5.
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBeLessThanOrEqual(7);
    expect(new Set(errors)).toEqual(new Set(['base caída']));
  });
});

describe('inbox (efecto único)', () => {
  const work = (label: string) => async (client: { query(t: string, p?: unknown[]): Promise<unknown> }) => {
    await client.query('INSERT INTO effects (label) VALUES ($1)', [label]);
  };
  const effects = async (label: string) =>
    Number((await db.pool.query('SELECT count(*)::int AS n FROM effects WHERE label = $1', [label])).rows[0].n);

  it('20 entregas simultáneas del mismo evento producen UN solo efecto', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => processOnce(db.pool, 'pay-ledger.payment', 'evt-1', work('once'))));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(19);
    expect(await effects('once')).toBe(1);
  });

  it('si el efecto falla, el evento NO queda registrado y el reintento lo procesa', async () => {
    await expect(
      processOnce(db.pool, 'pay-ledger.payment', 'evt-2', async (client) => {
        await client.query("INSERT INTO effects (label) VALUES ('rollback')");
        throw new Error('falló el efecto');
      }),
    ).rejects.toThrow('falló el efecto');
    expect(await effects('rollback')).toBe(0);
    expect(await processOnce(db.pool, 'pay-ledger.payment', 'evt-2', work('retry'))).toBe('processed');
    expect(await effects('retry')).toBe(1);
  });

  it('el mismo evento en otro consumidor sí se procesa', async () => {
    expect(await processOnce(db.pool, 'consumidor-a', 'evt-3', work('a'))).toBe('processed');
    expect(await processOnce(db.pool, 'consumidor-b', 'evt-3', work('b'))).toBe('processed');
    expect(await processOnce(db.pool, 'consumidor-a', 'evt-3', work('a2'))).toBe('duplicate');
  });
});
