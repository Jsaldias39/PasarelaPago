import { connect, DeliverPolicy } from 'nats';
import request from 'supertest';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { REGISTRY } from '../src/core/tokens';
import type { ConnectorRegistry } from '../src/domain/registry';
import { asPayments, chargeBody, createTestApp, post, uniqueKey, type TestApp } from './support/app';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('eventos por NATS JetStream (relé del outbox → stream PAY_CONNECTORS)', () => {
  it('el evento de un callback sale por el relé, llega al stream con Nats-Msg-Id = id del evento, y el sobre es el del outbox', async () => {
    await t.reset();
    const startedAt = new Date(Date.now() - 1000);
    const bank = t.app.get<SimulatedBank>(SIMULATED_BANK);
    const mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
    const created = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    const [callback] = bank.dueCallbacks(t.clock.now());
    const signed = await mock.signCallback(callback as NonNullable<typeof callback>, t.clock.now());
    const delivered = await request(t.app.getHttpServer()).post('/callbacks/mock').set(signed.headers).set('content-type', 'application/json').send(signed.rawBody.toString('utf8'));
    expect(delivered.body.result).toBe('applied');

    const row = (await t.db.pool.query("SELECT id, subject, envelope FROM outbox_events WHERE type = 'connector.transaction.status_changed'")).rows[0];
    expect(row.subject).toBe('pay-connectors.connector.transaction.status_changed');

    // El relé publica solo; se espera por condición, no por tiempo fijo.
    const deadline = Date.now() + 10_000;
    let publishedAt: Date | null = null;
    while (Date.now() < deadline) {
      publishedAt = (await t.db.pool.query('SELECT published_at FROM outbox_events WHERE id = $1', [row.id])).rows[0].published_at;
      if (publishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(publishedAt).not.toBeNull();

    const nc = await connect({ servers: process.env.NATS_URL as string });
    try {
      const consumer = await nc.jetstream().consumers.get('PAY_CONNECTORS', { filterSubjects: [row.subject], deliver_policy: DeliverPolicy.StartTime, opt_start_time: startedAt.toISOString() });
      const messages = await consumer.consume();
      let found: { msgId: string | undefined; data: Record<string, unknown> } | null = null;
      const timer = setTimeout(() => void messages.close(), 10_000);
      for await (const message of messages) {
        const msgId = message.headers?.get('Nats-Msg-Id');
        if (msgId === row.id) {
          found = { msgId, data: message.json() };
          await messages.close();
        }
      }
      clearTimeout(timer);
      expect(found).not.toBeNull();
      expect(found?.msgId).toBe(row.id);
      expect(found?.data).toEqual(row.envelope);
      expect((found?.data.data as Record<string, unknown>).payment_intent_id).toBe(created.body.payment_intent_id);
    } finally {
      await nc.drain();
    }
  });
});
