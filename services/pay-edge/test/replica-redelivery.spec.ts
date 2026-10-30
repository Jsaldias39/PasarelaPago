import { randomBytes, randomUUID } from 'node:crypto';
import { AckPolicy, connect, DeliverPolicy, headers as natsHeaders, RetentionPolicy, StorageType, type NatsConnection } from 'nats';
import type { Pool } from 'pg';
import { generateApiKey } from '@pay/api-key';
import { ACK_WAIT_NS, DEFAULT_REDELIVERY, ensureUnlimitedDurable, redeliveryDelayMs, retryLogFields, STUCK_ALERT_DELIVERIES } from '../src/replica/consumer-redelivery';
import { ReplicaConsumer } from '../src/replica/replica.consumer';
import { startEdge, type EdgeHarness } from './harness';

/**
 * RE-REVISION-DINERO F-B2 contra un NATS JetStream REAL (2.10) y Postgres/Redis reales: el consumidor de la réplica de claves ya no abandona un evento a las
 * 20 entregas. Caso de seguridad: una `api_key.revoked` que no se pudo aplicar (base caída) tiene que acabar aplicándose, o la clave revocada sigue valiendo.
 * Lo simulado: el destino caído (la base de la réplica falla al abrir una conexión mientras `down`); NATS, el inbox y el borde son reales.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';

async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (accept(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`No se cumplió en ${timeoutMs} ms; último valor: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

describe('F-B2 · réplica de claves sin tope de entregas (NATS JetStream real)', () => {
  const suffix = randomBytes(4).toString('hex');
  const stream = `TEST_EDGER_${suffix}`;
  const prefix = `t${suffix}`;
  const durable = `edge-${suffix}`;
  let nc: NatsConnection;
  let h: EdgeHarness;
  let consumer: ReplicaConsumer;
  let down = false;
  let failedConnects = 0;
  const connectTimes: number[] = [];

  const publish = async (type: string, data: Record<string, unknown>, msgId?: string) => {
    const event = { specversion: '1.0', id: randomUUID(), source: '/pay-merchants', type, time: new Date().toISOString(), datacontenttype: 'application/json', data };
    const hdrs = natsHeaders();
    hdrs.set('Nats-Msg-Id', msgId ?? event.id);
    await nc.jetstream().publish(`${prefix}.${type}`, JSON.stringify(event), { headers: hdrs });
    return event;
  };
  const status = async (token: string) => (await h.http().get('/v1/balance').set('Authorization', `Bearer ${token}`)).status;
  const pending = async () => {
    const info = await (await nc.jetstreamManager()).consumers.info(stream, durable);
    return { unprocessed: info.num_pending, inFlight: info.num_ack_pending };
  };

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL, name: 'edge-replica-redelivery-test' });
    const manager = await nc.jetstreamManager();
    await manager.streams.add({ name: stream, subjects: [`${prefix}.>`], retention: RetentionPolicy.Limits, storage: StorageType.Memory, duplicate_window: 120_000_000_000 });
    // El durable ya existe con la configuración VIEJA (max_deliver 20) cuando arranca el servicio: la migración se prueba de punta a punta.
    await manager.consumers.add(stream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: ['api_key.created', 'api_key.revoked', 'merchant.activated', 'merchant.suspended', 'merchant.closed'].map((t) => `${prefix}.${t}`),
      max_deliver: 20,
    });
    h = await startEdge({ env: { NATS_URL, REPLICA_STREAM: stream, REPLICA_SUBJECT_PREFIX: prefix, REPLICA_DURABLE: durable, RATE_LIMIT_IP_PER_WINDOW: '1000000', RATE_LIMIT_KEY_PER_WINDOW: '1000000', RATE_LIMIT_AUTH_FAILURES_PER_WINDOW: '100000' } });
    consumer = h.app.get(ReplicaConsumer);
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
              connectTimes.push(Date.now());
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
    await h.stop();
    await (await nc.jetstreamManager()).streams.delete(stream).catch(() => undefined);
    await nc.drain();
  });

  it('el durable viejo se migró al arrancar el servicio', async () => {
    const info = await (await nc.jetstreamManager()).consumers.info(stream, durable);
    expect(info.config).toMatchObject({ max_deliver: -1, ack_wait: ACK_WAIT_NS });
  });

  it('CORRECTO/LÍMITE: una revocación que no se pudo aplicar durante MÁS de 20 entregas (25) se aplica al volver la base: la clave deja de valer y el efecto ocurre UNA vez', async () => {
    const key = generateApiKey('test');
    const merchantId = `mc_${randomBytes(6).toString('hex')}`;
    await publish('api_key.created', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, key_hash: key.keyHash });
    await eventually(() => status(key.token), (s) => s === 200);
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0);

    down = true;
    failedConnects = 0;
    connectTimes.length = 0;
    const revoked = await publish('api_key.revoked', { key_id: key.keyId, merchant_id: merchantId, mode: key.mode, revoked_at: new Date().toISOString() });
    await eventually(async () => failedConnects, (n) => n >= 25); // 25 entregas fallidas: más allá del tope anterior (20)
    // la espera entre entregas la pone el código (cap = 25 ms aquí): una reentrega en caliente (nak sin retardo) daría huecos de ~1 ms
    const gaps = connectTimes.slice(14, 25).map((time, i) => time - connectTimes[14 + i - 1]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15);
    expect(await status(key.token)).toBe(200); // mientras la base está caída la revocación no se ha podido aplicar (el riesgo que se cierra)

    down = false;
    await eventually(() => status(key.token), (s) => s === 401); // al volver, la revocación se aplica
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0);
    expect(failedConnects).toBeGreaterThanOrEqual(25);
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [revoked.id])).rows[0].n).toBe(1);

    // la reentrega de lo ya aplicado (el mismo evento con otro id de NATS) no duplica el efecto: idempotencia del inbox
    await nc.jetstream().publish(`${prefix}.api_key.revoked`, JSON.stringify(revoked), { headers: (() => { const hdrs = natsHeaders(); hdrs.set('Nats-Msg-Id', `otra-${revoked.id}`); return hdrs; })() });
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0);
    expect((await h.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [revoked.id])).rows[0].n).toBe(1);
    expect(await status(key.token)).toBe(401);
  });

  it('INVÁLIDO: JSON ilegible y un sobre que rompe el contrato se descartan (term) y NO giran para siempre aunque no haya tope', async () => {
    const before = failedConnects;
    await nc.jetstream().publish(`${prefix}.api_key.created`, 'esto no es json');
    await nc.jetstream().publish(`${prefix}.api_key.created`, JSON.stringify({ id: 'x' }));
    await eventually(pending, (p) => p.unprocessed === 0 && p.inFlight === 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(failedConnects).toBe(before);
    const info = await (await nc.jetstreamManager()).consumers.info(stream, durable);
    expect(info.num_ack_pending).toBe(0);
  });

  it('INVÁLIDO: un durable viejo con eventos ya varados por el tope se avisa (alert) al migrar', async () => {
    const manager = await nc.jetstreamManager();
    const name = `varado-${suffix}`;
    await manager.consumers.add(stream, { durable_name: name, filter_subject: `${prefix}.nunca.>`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: 500_000_000, max_deliver: 2 });
    await nc.jetstream().publish(`${prefix}.nunca.uno`, 'x');
    const messages = await (await nc.jetstream().consumers.get(stream, name)).consume({ max_messages: 5 });
    let seen = 0;
    void (async () => {
      for await (const m of messages) {
        seen += 1;
        m.nak(50);
      }
    })();
    await eventually(async () => seen, (n) => n >= 2, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    messages.stop();
    expect(seen).toBe(2);
    const warnings: Record<string, unknown>[] = [];
    await ensureUnlimitedDurable(manager, stream, { durable_name: name, filter_subject: `${prefix}.nunca.>`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All }, (fields) => warnings.push(fields));
    expect(warnings[0]).toMatchObject({ durable: name, previous_max_deliver: 2, possibly_stranded: true, alert: true });
  });
});
