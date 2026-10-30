import { randomBytes, randomUUID } from 'node:crypto';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { AckPolicy, connect, DeliverPolicy, headers, type NatsConnection } from 'nats';
import type { Pool } from 'pg';
import { ensureStream } from '@pay/outbox';
import { ACK_WAIT_NS, DEFAULT_REDELIVERY, ensureUnlimitedDurable, redeliveryDelayMs, retryLogFields, STUCK_ALERT_DELIVERIES } from '../src/replica/consumer-redelivery';
import { MerchantReplicaConsumer } from '../src/replica/replica.consumer';
import { createTestContext, EVENTS, type TestContext } from './support/app';
import { newMerchant, rows } from './support/http';

/**
 * RE-REVISION-DINERO F-B2 contra un NATS JetStream REAL (2.10) y Postgres real: el consumidor de `merchant.*` ya no abandona un evento a las 20 entregas.
 * Caso de dinero: un `merchant.suspended` que no se pudo aplicar (base caída) tiene que acabar aplicándose, o el comercio suspendido sigue con
 * cronogramas activos. Lo simulado: el destino caído (la base de la réplica falla al abrir una conexión mientras `down`); NATS y el inbox son reales.
 * Stream y temas PROPIOS de la prueba (prefijo único), como nats-replica.spec.ts.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const suffix = randomBytes(4).toString('hex');
const PREFIX = `p5r${suffix}`;
const STREAM = `P5R_${suffix.toUpperCase()}`;
const DURABLE = `p5r-${suffix}`;

describe('redeliveryDelayMs (la espera tras un fallo)', () => {
  it('CORRECTO: duplica en cada entrega y se acota en el tope', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => redeliveryDelayMs(n))).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
    expect(redeliveryDelayMs(1_000_000)).toBe(DEFAULT_REDELIVERY.capMs);
  });
  it('LÍMITE/INVÁLIDO: una cuenta ausente, cero, negativa o no finita cuenta como la primera; el aviso de varado empieza en STUCK_ALERT_DELIVERIES', () => {
    for (const n of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(redeliveryDelayMs(n)).toBe(DEFAULT_REDELIVERY.baseMs);
    expect(retryLogFields(STUCK_ALERT_DELIVERIES - 1)).toEqual({ delivery_count: STUCK_ALERT_DELIVERIES - 1 });
    expect(retryLogFields(STUCK_ALERT_DELIVERIES)).toEqual({ delivery_count: STUCK_ALERT_DELIVERIES, alert: true });
  });
});

describe('F-B2 · réplica de comercios sin tope de entregas (NATS JetStream real)', () => {
  let ctx: TestContext;
  let nats: NatsConnection;
  let example: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let down = false;
  let failedConnects = 0;

  const status = async (id: string) => (await rows(ctx, 'SELECT status FROM merchant_replica WHERE merchant_id = $1', [id]))[0]?.status as string | undefined;
  const info = async () => (await nats.jetstreamManager()).consumers.info(STREAM, DURABLE);
  const pending = async () => {
    const i = await info();
    return { unprocessed: i.num_pending, inFlight: i.num_ack_pending };
  };
  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      value = await read();
    }
    if (!done(value)) throw new Error(`No se cumplió a tiempo: ${what} (último: ${JSON.stringify(value)})`);
    return value;
  }
  const suspended = (merchantId: string, id = randomUUID()) => {
    const base = structuredClone(example);
    const at = new Date().toISOString();
    base.id = id;
    base.subject = merchantId;
    base.merchantid = merchantId;
    base.time = at;
    base.data.merchant_id = merchantId;
    base.data.suspended_at = at;
    return base;
  };
  const publish = async (raw: unknown, msgId = randomUUID()) => {
    const h = headers();
    h.set('content-type', 'application/cloudevents+json');
    await nats.jetstream().publish(`${PREFIX}.merchant.suspended`, new TextEncoder().encode(typeof raw === 'string' ? raw : JSON.stringify(raw)), { msgID: msgId, headers: h });
  };

  beforeAll(async () => {
    nats = await connect({ servers: NATS_URL, name: 'p5-redelivery-test' });
    const manager = await nats.jetstreamManager();
    await ensureStream(manager, STREAM, [`${PREFIX}.>`]);
    const doc = (await $RefParser.dereference(EVENTS)) as { components: { messages: Record<string, { examples: { payload: Record<string, any> }[] }> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    example = doc.components.messages.MerchantSuspended.examples[0].payload;
    // El durable ya existe con la configuración VIEJA (max_deliver 20) cuando arranca el servicio: la migración se prueba de punta a punta.
    await manager.consumers.add(STREAM, {
      durable_name: DURABLE,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: ['merchant.activated', 'merchant.suspended', 'merchant.closed'].map((t) => `${PREFIX}.${t}`),
      max_deliver: 20,
    });
    ctx = await createTestContext({ natsUrl: NATS_URL, settings: { merchantsStream: STREAM, merchantsDurable: DURABLE, merchantsSubjectPrefix: PREFIX } });
    const consumer = ctx.app.get(MerchantReplicaConsumer);
    await consumer.ready;
    consumer.redelivery = { baseMs: 5, capMs: 25 };
    // El destino del consumidor (la base de la réplica) cae: abrir una conexión falla mientras `down`. Todo lo demás es el servicio real.
    const real = (consumer as unknown as { pool: Pool }).pool;
    (consumer as unknown as { pool: unknown }).pool = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'connect') {
          return async (...args: unknown[]) => {
            if (down) {
              failedConnects += 1;
              throw new Error('base de la réplica caída');
            }
            return (target.connect as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  afterAll(async () => {
    await ctx.close();
    await (await nats.jetstreamManager()).streams.delete(STREAM).catch(() => undefined);
    await nats.drain();
  });

  it('el durable viejo se migró al arrancar el servicio', async () => {
    expect((await info()).config).toMatchObject({ max_deliver: -1, ack_wait: ACK_WAIT_NS });
  });

  it('CORRECTO/LÍMITE: una suspensión que no se pudo aplicar durante MÁS de 20 entregas (25) se aplica al volver la base; el efecto ocurre UNA vez y repetirla no lo duplica', async () => {
    const id = newMerchant();
    down = true;
    failedConnects = 0;
    const event = suspended(id);
    await publish(event);
    await eventually(async () => failedConnects, (n) => n >= 25, '25 entregas fallidas (más allá del tope anterior)');
    expect(await status(id)).toBeUndefined(); // nada se aplicó a medias

    down = false;
    expect(await eventually(() => status(id), (s) => s === 'suspended', 'suspendido tras la caída')).toBe('suspended');
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0, 'cola vacía');
    expect(failedConnects).toBeGreaterThanOrEqual(25);
    const inbox = async () => Number((await rows(ctx, 'SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id]))[0].n);
    expect(await inbox()).toBe(1);

    // la reentrega de lo ya aplicado (el mismo evento con otro id de NATS) no duplica el efecto: idempotencia del inbox
    await publish(event, `otra-${event.id}`);
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0, 'cola vacía tras el duplicado');
    expect(await inbox()).toBe(1);
    expect(await status(id)).toBe('suspended');
  });

  it('INVÁLIDO: JSON ilegible y un evento que rompe el contrato se descartan (term) y NO giran para siempre aunque no haya tope', async () => {
    const before = failedConnects;
    await publish('esto no es json');
    await publish({ id: 'x' });
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0, 'cola vacía');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(failedConnects).toBe(before);
    expect((await info()).num_ack_pending).toBe(0);
  });

  it('INVÁLIDO: un durable viejo con eventos ya varados por el tope se avisa (alert) al migrar', async () => {
    const manager = await nats.jetstreamManager();
    const name = `varado-${suffix}`;
    await manager.consumers.add(STREAM, { durable_name: name, filter_subject: `${PREFIX}.nunca.>`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: 500_000_000, max_deliver: 2 });
    await nats.jetstream().publish(`${PREFIX}.nunca.uno`, 'x');
    const messages = await (await nats.jetstream().consumers.get(STREAM, name)).consume({ max_messages: 5 });
    let seen = 0;
    void (async () => {
      for await (const m of messages) {
        seen += 1;
        m.nak(50);
      }
    })();
    await eventually(async () => seen, (n) => n >= 2, 'dos entregas', 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    messages.stop();
    expect(seen).toBe(2);
    const warnings: Record<string, unknown>[] = [];
    await ensureUnlimitedDurable(manager, STREAM, { durable_name: name, filter_subject: `${PREFIX}.nunca.>`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All }, (fields) => warnings.push(fields));
    expect(warnings[0]).toMatchObject({ durable: name, previous_max_deliver: 2, possibly_stranded: true, alert: true });
  });
});
