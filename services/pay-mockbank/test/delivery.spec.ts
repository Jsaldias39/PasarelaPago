import request from 'supertest';
import { verify, WebhookVerificationError } from '@pay/webhook-signature';
import { asAdmin, chargeBody, createTestApp, deliver, get, post, type TestApp } from './support/app';

// Entrega de callbacks firmados hacia pay-connectors (Standard Webhooks). Tres niveles: correcto, límite (reintentos), inválido (firma).
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const open = async (cents = 0) => {
  const body = chargeBody({ amount_minor: 10000 + cents }, t.clock);
  await post(t, '/sandbox/charges', body);
  return body.reference as string;
};
const row = async () => (await t.db.pool.query('SELECT attempts, delivered_at, next_attempt_at FROM mb_callbacks ORDER BY id LIMIT 1')).rows[0] as { attempts: number; delivered_at: Date | null; next_attempt_at: Date };

describe('firma Standard Webhooks', () => {
  it('correcto: cabeceras webhook-id/timestamp/signature, cuerpo JSON del callback del conector `mock` y firma que verifica con el secreto sintético', async () => {
    const reference = await open();
    await deliver(t);
    const [only] = t.receiver.received;
    expect(t.receiver.received).toHaveLength(1);
    expect(only?.headers['content-type']).toBe('application/json');
    expect(Object.keys(only?.headers ?? {})).toEqual(expect.arrayContaining(['webhook-id', 'webhook-timestamp', 'webhook-signature']));
    verify({ headers: only?.headers as Record<string, string>, payload: Buffer.from(only?.rawBody ?? ''), secrets: [t.config.webhookSecret], now: Math.floor(t.clock.now().getTime() / 1000) });
    const body = t.receiver.bodies()[0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['amount_minor', 'id', 'occurred_at', 'reference', 'status', 'type']);
    expect(body).toMatchObject({ type: 'charge.status', reference, status: 'captured', amount_minor: 10000 });
    expect(only?.headers['webhook-id']).toBe(body.id);
  });

  it('inválido: con otro secreto, o con el cuerpo alterado, la firma NO verifica; el secreto no aparece en lo enviado', async () => {
    await open();
    await deliver(t);
    const [only] = t.receiver.received;
    const now = Math.floor(t.clock.now().getTime() / 1000);
    const headers = only?.headers as Record<string, string>;
    expect(() => verify({ headers, payload: Buffer.from(only?.rawBody ?? ''), secrets: ['whsec_b3Ryby1zZWNyZXRvLWRpc3RpbnRvLTAwMDAwMDAwMDA='], now })).toThrow(WebhookVerificationError);
    expect(() => verify({ headers, payload: Buffer.from((only?.rawBody ?? '').replace('captured', 'failed__')), secrets: [t.config.webhookSecret], now })).toThrow(WebhookVerificationError);
    expect(JSON.stringify(t.receiver.received)).not.toContain(t.config.webhookSecret);
  });
});

describe('reintentos ante un receptor que falla (como un banco real)', () => {
  it('límite: 500 ⇒ queda sin entregar con backoff; recién cumplido el backoff se reintenta; 2xx ⇒ entregado y no se repite', async () => {
    await open();
    t.receiver.respond = () => 500;
    expect(await deliver(t)).toEqual({ delivered: 0, failed: 1 });
    expect(await row()).toMatchObject({ attempts: 1, delivered_at: null });
    // Mientras no cumpla el backoff no se reintenta.
    expect(await deliver(t)).toEqual({ delivered: 0, failed: 0 });
    expect(t.receiver.received).toHaveLength(1);
    t.receiver.respond = () => 200;
    t.clock.advance(61_000);
    expect(await deliver(t)).toEqual({ delivered: 1, failed: 0 });
    expect(t.receiver.received).toHaveLength(2);
    expect(t.receiver.received[0]?.headers['webhook-id']).toBe(t.receiver.received[1]?.headers['webhook-id']); // el reintento es el MISMO evento
    expect((await row()).delivered_at).not.toBeNull();
    expect(await deliver(t)).toEqual({ delivered: 0, failed: 0 });
  });

  it('el receptor caído (conexión rechazada) cuenta como fallo y se reintenta; nada se pierde', async () => {
    await open();
    await t.receiver.stop();
    expect(await deliver(t)).toEqual({ delivered: 0, failed: 1 });
    await t.receiver.start();
    (t.config as { callbackUrl?: string }).callbackUrl = t.receiver.url;
    t.clock.advance(61_000);
    expect(await deliver(t)).toEqual({ delivered: 1, failed: 0 });
  });

  it('sin MOCKBANK_CALLBACK_URL no entrega nada (el cobro se resuelve por consulta de estado)', async () => {
    const quiet = await createTestApp({ config: { callbackUrl: undefined } });
    try {
      const body = chargeBody({}, quiet.clock);
      await post(quiet, '/sandbox/charges', body);
      expect((await request(quiet.app.getHttpServer()).post('/sandbox/admin/deliver').set(asAdmin)).body).toEqual({ delivered: 0, failed: 0 });
      expect((await get(quiet, `/sandbox/charges/${body.reference as string}`)).body.status).toBe('captured');
    } finally {
      await quiet.close();
    }
  });

  it('el temporizador entrega solo (MOCKBANK_DELIVERY_INTERVAL_MS) y se apaga con la app', async () => {
    const auto = await createTestApp({ config: { deliveryIntervalMs: 25 } });
    try {
      await post(auto, '/sandbox/charges', chargeBody({}, auto.clock));
      const deadline = Date.now() + 10_000;
      while (auto.receiver.received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(auto.receiver.received).toHaveLength(1);
    } finally {
      await auto.close();
    }
  });
});
