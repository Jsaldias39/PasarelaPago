import { randomBytes } from 'node:crypto';
import { AckPolicy, connect, DeliverPolicy, headers as natsHeaders, RetentionPolicy, StorageType, type NatsConnection } from 'nats';
import { ACK_WAIT_NS, DEFAULT_REDELIVERY, ensureUnlimitedDurable, redeliveryDelayMs, retryLogFields, STUCK_ALERT_DELIVERIES } from '../src/events/consumer-redelivery';
import { cloudEvent } from './fixtures';
import { newKey, newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/**
 * RE-REVISION-DINERO F-B2 contra un NATS JetStream REAL (2.10): el consumidor durable ya no abandona un evento a las 20 entregas.
 * Lo simulado: el destino caído (el motor de entrega, que aquí falla N veces y luego responde), el DNS y el último salto de red.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const HOST = 'hooks.comercio.example';

async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
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
  it('LÍMITE: una cuenta ausente, cero, negativa o no finita cuenta como la primera entrega; el piso manda sobre la curva', () => {
    for (const n of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) expect(redeliveryDelayMs(n)).toBe(DEFAULT_REDELIVERY.baseMs);
    expect(redeliveryDelayMs(1, DEFAULT_REDELIVERY, 60_000)).toBe(60_000);
    expect(redeliveryDelayMs(20, DEFAULT_REDELIVERY, 60_000)).toBe(300_000);
  });
  it('INVÁLIDO: el aviso de «varado» se enciende desde la entrega STUCK_ALERT_DELIVERIES y no antes', () => {
    expect(retryLogFields(STUCK_ALERT_DELIVERIES - 1)).toEqual({ delivery_count: STUCK_ALERT_DELIVERIES - 1 });
    expect(retryLogFields(STUCK_ALERT_DELIVERIES)).toEqual({ delivery_count: STUCK_ALERT_DELIVERIES, alert: true });
  });
});

describe('F-B2 · consumidor durable sin tope de entregas (NATS JetStream real)', () => {
  const suffix = randomBytes(4).toString('hex');
  const stream = `TEST_WHR_${suffix}`;
  const prefix = `t${suffix}`;
  const streamName = (tag: string) => `TEST_WHR_${tag}_${suffix}`;
  let nc: NatsConnection;

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL, name: 'webhooks-redelivery-test' });
  });
  afterAll(async () => {
    const manager = await nc.jetstreamManager();
    for (const name of [stream, streamName('MIG'), streamName('STR')]) await manager.streams.delete(name).catch(() => undefined);
    await nc.drain();
  });

  describe('migración del durable (ensureUnlimitedDurable)', () => {
    const base = (name: string) => ({ durable_name: name, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: 'mig.>' });

    it('CORRECTO: sin durable lo crea sin tope y sin `backoff` del servidor; repetirlo no cambia nada', async () => {
      const manager = await nc.jetstreamManager();
      await manager.streams.add({ name: streamName('MIG'), subjects: ['mig.>'], storage: StorageType.Memory });
      expect(await ensureUnlimitedDurable(manager, streamName('MIG'), base('nuevo'))).toBe('created');
      const info = await manager.consumers.info(streamName('MIG'), 'nuevo');
      expect(info.config.max_deliver).toBe(-1);
      expect(info.config.ack_wait).toBe(ACK_WAIT_NS);
      expect(info.config.backoff).toBeUndefined();
      expect(await ensureUnlimitedDurable(manager, streamName('MIG'), base('nuevo'))).toBe('unchanged');
    });

    it('LÍMITE: un durable creado con la configuración VIEJA (max_deliver 20) se migra sin perder la posición; `add` a secas falla (por eso se actualiza)', async () => {
      const manager = await nc.jetstreamManager();
      await nc.jetstream().publish('mig.uno', 'x');
      await manager.consumers.add(streamName('MIG'), { ...base('viejo'), max_deliver: 20 });
      // la API que usaba el código anterior no sirve para cambiar la configuración de un durable existente
      await expect(manager.consumers.add(streamName('MIG'), { ...base('viejo'), max_deliver: -1, ack_wait: ACK_WAIT_NS })).rejects.toThrow(/already exists/);
      const warnings: Record<string, unknown>[] = [];
      expect(await ensureUnlimitedDurable(manager, streamName('MIG'), base('viejo'), (fields) => warnings.push(fields))).toBe('migrated');
      const info = await manager.consumers.info(streamName('MIG'), 'viejo');
      expect(info.config).toMatchObject({ max_deliver: -1, ack_wait: ACK_WAIT_NS });
      expect(info.num_pending).toBe(1);
      expect(warnings).toEqual([{ stream: streamName('MIG'), durable: 'viejo', previous_max_deliver: 20 }]);
      expect(await ensureUnlimitedDurable(manager, streamName('MIG'), base('viejo'))).toBe('unchanged');
    });

    it('INVÁLIDO: si el durable viejo ya dejó eventos varados por el tope, la migración lo avisa (alert) en vez de callar', async () => {
      const manager = await nc.jetstreamManager();
      await manager.streams.add({ name: streamName('STR'), subjects: ['str.>'], storage: StorageType.Memory });
      await nc.jetstream().publish('str.uno', 'x');
      const cfg = { durable_name: 'varado', ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: 'str.>', max_deliver: 2, ack_wait: 500_000_000 };
      await manager.consumers.add(streamName('STR'), cfg);
      const messages = await (await nc.jetstream().consumers.get(streamName('STR'), 'varado')).consume({ max_messages: 5 });
      let seen = 0;
      void (async () => {
        for await (const m of messages) {
          seen += 1;
          m.nak(50);
        }
      })();
      await eventually(async () => seen, (n) => n >= 2);
      await new Promise((resolve) => setTimeout(resolve, 600));
      messages.stop();
      expect(seen).toBe(2); // la tercera entrega nunca ocurre: el tope la corta
      const stranded = await manager.consumers.info(streamName('STR'), 'varado');
      expect(stranded.num_ack_pending).toBe(0);
      const warnings: Record<string, unknown>[] = [];
      await ensureUnlimitedDurable(manager, streamName('STR'), { durable_name: 'varado', ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: 'str.>' }, (fields) => warnings.push(fields));
      expect(warnings[0]).toMatchObject({ durable: 'varado', previous_max_deliver: 2, possibly_stranded: true, alert: true });
    });

    it('INVÁLIDO: un fallo que no es «no existe» (stream ausente) sube, no se oculta creando a ciegas', async () => {
      const manager = await nc.jetstreamManager();
      await expect(ensureUnlimitedDurable(manager, `NO_EXISTE_${suffix}`, base('x'))).rejects.toThrow(/stream not found/);
    });
  });

  describe('el consumidor real de pay-webhooks', () => {
    let h: WebhooksHarness;
    let down = true;
    let ingestCalls = 0;
    const callTimes: number[] = [];
    const publish = async (event: ReturnType<typeof cloudEvent>, msgId = event.id) => {
      const hdrs = natsHeaders();
      hdrs.set('Nats-Msg-Id', msgId);
      await nc.jetstream().publish(`${prefix}.${event.type}`, JSON.stringify(event), { headers: hdrs });
    };
    const deliveryRows = async (merchant: string) => Number((await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE merchant_id = $1', [merchant])).rows[0].n);
    const backlog = async () => {
      const info = await (await nc.jetstreamManager()).consumers.info(stream, `pay-webhooks-${stream.toLowerCase()}`);
      return { unprocessed: info.num_pending, inFlight: info.num_ack_pending, redelivered: info.num_redelivered };
    };

    beforeAll(async () => {
      await (await nc.jetstreamManager()).streams.add({ name: stream, subjects: [`${prefix}.>`], retention: RetentionPolicy.Limits, storage: StorageType.Memory, duplicate_window: 120_000_000_000 });
      // El durable ya existe con la configuración VIEJA (max_deliver 20) cuando arranca el servicio: la migración se prueba de punta a punta.
      await (await nc.jetstreamManager()).consumers.add(stream, {
        durable_name: `pay-webhooks-${stream.toLowerCase()}`,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subjects: [`${prefix}.payment_intent.succeeded`],
        max_deliver: 20,
      });
      h = await startWebhooks({ resolverTable: {}, env: { NATS_URL, WEBHOOKS_EVENT_SOURCES: `${stream}=${prefix}` } });
      await h.consumer.ready;
      h.consumer.redelivery = { baseMs: 5, capMs: 25 };
      // El destino del consumidor (el motor de entrega) está caído hasta que la prueba lo levante; todo lo demás es el servicio real.
      const original = h.ingest.ingest.bind(h.ingest);
      h.ingest.ingest = async (raw) => {
        ingestCalls += 1;
        callTimes.push(Date.now());
        if (down) throw new Error('motor de entrega caído');
        return original(raw);
      };
    });
    afterAll(async () => {
      await h.stop();
    });

    it('el durable viejo se migró al arrancar el servicio', async () => {
      const info = await (await nc.jetstreamManager()).consumers.info(stream, `pay-webhooks-${stream.toLowerCase()}`);
      expect(info.config).toMatchObject({ max_deliver: -1, ack_wait: ACK_WAIT_NS });
    });

    it('CORRECTO/LÍMITE: con el destino caído MÁS de 20 entregas (25) el evento no se abandona; al volver se entrega y el efecto ocurre UNA vez', async () => {
      const merchant = newMerchantId();
      const created = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url: `https://${HOST}/pay`, enabled_events: ['payment_intent.succeeded'] });
      expect(created.status).toBe(201);
      const event = cloudEvent('payment_intent.succeeded', merchant);
      ingestCalls = 0;
      callTimes.length = 0;
      await publish(event);

      await eventually(async () => ingestCalls, (n) => n >= 25); // 25 entregas fallidas: más allá del tope anterior (20)
      expect(await deliveryRows(merchant)).toBe(0); // nada se perdió ni se aplicó a medias
      // la espera entre entregas la pone el código (cap = 25 ms aquí): una reentrega en caliente (nak sin retardo) daría huecos de ~1 ms
      const gaps = callTimes.slice(14, 25).map((time, i) => time - callTimes[14 + i - 1]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15);
      down = false;
      await eventually(() => deliveryRows(merchant), (n) => n >= 1);
      await eventually(backlog, (s) => s.unprocessed === 0 && s.inFlight === 0);
      expect(ingestCalls).toBeGreaterThan(25);
      expect(await deliveryRows(merchant)).toBe(1);
      expect(h.consumer.maxDeliveryCountSeen).toBeGreaterThan(20);

      // la reentrega de lo ya aplicado (otro id de NATS, el mismo evento) no duplica el efecto: idempotencia del inbox
      await publish(event, `dup-${event.id}`);
      await publish(event, `dup2-${event.id}`);
      await eventually(backlog, (s) => s.unprocessed === 0 && s.inFlight === 0);
      expect(await deliveryRows(merchant)).toBe(1);
    });

    it('INVÁLIDO: lo que nunca se podrá procesar se descarta (term) y NO gira para siempre aunque no haya tope', async () => {
      down = false;
      const before = ingestCalls;
      await nc.jetstream().publish(`${prefix}.payment_intent.succeeded`, 'esto no es json');
      await eventually(backlog, (s) => s.unprocessed === 0 && s.inFlight === 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(ingestCalls).toBe(before); // ni siquiera llegó al motor
      const info = await (await nc.jetstreamManager()).consumers.info(stream, `pay-webhooks-${stream.toLowerCase()}`);
      expect(info.num_ack_pending).toBe(0);
    });
  });
});
