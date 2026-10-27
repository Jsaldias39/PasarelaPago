import { randomBytes } from 'node:crypto';
import { connect, headers as natsHeaders, RetentionPolicy, StorageType, type NatsConnection } from 'nats';
import { WebhookReceiver } from '../src/receiver/webhook-receiver';
import { cloudEvent } from './fixtures';
import { newKey, newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/**
 * P1.H3.M1 + M4 (flujo E6) contra un NATS JetStream REAL (stream, temas y consumidor propios de cada corrida) y Postgres real.
 * Lo simulado: el motor ([DOBLE de Svix]), el DNS, el reloj y el último salto de red. NO prueba Svix.
 *
 * E6: el endpoint del comercio está caído 10 minutos (500) y después responde 200; otro endpoint responde 410 y queda
 * deshabilitado. Todos los eventos llegan UNA vez cada uno al receptor sano.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const HOST_A = 'hooks.comercio.example';
const HOST_B = 'hooks-b.comercio.example';
const TYPES = ['payment_intent.created', 'payment_intent.succeeded', 'payment_intent.failed', 'refund.created', 'refund.succeeded', 'payout.paid'];

async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (accept(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`No se cumplió en ${timeoutMs} ms; último valor: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('[DOBLE de Svix] E6 — eventos por NATS real, endpoint caído, 410', () => {
  const suffix = randomBytes(4).toString('hex');
  const stream = `TEST_WH_${suffix}`;
  const prefix = `t${suffix}`;
  let nc: NatsConnection;
  let h: WebhooksHarness;
  const receivers: WebhookReceiver[] = [];

  const publish = async (event: ReturnType<typeof cloudEvent>, msgId = event.id) => {
    const hdrs = natsHeaders();
    hdrs.set('Nats-Msg-Id', msgId);
    await nc.jetstream().publish(`${prefix}.${event.type}`, JSON.stringify(event), { headers: hdrs });
  };
  const deliveryCount = async (merchant: string) => Number((await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE merchant_id = $1', [merchant])).rows[0].n);
  const consumerBacklog = async () => {
    const info = await (await nc.jetstreamManager()).consumers.info(stream, `pay-webhooks-${stream.toLowerCase()}`);
    return { unprocessed: info.num_pending, inFlight: info.num_ack_pending };
  };

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL, name: 'webhooks-e6-test' });
    await (await nc.jetstreamManager()).streams.add({ name: stream, subjects: [`${prefix}.>`], retention: RetentionPolicy.Limits, storage: StorageType.Memory, duplicate_window: 120_000_000_000 });
    h = await startWebhooks({
      resolverTable: { [HOST_B]: ['93.184.216.40'] },
      env: { NATS_URL, WEBHOOKS_EVENT_SOURCES: `${stream}=${prefix}`, WEBHOOKS_RETRY_SCHEDULE_MS: '0,5000,300000,1800000', WEBHOOKS_BATCH_SIZE: '50' },
    });
    await h.consumer.ready;
  });
  afterAll(async () => {
    await Promise.all(receivers.map((r) => r.close()));
    await h.stop();
    await (await nc.jetstreamManager()).streams.delete(stream).catch(() => undefined);
    await nc.drain();
  });

  it('E6: 12 eventos llegan UNA vez cada uno tras 3 fallos 500 en 10 min; el endpoint que da 410 se deshabilita sin reintentos', async () => {
    const merchant = newMerchantId();
    const outageEnd = h.clock.now().getTime() + 10 * 60_000;

    const create = async (host: string) => {
      const res = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url: `https://${host}/pay`, enabled_events: ['*'] });
      expect(res.status).toBe(201);
      return res.body as { id: string; secret: string };
    };
    const a = await create(HOST_A);
    const b = await create(HOST_B);

    const healthy = new WebhookReceiver({ secrets: [a.secret], now: () => Math.floor(h.clock.now().getTime() / 1000), override: () => (h.clock.now().getTime() < outageEnd ? 500 : undefined) });
    const gone = new WebhookReceiver({ secrets: [b.secret], override: () => 410 });
    receivers.push(healthy, gone);
    h.transport.route(HOST_A, await healthy.listen());
    h.transport.route(HOST_B, await gone.listen());
    h.transport.calls.length = 0;

    const events = Array.from({ length: 12 }, (_, i) => cloudEvent(TYPES[i % TYPES.length], merchant));
    for (const e of events) await publish(e);
    await eventually(() => deliveryCount(merchant), (n) => n === 24);

    const timeline: string[] = [];
    for (const step of [0, 5_000, 300_000, 1_800_000]) {
      h.clock.advance(step);
      const summary = await h.worker.runOnce();
      timeline.push(`t+${Math.round((h.clock.now().getTime() - (outageEnd - 10 * 60_000)) / 1000)}s ${JSON.stringify(summary)}`);
    }
    if (process.env.E6_LOG) process.stdout.write(`E6 línea de tiempo del trabajador:\n  ${timeline.join('\n  ')}\nE6 receptor sano (webhook-id, estado, resultado):\n${healthy.log.map((l) => `  ${l.webhookId} ${l.status} ${l.outcome}`).join('\n')}\nE6 receptor 410:\n${gone.log.map((l) => `  ${l.webhookId} ${l.status} ${l.outcome}`).join('\n')}\n`);

    // todos llegan, una vez cada uno
    expect(healthy.accepted.map((e) => e.webhookId).sort()).toEqual(events.map((e) => e.id).sort());
    expect(new Set(healthy.accepted.map((e) => e.webhookId)).size).toBe(12);
    // …tras 3 fallos y 1 éxito por evento
    for (const e of events) expect(healthy.log.filter((l) => l.webhookId === e.id).map((l) => l.status)).toEqual([500, 500, 500, 200]);
    expect(healthy.log.filter((l) => l.outcome === 'duplicate')).toHaveLength(0);

    // el 410: una sola petición en total y el endpoint queda deshabilitado
    expect(gone.log).toHaveLength(1);
    const listed = (await h.as(merchant).get('/webhook_endpoints')).body.data as { id: string; status: string; disabled_reason: string | null }[];
    expect(listed.find((e) => e.id === b.id)).toMatchObject({ status: 'disabled', disabled_reason: 'gone_410' });
    expect(listed.find((e) => e.id === a.id)).toMatchObject({ status: 'enabled', disabled_reason: null });

    const states = await h.db.pool.query('SELECT endpoint_id, status, count(*)::int AS n FROM webhook_deliveries WHERE merchant_id = $1 GROUP BY 1, 2 ORDER BY 1, 2', [merchant]);
    expect(states.rows.map((r) => `${r.endpoint_id === a.id ? 'A' : 'B'}:${r.status}:${r.n}`).sort()).toEqual(['A:succeeded:12', 'B:dead:12']);
    expect(await consumerBacklog()).toEqual({ unprocessed: 0, inFlight: 0 });
  });

  it('un evento publicado dos veces (ids de NATS distintos) genera UNA entrega por endpoint', async () => {
    const merchant = newMerchantId();
    const res = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url: `https://${HOST_A}/dup`, enabled_events: ['payment_intent.succeeded'] });
    const receiver = new WebhookReceiver({ secrets: [res.body.secret], now: () => Math.floor(h.clock.now().getTime() / 1000) });
    receivers.push(receiver);
    h.transport.route(HOST_A, await receiver.listen());

    const event = cloudEvent('payment_intent.succeeded', merchant);
    await publish(event, `a-${event.id}`);
    await publish(event, `b-${event.id}`);
    await publish(event, `c-${event.id}`);
    await eventually(() => consumerBacklog(), (s) => s.unprocessed === 0 && s.inFlight === 0);
    await eventually(() => deliveryCount(merchant), (n) => n >= 1);
    expect(await deliveryCount(merchant)).toBe(1);
    await h.worker.runOnce();
    expect(receiver.accepted).toHaveLength(1);
    expect(receiver.log).toHaveLength(1);
  });

  describe('eventos que no se pueden entregar: se descartan (term), no se reintentan y no frenan al resto', () => {
    it.each([
      ['no es JSON', async () => void (await nc.jetstream().publish(`${prefix}.payment_intent.succeeded`, 'esto no es json'))],
      ['sobre inválido', async () => publish(cloudEvent('payment_intent.succeeded', newMerchantId(), {}, { specversion: '0.3' }))],
      ['datos personales (correo) en el payload', async () => publish(cloudEvent('refund.created', newMerchantId(), { refund_id: 'rf_abcdefghij12', reason: 'maria@correo.com' }))],
      ['tarjeta en un id', async () => publish(cloudEvent('payment_intent.created', newMerchantId(), { payment_intent_id: 'pi_4111111111111111' }))],
    ])('%s', async (_name, send) => {
      const before = h.ingest.metrics.rejectedMalformed + h.ingest.metrics.rejectedPolicy;
      await send();
      const merchant = newMerchantId();
      const ok = cloudEvent('payment_intent.succeeded', merchant);
      await publish(ok);
      await eventually(() => consumerBacklog(), (s) => s.unprocessed === 0 && s.inFlight === 0);
      const inbox = await h.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [ok.id]);
      expect(inbox.rows[0].n).toBe(1); // el evento bueno que vino DESPUÉS se procesó
      if (_name !== 'no es JSON') expect(h.ingest.metrics.rejectedMalformed + h.ingest.metrics.rejectedPolicy).toBe(before + 1);
    });
  });
});
