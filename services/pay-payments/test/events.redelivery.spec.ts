import { randomBytes, randomUUID } from 'node:crypto';
import { AckPolicy, connect, DeliverPolicy, headers as natsHeaders, type NatsConnection } from 'nats';
import { NatsEventPublisher, newCloudEvent, type CloudEvent } from '@pay/outbox';
import { ACK_WAIT_NS, DEFAULT_REDELIVERY, ensureUnlimitedDurable, redeliveryDelayMs, retryLogFields, STUCK_ALERT_DELIVERIES } from '../src/events/consumer-redelivery';
import { EventHandlers } from '../src/events/handlers';
import { NatsConsumers } from '../src/events/nats-consumers';
import { replicasRepo } from '../src/persistence/replicas.repo';
import { startStack, waitFor, type Stack } from './helpers/stack';

/**
 * RE-REVISION-DINERO F-B2 contra un NATS JetStream REAL (2.10) y Postgres real: los consumidores durables de pay-payments ya no abandonan un evento a las
 * 20 entregas. Lo simulado: el destino caído (el handler del comercio falla N veces y luego responde); la base, NATS y el inbox son reales.
 */
const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:54222';
const prefix = `p3r${randomBytes(4).toString('hex')}`;
const subjects = { connectorStatus: `${prefix}.connector.transaction.status_changed`, merchantEvents: `${prefix}.merchant.*`, feeSchedule: `${prefix}.fee_schedule.published` };
const MERCHANT = 'mc_redeliver0001';

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

describe('F-B2 · consumidores durables de pay-payments sin tope de entregas (NATS JetStream real)', () => {
  let stack: Stack;
  let nats: NatsConnection;
  let publisher: NatsEventPublisher;
  let consumers: NatsConsumers;
  const flaky = { failMerchant: 0, merchantCalls: 0, statusWhileDown: [] as (string | null)[] };
  const durable = (name: string) => `${prefix}-${name}`;
  const stream = prefix.toUpperCase();
  const info = async (name: string) => (await nats.jetstreamManager()).consumers.info(stream, durable(name));

  beforeAll(async () => {
    stack = await startStack();
    nats = await connect({ servers: NATS_URL, name: 'payments-redelivery-test' });
    publisher = new NatsEventPublisher(nats);
    const manager = await nats.jetstreamManager();
    await manager.streams.add({ name: stream, subjects: [`${prefix}.>`], duplicate_window: 120_000_000_000 });
    // Los durables ya existen con la configuración VIEJA (max_deliver 20) cuando arranca el servicio: la migración se prueba de punta a punta.
    await manager.consumers.add(stream, { durable_name: durable('merchant'), filter_subject: subjects.merchantEvents, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: ACK_WAIT_NS, max_deliver: 20 });

    const handlers = new EventHandlers(stack.deps, stack.orchestrator);
    const original = handlers.merchantChanged.bind(handlers);
    handlers.merchantChanged = async (event) => {
      flaky.merchantCalls += 1;
      if (flaky.failMerchant > 0) {
        flaky.failMerchant -= 1;
        flaky.statusWhileDown.push(await replicasRepo.merchantStatus(stack.deps.pool, MERCHANT));
        throw new Error('base del comercio no responde');
      }
      return original(event);
    };
    consumers = new NatsConsumers();
    consumers.redelivery = { baseMs: 5, capMs: 25 };
    await consumers.start(NATS_URL, NatsConsumers.specs(handlers, subjects, prefix));
  });
  afterAll(async () => {
    await consumers.stop();
    await (await nats.jetstreamManager()).streams.delete(stream).catch(() => undefined);
    await nats.drain();
    await stack.stop();
  });

  const merchantActivated = (merchantId: string, id: string = randomUUID()): CloudEvent =>
    newCloudEvent({ id, source: '/pay-merchants', type: 'merchant.activated', subject: merchantId, merchantId, data: { merchant_id: merchantId, status: 'active', activated_at: new Date().toISOString() } });
  const backlog = async () => {
    const i = await info('merchant');
    return { unprocessed: i.num_pending, inFlight: i.num_ack_pending };
  };

  it('el durable viejo se migró al arrancar el servicio; los que no existían se crearon sin tope', async () => {
    for (const name of ['merchant', 'connector-status', 'fee-schedule']) expect((await info(name)).config).toMatchObject({ max_deliver: -1, ack_wait: ACK_WAIT_NS });
  });

  it('CORRECTO/LÍMITE: con el destino caído MÁS de 20 entregas (25) el evento no se abandona; al volver el efecto ocurre UNA vez, y repetirlo no lo duplica', async () => {
    const event = merchantActivated(MERCHANT);
    flaky.failMerchant = 25;
    flaky.merchantCalls = 0;
    await publisher.publish(`${prefix}.merchant.activated`, event);

    await waitFor(async () => (flaky.merchantCalls >= 25 ? true : undefined), 20_000, '25 entregas fallidas (más allá del tope anterior)');
    await waitFor(async () => ((await replicasRepo.merchantStatus(stack.deps.pool, MERCHANT)) === 'active' ? true : undefined), 20_000, 'comercio activo tras la caída');
    await waitFor(async () => ((await backlog()).unprocessed === 0 && (await backlog()).inFlight === 0 ? true : undefined), 10_000, 'cola vacía');
    expect(flaky.merchantCalls).toBeGreaterThan(25);
    expect(flaky.statusWhileDown).toHaveLength(25);
    expect(flaky.statusWhileDown.every((status) => status === null)).toBe(true); // mientras estuvo caído no se aplicó nada a medias
    expect((await stack.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id])).rows[0].n).toBe(1);

    // la reentrega de lo ya aplicado (otro id de NATS, el mismo evento) no duplica el efecto: idempotencia del inbox
    const hdrs = natsHeaders();
    hdrs.set('Nats-Msg-Id', `otra-${event.id}`);
    await nats.jetstream().publish(`${prefix}.merchant.activated`, JSON.stringify(event), { headers: hdrs });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await waitFor(async () => ((await backlog()).unprocessed === 0 && (await backlog()).inFlight === 0 ? true : undefined), 10_000, 'cola vacía');
    expect((await stack.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id])).rows[0].n).toBe(1);
  });

  it('INVÁLIDO: un durable viejo con eventos ya varados por el tope se avisa (alert) al migrar', async () => {
    const manager = await nats.jetstreamManager();
    const name = durable('varado');
    await manager.consumers.add(stream, { durable_name: name, filter_subject: `${prefix}.nunca.>`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, ack_wait: 500_000_000, max_deliver: 2 });
    await nats.jetstream().publish(`${prefix}.nunca.uno`, 'x');
    const messages = await (await nats.jetstream().consumers.get(stream, name)).consume({ max_messages: 5 });
    let seen = 0;
    void (async () => {
      for await (const m of messages) {
        seen += 1;
        m.nak(50);
      }
    })();
    await waitFor(async () => (seen >= 2 ? true : undefined), 5_000, 'dos entregas');
    await new Promise((resolve) => setTimeout(resolve, 600));
    messages.stop();
    expect(seen).toBe(2);
    const warnings: Record<string, unknown>[] = [];
    await ensureUnlimitedDurable(manager, stream, { durable_name: name, filter_subject: `${prefix}.nunca.>`, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All }, (fields) => warnings.push(fields));
    expect(warnings[0]).toMatchObject({ durable: name, previous_max_deliver: 2, possibly_stranded: true, alert: true });
  });
});
