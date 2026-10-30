import { randomBytes } from 'node:crypto';
import { connect, headers as natsHeaders, RetentionPolicy, StorageType, type NatsConnection } from 'nats';
import { cloudEvent } from '../fixtures';
import { newMerchantId } from '../harness';
import { eventually } from './svix-env';
import { startSvixHarness, type SvixHarness } from './svix-harness';

/**
 * P1.H3.M1 + M4 (flujo E6) contra svix-server REAL, NATS JetStream REAL y Postgres real: los eventos llegan por el consumidor del servicio, Svix
 * firma, reintenta y entrega a receptores HTTPS reales. El reconciliador corre SOLO, por su temporizador (WEBHOOKS_WORKER_ENABLED=true).
 *
 * E6: un endpoint del comercio falla dos veces (500) por evento y después responde 200; otro responde 410 y queda deshabilitado. Todos los
 * eventos llegan UNA vez cada uno al receptor sano. (La escalera de Svix es la de prueba, 1, 2 y 3 s, no los «10 minutos» del plan: el
 * comportamiento —varios 500 y luego 200— es el mismo; los 10 minutos reales no se ejecutaron.)
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';
const TYPES = ['payment_intent.created', 'payment_intent.succeeded', 'payment_intent.failed', 'refund.created', 'refund.succeeded', 'payout.paid'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('E6 contra svix-server REAL — eventos por NATS real, endpoint con 500 y luego 200, otro con 410', () => {
  const suffix = randomBytes(4).toString('hex');
  const stream = `TEST_SVIX_${suffix}`;
  const prefix = `s${suffix}`;
  let nc: NatsConnection;
  let s: SvixHarness;

  const publish = async (event: ReturnType<typeof cloudEvent>, msgId = event.id) => {
    const hdrs = natsHeaders();
    hdrs.set('Nats-Msg-Id', msgId);
    await nc.jetstream().publish(`${prefix}.${event.type}`, JSON.stringify(event), { headers: hdrs });
  };
  const backlog = async () => {
    const info = await (await nc.jetstreamManager()).consumers.info(stream, `pay-webhooks-${stream.toLowerCase()}`);
    return { unprocessed: info.num_pending, inFlight: info.num_ack_pending };
  };

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL, name: 'webhooks-svix-e6-test' });
    await (await nc.jetstreamManager()).streams.add({ name: stream, subjects: [`${prefix}.>`], retention: RetentionPolicy.Limits, storage: StorageType.Memory, duplicate_window: 120_000_000_000 });
    s = await startSvixHarness({ env: { NATS_URL, WEBHOOKS_EVENT_SOURCES: `${stream}=${prefix}`, WEBHOOKS_WORKER_ENABLED: 'true', WEBHOOKS_SVIX_RECONCILE_INTERVAL_MS: '250' } });
    await s.h.consumer.ready;
  });
  afterAll(async () => {
    await s.stop();
    await (await nc.jetstreamManager()).streams.delete(stream).catch(() => undefined);
    await nc.drain();
  });

  it('12 eventos (3 publicados DOS veces en NATS) ⇒ UN mensaje de Svix y UNA entrega aceptada por evento; el 410 se deshabilita solo y no recibe más', async () => {
    const merchant = newMerchantId();
    const healthy = await s.receiver(({ seen }) => (seen < 2 ? 500 : undefined));
    const gone = await s.receiver(() => 410);
    const a = await s.createEndpoint(merchant, healthy, { enabled_events: ['*'] });
    const b = await s.createEndpoint(merchant, gone, { enabled_events: ['*'] });

    const events = Array.from({ length: 12 }, (_, i) => cloudEvent(TYPES[i % TYPES.length], merchant));
    for (const e of events) await publish(e);
    for (const e of events.slice(0, 3)) await publish(e, `otro-id-de-nats-${e.id}`); // el mismo evento otra vez, con otro id de NATS
    await eventually(() => backlog(), (x) => x.unprocessed === 0 && x.inFlight === 0);

    // Svix: UN mensaje por evento (no 15)
    expect((await s.messages(merchant)).sort()).toEqual(events.map((e) => e.id).sort());

    // el receptor sano: 12 aceptados, una vez cada uno, tras 500, 500 y 200
    await eventually(async () => healthy.receiver.accepted.length, (n) => n === 12, 30_000);
    const accepted = healthy.receiver.accepted.map((e) => (JSON.parse(e.body) as { id: string }).id).sort();
    expect(accepted).toEqual(events.map((e) => e.id).sort());
    expect(new Set(healthy.receiver.accepted.map((e) => e.webhookId)).size).toBe(12);
    for (const e of healthy.receiver.accepted) expect(healthy.receiver.log.filter((l) => l.webhookId === e.webhookId).map((l) => l.status)).toEqual([500, 500, 200]);
    expect(healthy.receiver.log.filter((l) => l.outcome === 'duplicate')).toHaveLength(0);
    expect(healthy.receiver.log.filter((l) => l.status === 200)).toHaveLength(12);

    // el 410: lo deshabilita el reconciliador por su cuenta (API pública, tabla y Svix) y deja de recibir
    const endpoints = await eventually(
      async () => (await s.h.as(merchant).get('/webhook_endpoints')).body.data as { id: string; status: string; disabled_reason: string | null }[],
      (list) => list.find((e) => e.id === b.id)?.status === 'disabled',
      20_000,
    );
    expect(endpoints.find((e) => e.id === b.id)).toMatchObject({ status: 'disabled', disabled_reason: 'gone_410' });
    expect(endpoints.find((e) => e.id === a.id)).toMatchObject({ status: 'enabled', disabled_reason: null });
    expect((await s.client.listEndpoints(merchant))?.find((e) => e.uid === b.id)?.disabled).toBe(true);
    expect(gone.requests.length).toBeGreaterThanOrEqual(1);
    await sleep(1_000);
    const settled = gone.requests.length;
    await sleep(4_500);
    expect(gone.requests).toHaveLength(settled);
    expect(await backlog()).toEqual({ unprocessed: 0, inFlight: 0 });
    if (process.env.E6_LOG) {
      const lines = (r: typeof healthy) => r.receiver.log.map((l) => `  ${l.webhookId} ${l.status} ${l.outcome}`).join('\n');
      process.stdout.write(`E6/Svix receptor sano (webhook-id, estado, resultado):\n${lines(healthy)}\nE6/Svix receptor 410:\n${lines(gone)}\nE6/Svix mensajes en Svix: ${(await s.messages(merchant)).length} para 15 publicaciones en NATS (12 eventos distintos)\n`);
    }
  }, 90_000);
});
