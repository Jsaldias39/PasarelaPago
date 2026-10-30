import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AckPolicy, connect, DeliverPolicy, type NatsConnection } from 'nats';
import { NatsEventPublisher, ensureStream, newCloudEvent } from '@pay/outbox';
import { type IsolatedDatabase, createIsolatedDatabase } from '@pay/testing';
import { loadConfig, SERVICE_CONFIG } from '../src/config';
import { PG_POOL } from '../src/database.module';
import { ACK_WAIT_NS } from '../src/consumer-redelivery';
import { EventsModule } from '../src/events.module';
import { SettlementConsumers } from '../src/settlement/consumers';
import { emitPayoutPaid } from '../src/settlement/settlement-events';
import { loadEventValidators } from './helpers/events-contract';
import { feeSchedule, transferPosted } from './helpers/scenarios';
import { merchantId, repoPath } from './helpers/app';
import { waitFor } from './helpers/wait';

/**
 * NATS JetStream REAL (compose local, puerto 54222). Prueba el cableado que los dobles no pueden probar: que los consumidores durables
 * reciben los eventos de otros servicios, que un duplicado y un mensaje inservible no rompen nada, y que el relé del outbox publica
 * los eventos propios en el stream PAY_SETTLEMENT con el contrato.
 */
const NATS_URL = process.env.PAY_TEST_NATS_URL ?? 'nats://127.0.0.1:54222';

let db: IsolatedDatabase;
let app: INestApplication;
let nc: NatsConnection;
let validators: Awaited<ReturnType<typeof loadEventValidators>>;

