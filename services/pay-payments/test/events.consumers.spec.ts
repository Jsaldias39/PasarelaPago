import { randomBytes, randomUUID } from 'node:crypto';
import { connect, type NatsConnection } from 'nats';
import { NatsEventPublisher, newCloudEvent, type CloudEvent } from '@pay/outbox';
import { join } from 'node:path';
import { EventHandlers } from '../src/events/handlers';
import { NatsConsumers } from '../src/events/nats-consumers';
import type { PaymentOrchestrator } from '../src/payments/orchestrator';
import { replicasRepo } from '../src/persistence/replicas.repo';
import { intentsRepo } from '../src/persistence/intents.repo';
import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { key, MC, seedMerchant, startDirectIntent, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

let stack: Stack;
let nats: NatsConnection;
let publisher: NatsEventPublisher;
let consumers: NatsConsumers;
let connectorValidators: Map<string, EventValidator>;
let merchantValidators: Map<string, EventValidator>;
let flaky: { failNextSignals: number; signalCalls: number };

const prefix = `p3t${randomBytes(4).toString('hex')}`;
const subjects = { connectorStatus: `${prefix}.connector.transaction.status_changed`, merchantEvents: `${prefix}.merchant.*`, feeSchedule: `${prefix}.fee_schedule.published` };
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
const NEW_MC = 'mc_consumer00001';

beforeAll(async () => {
  stack = await startStack();
  connectorValidators = await loadEventValidators(join(process.cwd(), '../../contracts/asyncapi/connectors.yaml'));
  merchantValidators = await loadEventValidators(join(process.cwd(), '../../contracts/asyncapi/merchants-schedules.yaml'));
  await seedMerchant(stack, MC);
  nats = await connect({ servers: process.env.NATS_URL ?? 'nats://127.0.0.1:54222' });
  publisher = new NatsEventPublisher(nats);
  // Orquestador envuelto: permite hacer fallar la señal N veces para probar la reentrega de JetStream.
  flaky = { failNextSignals: 0, signalCalls: 0 };
  const wrapped: PaymentOrchestrator = new Proxy(stack.orchestrator, {
    get(target, property, receiver) {
      if (property === 'signalCharge') {
        return async (...args: Parameters<PaymentOrchestrator['signalCharge']>) => {
          flaky.signalCalls += 1;
          if (flaky.failNextSignals > 0) {
            flaky.failNextSignals -= 1;
            throw new Error('Temporal no responde');
          }
          return target.signalCharge(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  consumers = new NatsConsumers();
  await consumers.start(process.env.NATS_URL ?? 'nats://127.0.0.1:54222', NatsConsumers.specs(new EventHandlers(stack.deps, wrapped), subjects, prefix));
});
afterAll(async () => {
  await consumers.stop();
  const manager = await nats.jetstreamManager();
  await manager.streams.delete(prefix.toUpperCase()).catch(() => undefined);
  await nats.drain();
  await stack.stop();
});

const merchantEvent = (type: string, merchantId: string, time: Date, id: string = randomUUID()): CloudEvent => {
  const iso = time.toISOString();
  const data: Record<string, unknown> =
    type === 'merchant.created' ? { merchant_id: merchantId, status: 'pending', created_at: iso }
    : type === 'merchant.activated' ? { merchant_id: merchantId, status: 'active', activated_at: iso }
    : type === 'merchant.suspended' ? { merchant_id: merchantId, status: 'suspended', suspended_at: iso, reason: 'risk_review' }
    : { merchant_id: merchantId, status: 'closed', closed_at: iso };
  return newCloudEvent({ id, source: '/pay-merchants', type, subject: merchantId, merchantId, time, data });
};
const publish = (subject: string, event: CloudEvent) => publisher.publish(subject, event);
const replicaStatus = () => replicasRepo.merchantStatus(stack.deps.pool, NEW_MC);

const connectorEvent = (intentId: string, status: string, extra: Record<string, unknown> = {}, id: string = randomUUID()): CloudEvent =>
  newCloudEvent({
    id, source: '/pay-connectors', type: 'connector.transaction.status_changed', subject: 'ct_aaaaaaaaaaaa', merchantId: MC,
    data: { connector_transaction_id: 'ct_aaaaaaaaaaaa', connector: 'simulator', kind: 'charge', payment_intent_id: intentId, merchant_id: MC, status, amount_minor: 10000, currency: 'BOB', provider_event_id: randomUUID(), provider_occurred_at: new Date().toISOString(), observed_via: 'callback', ...extra },
  });

describe('réplica del comercio: merchant.* (P3.H1.M5)', () => {
  it('los eventos del contrato llevan al comercio de pending a active a suspended a closed, y los eventos que se mandan cumplen el AsyncAPI', async () => {
    const t0 = Date.now() - 10_000;
    const steps: [string, string][] = [['merchant.created', 'pending'], ['merchant.activated', 'active'], ['merchant.suspended', 'suspended'], ['merchant.closed', 'closed']];
    for (const [i, [type, expected]] of steps.entries()) {
      const event = merchantEvent(type, NEW_MC, new Date(t0 + i * 1000));
      expect(merchantValidators.get(type)?.(event)).toEqual([]);
      await publish(`${prefix}.${type}`, event);
      await waitFor(async () => ((await replicaStatus()) === expected ? true : undefined), 10_000, `${type} → ${expected}`);
    }
  });

  it('un evento atrasado (más viejo) NO pisa a uno más nuevo; y la entrega repetida se procesa una sola vez', async () => {
    const id = 'mc_consumer00002';
    const now = Date.now();
    const suspended = merchantEvent('merchant.suspended', id, new Date(now));
    await publish(`${prefix}.merchant.suspended`, suspended);
    await publish(`${prefix}.merchant.suspended`, { ...suspended, id: suspended.id }); // mismo id: JetStream lo deduplica o el inbox lo descarta
    await waitFor(async () => ((await replicasRepo.merchantStatus(stack.deps.pool, id)) === 'suspended' ? true : undefined), 10_000, 'suspendido');
    expect(await stack.db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [suspended.id]).then((r) => r.rows[0].n)).toBe(1);
    await publish(`${prefix}.merchant.activated`, merchantEvent('merchant.activated', id, new Date(now - 60_000)));
    await new Promise((r) => setTimeout(r, 800));
    expect(await replicasRepo.merchantStatus(stack.deps.pool, id)).toBe('suspended');
  });

  it('un suspendido deja de poder cobrar (REQ-P3-8 de punta a punta: evento → réplica → 403)', async () => {
    const id = 'mc_consumer00003';
    await seedMerchant(stack, id);
    expect((await stack.service.createIntent(id, key(), QR)).status).toBe(201);
    await publish(`${prefix}.merchant.suspended`, merchantEvent('merchant.suspended', id, new Date()));
    await waitFor(async () => ((await replicasRepo.merchantStatus(stack.deps.pool, id)) === 'suspended' ? true : undefined), 10_000, 'suspendido');
    const blocked = await stack.service.createIntent(id, key(), QR);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'merchant_suspended' });
  });
});

describe('réplica de la tarifa: fee_schedule.published', () => {
  const schedule = (merchantId: string, version: number, percent: string, from: Date, id = randomUUID()): CloudEvent =>
    newCloudEvent({ id, source: '/pay-merchants', type: 'fee_schedule.published', subject: merchantId, merchantId, data: { merchant_id: merchantId, version, currency: 'BOB', effective_from: from.toISOString(), effective_to: null, channels: [{ channel: 'qr', percent, fixed_minor: 0 }], monthly_fee_minor: 0 } });

  it('la tarifa publicada se usa en la cotización del cobro siguiente', async () => {
    const id = 'mc_consumer00004';
    await publish(`${prefix}.merchant.activated`, merchantEvent('merchant.activated', id, new Date()));
    const event = schedule(id, 1, '4', new Date(Date.now() - 5000));
    expect(merchantValidators.get('fee_schedule.published')?.(event)).toEqual([]);
    await publish(`${prefix}.fee_schedule.published`, event);
    await waitFor(async () => (await replicasRepo.effectiveFeeSchedule(stack.deps.pool, id, new Date())) ?? undefined, 10_000, 'tarifa replicada');
    await waitFor(async () => ((await replicasRepo.merchantStatus(stack.deps.pool, id)) === 'active' ? true : undefined), 10_000, 'activo');
    const intent = await stack.service.createIntent(id, key(), QR);
    expect(intent.body).toMatchObject({ fee_minor: 400, net_minor: 9600 });
  });

  it('una versión nueva reemplaza a la vieja; reentregar la misma no duplica filas', async () => {
    const id = 'mc_consumer00005';
    const v1 = schedule(id, 1, '2', new Date(Date.now() - 9000));
    await publish(`${prefix}.fee_schedule.published`, v1);
    await publish(`${prefix}.fee_schedule.published`, schedule(id, 2, '1', new Date(Date.now() - 1000)));
    await publish(`${prefix}.fee_schedule.published`, schedule(id, 1, '2', new Date(Date.now() - 9000))); // reentrega con otro id de evento
    await waitFor(async () => ((await replicasRepo.effectiveFeeSchedule(stack.deps.pool, id, new Date()))?.version === 2 ? true : undefined), 10_000, 'versión 2');
    await new Promise((r) => setTimeout(r, 600));
    const rows = await stack.db.pool.query('SELECT count(*)::int AS n FROM fee_schedule_replica WHERE merchant_id = $1', [id]);
    expect(rows.rows[0].n).toBe(2);
  });

  it('un evento mal formado se descarta (term) sin reintentar en bucle y sin dejar nada a medias', async () => {
    const id = 'mc_consumer00006';
    const bad = newCloudEvent({ source: '/pay-merchants', type: 'fee_schedule.published', subject: id, merchantId: id, data: { merchant_id: id, version: 'tres', currency: 'BOB', channels: [] } });
    await publish(`${prefix}.fee_schedule.published`, bad);
    await new Promise((r) => setTimeout(r, 1500));
    const rows = await stack.db.pool.query('SELECT count(*)::int AS n FROM fee_schedule_replica WHERE merchant_id = $1', [id]);
    expect(rows.rows[0].n).toBe(0);
    expect(await stack.db.pool.query('SELECT 1 FROM inbox_events WHERE event_id = $1', [bad.id]).then((r) => r.rows.length)).toBe(0);
  });
});

describe('connector.transaction.status_changed (P3.H2.M3 / M4)', () => {
  it('callback duplicado 3 veces + reordenado (authorized tarde): un solo asiento y un solo succeeded', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    const captured = connectorEvent(id, 'captured');
    expect(connectorValidators.get('connector.transaction.status_changed')?.(captured)).toEqual([]);
    await publish(subjects.connectorStatus, captured);
    await publish(subjects.connectorStatus, connectorEvent(id, 'captured')); // otro id de evento, mismo hecho
    await publish(subjects.connectorStatus, connectorEvent(id, 'captured'));
    await publish(subjects.connectorStatus, connectorEvent(id, 'authorized'));
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
    await new Promise((r) => setTimeout(r, 1000));
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    const succeeded = await stack.db.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND type = 'payment_intent.succeeded'", [id]);
    expect(succeeded.rows[0].n).toBe(1);
  });

  it('el mismo evento (mismo id) entregado dos veces: el inbox lo procesa una vez', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    const event = connectorEvent(id, 'captured');
    const calls = flaky.signalCalls;
    // Se publica directo dos veces con `Nats-Msg-Id` distinto para saltar la deduplicación del stream y forzar la reentrega.
    const js = nats.jetstream();
    for (const msgID of ['a', 'b']) await js.publish(subjects.connectorStatus, new TextEncoder().encode(JSON.stringify(event)), { msgID: `${event.id}-${msgID}` });
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded');
    await new Promise((r) => setTimeout(r, 800));
    expect(flaky.signalCalls - calls).toBe(1);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
  });

  it('si el efecto falla (Temporal no responde) el evento se REENTREGA y no se pierde; al final el efecto ocurre una vez', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    flaky.failNextSignals = 2;
    const event = connectorEvent(id, 'captured');
    await publish(subjects.connectorStatus, event);
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 30_000, 'succeeded tras reentregas');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    await waitFor(async () => ((await stack.db.pool.query('SELECT 1 FROM inbox_events WHERE event_id = $1', [event.id])).rows.length === 1 ? true : undefined), 10_000, 'inbox registrado tras el commit');
  });

  it('dinero cobrado para un intento ya vencido: CONTRADICCIÓN registrada, el estado no se pisa y no hay asiento', async () => {
    const id = await startDirectIntent(stack, { id: `pi_cons${String(Date.now()).slice(-8)}01`, expiresInMs: 2000 });
    await waitFor(async () => ((await statusOf(stack, id)) === 'expired' ? true : undefined), 20_000, 'expired');
    await publish(subjects.connectorStatus, connectorEvent(id, 'captured'));
    await waitFor(async () => (Number((await stack.db.pool.query('SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1', [id])).rows[0].n) > 0 ? true : undefined), 15_000, 'contradicción registrada');
    expect(await statusOf(stack, id)).toBe('expired');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    const row = await stack.db.pool.query('SELECT kind, reason FROM intent_contradictions WHERE payment_intent_id = $1', [id]);
    expect(row.rows[0]).toEqual({ kind: 'status_conflict', reason: 'captured_for_expired_intent' });
  });

  it('un evento de un cobro que este servicio no conoce se ignora (ack) y no bloquea la cola', async () => {
    await publish(subjects.connectorStatus, connectorEvent('pi_desconocido0001', 'captured'));
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    await publish(subjects.connectorStatus, connectorEvent(id, 'captured'));
    await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'succeeded detrás del desconocido');
  });

  it('un fallo del banco cierra el cobro como failed con su código y sin asiento', async () => {
    const id = (await stack.service.createIntent(MC, key(), QR)).body.id as string;
    await publish(subjects.connectorStatus, connectorEvent(id, 'failed', { failure_code: 'insufficient_funds' }));
    await waitFor(async () => ((await statusOf(stack, id)) === 'failed' ? true : undefined), 20_000, 'failed');
    expect((await intentsRepo.byId(stack.deps.pool, id))?.failureCode).toBe('insufficient_funds');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
  });
});