@Global()
@Module({
  providers: [
    { provide: SERVICE_CONFIG, useFactory: () => ({ ...loadConfig({ DB_HOST: 'x', DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x' }), natsUrl: NATS_URL }) },
    { provide: PG_POOL, useFactory: () => db.pool },
  ],
  exports: [SERVICE_CONFIG, PG_POOL],
})
class TestInfrastructure {}

beforeAll(async () => {
  validators = await loadEventValidators('ledger-settlement.yaml');
  db = await createIsolatedDatabase([
    repoPath('services/pay-settlement/sql/ddl.sql'), // vendorizado del modelo (D-18): trae también las tablas de outbox, inbox e idempotencia
  ]);
  nc = await connect({ servers: NATS_URL, name: 'pay-settlement-test' });
  const moduleRef = await Test.createTestingModule({ imports: [TestInfrastructure, EventsModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});
afterAll(async () => {
  await app.close();
  await nc.drain();
  await db.drop();
});

const publisher = () => new NatsEventPublisher(nc);
const merchantRow = async (m: string) => (await db.pool.query('SELECT merchant_id FROM settlement_merchants WHERE merchant_id = $1', [m])).rows;

describe('consumidores durables sobre NATS JetStream real', () => {
  it('ledger.transfer.posted de pay-ledger registra al comercio; fee_schedule.published de pay-merchants guarda el abono', async () => {
    const [a, b] = [merchantId(), merchantId()];
    await publisher().publish('pay-ledger.ledger.transfer.posted', transferPosted(a));
    await publisher().publish('pay-merchants.fee_schedule.published', feeSchedule(b, 1, 1500));
    await waitFor(async () => (await merchantRow(a)).length > 0, 30_000, 100);
    const plan = await waitFor(async () => (await db.pool.query('SELECT version, monthly_fee_minor FROM settlement_fee_plans WHERE merchant_id = $1', [b])).rows[0], 30_000, 100);
    expect(plan).toEqual({ version: 1, monthly_fee_minor: '1500' });
    expect((await merchantRow(b)).length).toBe(1);
  });

  it('un mensaje duplicado (mismo id, entregado dos veces) tiene efecto una sola vez', async () => {
    const m = merchantId();
    const event = transferPosted(m);
    // dos publicaciones SIN Nats-Msg-Id para que JetStream no las deduplique: es la entrega «al menos una vez» en acción
    const js = nc.jetstream();
    const body = new TextEncoder().encode(JSON.stringify(event));
    await js.publish('pay-ledger.ledger.transfer.posted', body);
    await js.publish('pay-ledger.ledger.transfer.posted', body);
    await waitFor(async () => (await merchantRow(m)).length > 0, 30_000, 100);
    await waitFor(async () => {
      const info = await nc.jetstreamManager().then((jsm) => jsm.consumers.info('PAY_LEDGER', 'pay-settlement_ledger-transfer-posted'));
      return info.num_pending === 0 && info.num_ack_pending === 0;
    }, 30_000, 100);
    const inbox = await db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id]);
    expect(inbox.rows[0].n).toBe(1);
    expect(await merchantRow(m)).toHaveLength(1);
  });

  it('payment_intent.contradiction_detected de pay-payments (stream PAY_PAYMENTS) abre una excepción; entregado dos veces, una sola', async () => {
    const paymentIntent = `pi_${Math.random().toString(36).slice(2, 14).padEnd(12, 'n')}`;
    const merchant = merchantId();
    const event = newCloudEvent({
      source: '/pay-payments',
      type: 'payment_intent.contradiction_detected',
      subject: paymentIntent,
      merchantId: merchant,
      data: { payment_intent_id: paymentIntent, merchant_id: merchant, kind: 'status_conflict', current_status: 'failed', incoming_status: 'captured', mode: 'live', detected_at: new Date().toISOString() },
    });
    const js = nc.jetstream();
    const body = new TextEncoder().encode(JSON.stringify(event));
    await js.publish('pay-payments.payment_intent.contradiction_detected', body);
    await js.publish('pay-payments.payment_intent.contradiction_detected', body);
    const row = await waitFor(async () => (await db.pool.query('SELECT kind, mode, status FROM settlement_exceptions WHERE payment_intent_id = $1', [paymentIntent])).rows[0], 30_000, 100);
    expect(row).toEqual({ kind: 'payment_contradiction', mode: 'live', status: 'open' });
    await waitFor(async () => {
      const info = await nc.jetstreamManager().then((jsm) => jsm.consumers.info('PAY_PAYMENTS', 'pay-settlement_payment_intent_contradiction_detected'));
      return info.num_pending === 0 && info.num_ack_pending === 0;
    }, 30_000, 100);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM settlement_exceptions WHERE payment_intent_id = $1', [paymentIntent])).rows[0].n).toBe(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id])).rows[0].n).toBe(1);
  });

  it('basura, JSON inválido, sobres inválidos y eventos ajenos no traban el consumidor ni se reintentan sin fin; el siguiente evento válido pasa', async () => {
    const js = nc.jetstream();
    const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
    await js.publish('pay-ledger.ledger.transfer.posted', bytes('esto no es json {{{'));
    await js.publish('pay-ledger.ledger.transfer.posted', bytes({ nada: true }));
    await js.publish('pay-ledger.ledger.transfer.posted', bytes({ ...transferPosted(merchantId()), data: { credit_account: 'merchant:mc_x:pending' } })); // sin posted_at
    await js.publish('pay-ledger.ledger.transfer.posted', bytes({ ...transferPosted(merchantId()), source: '/otro-servicio' }));
    const good = merchantId();
    await js.publish('pay-ledger.ledger.transfer.posted', bytes(transferPosted(good)));
    await waitFor(async () => (await merchantRow(good)).length > 0, 30_000, 100);
    const info = await waitFor(async () => {
      const i = await nc.jetstreamManager().then((jsm) => jsm.consumers.info('PAY_LEDGER', 'pay-settlement_ledger-transfer-posted'));
      return i.num_ack_pending === 0 && i.num_redelivered === 0 ? i : false;
    }, 30_000, 100);
    expect(info.num_ack_pending).toBe(0);
  });
});

describe('el relé del outbox publica los eventos propios en PAY_SETTLEMENT', () => {
  it('un payout.paid encolado en el outbox llega al stream, con el contrato y su Nats-Msg-Id', async () => {
    const payoutId = `po_${Math.random().toString(36).slice(2, 14).padEnd(12, 'a')}`;
    const m = merchantId();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await emitPayoutPaid(client, { payoutId, mode: 'test', merchantId: m, amountMinor: 4200, paidAt: new Date() });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await db.pool.query("SELECT id FROM outbox_events WHERE aggregate_id = $1", [payoutId]);
    const eventId = rows[0].id as string;
    const jsm = await nc.jetstreamManager();
    await ensureStream(jsm, 'PAY_SETTLEMENT', ['pay-settlement.>']);
    const consumer = await jsm.consumers.add('PAY_SETTLEMENT', { ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: 'pay-settlement.payout.paid' });
    const reader = await nc.jetstream().consumers.get('PAY_SETTLEMENT', consumer.name);
    const received = await waitFor(async () => {
      const batch = await reader.fetch({ max_messages: 500, expires: 1000 });
      for await (const message of batch) {
        message.ack();
        const event = JSON.parse(message.string()) as { id: string };
        if (event.id === eventId) return { event, headers: message.headers };
      }
      return false;
    }, 30_000, 100);
    expect(validators.get('payout.paid')?.(received.event)).toEqual([]);
    expect(received.headers?.get('Nats-Msg-Id')).toBe(eventId);
    expect(received.event).toMatchObject({ source: '/pay-settlement', type: 'payout.paid', subject: payoutId, merchantid: m, data: { amount_minor: 4200, status: 'paid' } });
    await jsm.consumers.delete('PAY_SETTLEMENT', consumer.name);
    const sent = await waitFor(async () => (await db.pool.query('SELECT published_at FROM outbox_events WHERE id = $1 AND published_at IS NOT NULL', [eventId])).rowCount, 30_000, 100);
    expect(sent).toBe(1);
  });
});

void newCloudEvent;

/**
 * RE-REVISION-DINERO F-B2 (NATS JetStream real): los consumidores durables ya no abandonan un evento a las 20 entregas. Lo simulado: el destino caído
 * (el consumidor falla N veces y luego responde); NATS, la base y el inbox son reales. Se acorta la espera (`redelivery`) para no esperar minutos.
 */
describe('F-B2 · entrega sin tope de los consumidores durables', () => {
  const durables = [
    ['PAY_LEDGER', 'pay-settlement_ledger-transfer-posted'],
    ['PAY_MERCHANTS', 'pay-settlement_fee-schedule-published'],
    ['PAY_PAYMENTS', 'pay-settlement_payment_intent_contradiction_detected'],
  ] as const;

  it('los tres durables quedan sin tope (los que existían con max_deliver 20 de corridas anteriores se migran al arrancar)', async () => {
    const manager = await nc.jetstreamManager();
    for (const [stream, durable] of durables) expect((await manager.consumers.info(stream, durable)).config).toMatchObject({ max_deliver: -1, ack_wait: ACK_WAIT_NS });
  });

  it('CORRECTO/LÍMITE: con el destino caído MÁS de 20 entregas (25) el evento no se abandona; al volver el efecto ocurre UNA vez, y repetirlo no lo duplica', async () => {
    const consumers = app.get(SettlementConsumers);
    const events = app.get(EventsModule);
    events.redelivery = { baseMs: 5, capMs: 25 };
    const original = consumers.handle.bind(consumers);
    let calls = 0;
    let down = true;
    consumers.handle = async (payload) => {
      calls += 1;
      if (down) throw new Error('base de liquidación caída');
      return original(payload);
    };
    try {
      const m = merchantId();
      const event = transferPosted(m);
      await publisher().publish('pay-ledger.ledger.transfer.posted', event);
      await waitFor(async () => calls >= 25, 20_000, 25); // 25 entregas fallidas: más allá del tope anterior (20)
      expect(await merchantRow(m)).toHaveLength(0); // nada se aplicó a medias
      down = false;
      await waitFor(async () => (await merchantRow(m)).length > 0, 20_000, 25);
      await waitFor(async () => {
        const info = await nc.jetstreamManager().then((jsm) => jsm.consumers.info('PAY_LEDGER', 'pay-settlement_ledger-transfer-posted'));
        return info.num_pending === 0 && info.num_ack_pending === 0;
      }, 20_000, 50);
      expect(calls).toBeGreaterThan(25);
      // la reentrega de lo ya aplicado (el mismo evento, sin Nats-Msg-Id para que JetStream no lo deduplique) no duplica el efecto: idempotencia del inbox
      await nc.jetstream().publish('pay-ledger.ledger.transfer.posted', new TextEncoder().encode(JSON.stringify(event)));
      await waitFor(async () => {
        const info = await nc.jetstreamManager().then((jsm) => jsm.consumers.info('PAY_LEDGER', 'pay-settlement_ledger-transfer-posted'));
        return info.num_pending === 0 && info.num_ack_pending === 0 && calls > 26;
      }, 20_000, 50);
      expect(await merchantRow(m)).toHaveLength(1);
      expect((await db.pool.query('SELECT count(*)::int AS n FROM inbox_events WHERE event_id = $1', [event.id])).rows[0].n).toBe(1);
    } finally {
      consumers.handle = original;
      events.redelivery = { baseMs: 2_000, capMs: 300_000 };
    }
  });
});
