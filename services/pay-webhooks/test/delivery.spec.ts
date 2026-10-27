import { verify, WebhookVerificationError } from '@pay/webhook-signature';
import { DELIVERY_ENGINE, type DeliveryEngine } from '../src/engine/delivery-engine';
import { WebhookReceiver } from '../src/receiver/webhook-receiver';
import { cloudEvent } from './fixtures';
import { newKey, newMerchantId, startWebhooks, type WebhooksHarness } from './harness';

/**
 * P1.H3.M1/M2/M4 contra el motor en proceso ([DOBLE de Svix]) con Postgres real. Reloj, DNS y último salto de red son dobles;
 * la firma, el reintento, la rotación, el arriendo y el guard de SSRF son código real. NO prueba Svix.
 */
const HOST = 'hooks.comercio.example';
const BODY = { url: `https://${HOST}/pay`, enabled_events: ['payment_intent.succeeded'] };
const HOUR = 3_600_000;

async function endpointFor(h: WebhooksHarness, merchant: string, body: Record<string, unknown> = BODY) {
  const res = await h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send(body);
  if (res.status !== 201) throw new Error(`alta falló: ${res.status}`);
  return { id: res.body.id as string, secret: res.body.secret as string };
}

describe('[DOBLE de Svix] entrega firmada con reintentos', () => {
  let h: WebhooksHarness;
  let receiver: WebhookReceiver;

  const attemptsOf = async (eventId: string) =>
    (await h.db.pool.query('SELECT a.attempt, a.status_code, a.error_code FROM webhook_delivery_attempts a JOIN webhook_deliveries d ON d.id = a.delivery_id WHERE d.event_id = $1 ORDER BY a.attempt', [eventId])).rows;
  const deliveryOf = async (eventId: string) => (await h.db.pool.query('SELECT status, attempts, last_status, last_error FROM webhook_deliveries WHERE event_id = $1', [eventId])).rows[0];

  beforeAll(async () => {
    h = await startWebhooks();
  });
  afterAll(async () => h.stop());
  beforeEach(async () => {
    // El trabajador toma TODA entrega vencida: cada prueba parte sin restos de las anteriores (esquema propio de esta corrida).
    await h.db.pool.query('DELETE FROM webhook_delivery_attempts');
    await h.db.pool.query('DELETE FROM webhook_deliveries');
    h.resolver.table[HOST] = ['93.184.216.34'];
  });
  afterEach(async () => receiver?.close());

  async function listen(options: ConstructorParameters<typeof WebhookReceiver>[0]) {
    receiver = new WebhookReceiver({ now: () => Math.floor(h.clock.now().getTime() / 1000), ...options });
    h.transport.route(HOST, await receiver.listen());
    h.transport.calls.length = 0;
  }

  describe('REQ-P1-5 — 500 tres veces y después 200', () => {
    it('llega con el MISMO webhook-id y una firma v1 que verifica con el whsec_ del comercio; cada reintento espera su turno', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret], override: ({ seen }) => (seen < 3 ? 500 : undefined) });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      expect((await h.ingest.ingest(event)).kind).toBe('queued');

      expect(await h.worker.runOnce()).toMatchObject({ claimed: 1, retrying: 1 }); // intento 1 ⇒ 500
      expect((await h.worker.runOnce()).claimed).toBe(0); // todavía no toca
      h.clock.advance(1_000);
      expect(await h.worker.runOnce()).toMatchObject({ claimed: 1, retrying: 1 }); // intento 2 ⇒ 500
      h.clock.advance(59_999);
      expect((await h.worker.runOnce()).claimed).toBe(0); // falta 1 ms
      h.clock.advance(1);
      expect(await h.worker.runOnce()).toMatchObject({ claimed: 1, retrying: 1 }); // intento 3 ⇒ 500
      h.clock.advance(HOUR);
      expect(await h.worker.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 }); // intento 4 ⇒ 200

      expect(receiver.log.map((e) => e.status)).toEqual([500, 500, 500, 200]);
      expect(new Set(receiver.log.map((e) => e.webhookId))).toEqual(new Set([event.id]));
      expect(receiver.accepted).toHaveLength(1);
      expect(receiver.accepted[0].webhookId).toBe(event.id);
      // los bytes son los mismos en cada reintento, y la marca de tiempo es de CADA intento (si no, vencería la tolerancia)
      expect(new Set(h.transport.calls.map((c) => c.body)).size).toBe(1);
      const stamps = h.transport.calls.map((c) => Number(c.headers['webhook-timestamp']));
      expect(new Set(stamps).size).toBe(4);
      expect(h.transport.calls.every((c) => /^v1,[A-Za-z0-9+/=]+$/.test(c.headers['webhook-signature']))).toBe(true);
      expect(await deliveryOf(event.id)).toMatchObject({ status: 'succeeded', attempts: 4, last_status: 200 });
      expect((await attemptsOf(event.id)).map((a) => a.status_code)).toEqual([500, 500, 500, 200]);
      expect(h.transport.calls.every((c) => c.ip === '93.184.216.34' && c.hostname === HOST)).toBe(true);
    });

    it('el cuerpo entregado es el payload público: ids e importes, sin datos personales', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      await h.worker.runOnce();
      const body = JSON.parse(receiver.accepted[0].body);
      expect(body).toEqual({ id: event.id, object: 'event', type: 'payment_intent.succeeded', created_at: '2026-10-27T11:59:00.000Z', mode: 'test', data: { object: event.data } });
    });
  });

  describe('REQ-P1-6 — 410 deshabilita y no reintenta', () => {
    it('un 410 deshabilita el endpoint (gone_410), cierra lo pendiente y no vuelve a intentar JAMÁS', async () => {
      const merchant = newMerchantId();
      const { id, secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret], override: () => 410 });
      const first = cloudEvent('payment_intent.succeeded', merchant);
      const second = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(first);
      await h.ingest.ingest(second);
      expect(await h.worker.runOnce()).toMatchObject({ claimed: 2, dead: 2 });

      const view = (await h.as(merchant).get('/webhook_endpoints')).body.data[0];
      expect(view).toMatchObject({ id, status: 'disabled', disabled_reason: 'gone_410' });
      h.contract.assertResponse({ method: 'GET', path: '/webhook_endpoints', status: 200, body: { object: 'list', has_more: false, next_cursor: null, data: [view] } });

      const arrivals = receiver.log.length;
      h.clock.advance(30 * 24 * HOUR);
      expect((await h.worker.runOnce()).claimed).toBe(0);
      expect(receiver.log).toHaveLength(arrivals);
      expect(await deliveryOf(first.id)).toMatchObject({ status: 'dead', attempts: 1 });

      // un evento nuevo ya no genera entrega para un endpoint deshabilitado
      expect(await h.ingest.ingest(cloudEvent('payment_intent.succeeded', merchant))).toEqual({ kind: 'queued', deliveries: 0 });
    });

    it('un 410 en el 2.º intento corta ahí: no hay 3.º', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret], override: ({ seen }) => (seen === 0 ? 500 : 410) });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      await h.worker.runOnce();
      h.clock.advance(1_000);
      await h.worker.runOnce();
      h.clock.advance(10 * HOUR);
      expect((await h.worker.runOnce()).claimed).toBe(0);
      expect(receiver.log.map((e) => e.status)).toEqual([500, 410]);
    });
  });

  describe('rotación de secreto: dos firmas en paralelo', () => {
    it('durante la gracia verifican el secreto VIEJO y el NUEVO; vencida la gracia, solo el nuevo', async () => {
      const merchant = newMerchantId();
      const { id, secret: oldSecret } = await endpointFor(h, merchant);
      const rotated = await h.as(merchant).post(`/webhook_endpoints/${id}/rotate_secret`).set('Idempotency-Key', newKey());
      const newSecret: string = rotated.body.secret;
      await listen({ secrets: [oldSecret, newSecret] });

      const during = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(during);
      await h.worker.runOnce();
      const call = h.transport.calls[0];
      expect(call.headers['webhook-signature'].split(' ')).toHaveLength(2);
      for (const secrets of [[oldSecret], [newSecret]]) {
        expect(() => verify({ headers: call.headers, payload: call.body, secrets, now: Number(call.headers['webhook-timestamp']) })).not.toThrow();
      }

      h.clock.advance(25 * HOUR); // vence la gracia de 24 h
      const after = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(after);
      await h.worker.runOnce();
      const late = h.transport.calls[h.transport.calls.length - 1];
      expect(late.headers['webhook-signature'].split(' ')).toHaveLength(1);
      const now = Number(late.headers['webhook-timestamp']);
      expect(() => verify({ headers: late.headers, payload: late.body, secrets: [newSecret], now })).not.toThrow();
      expect(() => verify({ headers: late.headers, payload: late.body, secrets: [oldSecret], now })).toThrow(WebhookVerificationError);
    });

    it('dos rotaciones seguidas: la tercera versión firma junto con las que siguen vigentes', async () => {
      const merchant = newMerchantId();
      const { id } = await endpointFor(h, merchant);
      for (let i = 0; i < 2; i += 1) await h.as(merchant).post(`/webhook_endpoints/${id}/rotate_secret`).set('Idempotency-Key', newKey());
      await listen({ secrets: [] });
      await h.ingest.ingest(cloudEvent('payment_intent.succeeded', merchant));
      await h.worker.runOnce();
      expect(h.transport.calls[0].headers['webhook-signature'].split(' ')).toHaveLength(3);
    });
  });

  describe('esquema v1a (Ed25519)', () => {
    it('firma con la clave secreta y el comercio verifica con la whpk_ que recibió; otra clave pública no verifica', async () => {
      const merchant = newMerchantId();
      const { secret: publicKey } = await endpointFor(h, merchant, { ...BODY, signature_scheme: 'v1a' });
      await listen({ publicKeys: [publicKey] });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      await h.worker.runOnce();
      expect(receiver.accepted).toHaveLength(1);
      expect(h.transport.calls[0].headers['webhook-signature']).toMatch(/^v1a,/);

      const { generateKeyPair } = await import('@pay/webhook-signature');
      const stranger = generateKeyPair().publicKey;
      const call = h.transport.calls[0];
      expect(() => verify({ headers: call.headers, payload: call.body, publicKeys: [stranger], now: Number(call.headers['webhook-timestamp']) })).toThrow(WebhookVerificationError);
    });
  });

  describe('agotamiento y salud del endpoint', () => {
    it('agotados todos los intentos la entrega queda dead; al llegar al tope el endpoint se deshabilita (too_many_failures)', async () => {
      const strict = await startWebhooks({ env: { WEBHOOKS_DISABLE_AFTER_DEAD: '2', WEBHOOKS_RETRY_SCHEDULE_MS: '0,10', WEBHOOKS_PER_ENDPOINT_CONCURRENCY: '1' } });
      try {
        const merchant = newMerchantId();
        const { secret } = await endpointFor(strict, merchant);
        const down = new WebhookReceiver({ secrets: [secret], override: () => 500 });
        strict.transport.route(HOST, await down.listen());
        try {
          const events = [cloudEvent('payment_intent.succeeded', merchant), cloudEvent('payment_intent.succeeded', merchant), cloudEvent('payment_intent.succeeded', merchant)];
          for (const e of events) await strict.ingest.ingest(e);
          await strict.worker.runOnce();
          strict.clock.advance(10);
          const summary = await strict.worker.runOnce();
          expect(summary.dead).toBe(3);

          const view = (await strict.as(merchant).get('/webhook_endpoints')).body.data[0];
          expect(view).toMatchObject({ status: 'disabled', disabled_reason: 'too_many_failures' });
          // 3 primeros intentos + 2 segundos: al agotarse la 2.ª entrega el endpoint se deshabilita y la 3.ª se cierra SIN enviarse
          expect(down.log).toHaveLength(5);
          expect(await strict.db.pool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE last_error = 'endpoint_disabled'")).toMatchObject({ rows: [{ n: 1 }] });
        } finally {
          await down.close();
        }
      } finally {
        await strict.stop();
      }
    });

    it('una entrega correcta pone en cero las fallas seguidas', async () => {
      const merchant = newMerchantId();
      const { id, secret } = await endpointFor(h, merchant);
      await h.db.pool.query('UPDATE webhook_endpoints SET consecutive_failures = 3 WHERE id = $1', [id]);
      await listen({ secrets: [secret] });
      await h.ingest.ingest(cloudEvent('payment_intent.succeeded', merchant));
      await h.worker.runOnce();
      const row = await h.db.pool.query('SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1', [id]);
      expect(row.rows[0].consecutive_failures).toBe(0);
    });

    it('un destino sin ruta (conexión rechazada) se reintenta con error_code connection_error, sin filtrar la red', async () => {
      const merchant = newMerchantId();
      h.resolver.table['sin-ruta.comercio.example'] = ['93.184.216.35'];
      await endpointFor(h, merchant, { ...BODY, url: 'https://sin-ruta.comercio.example/pay' });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      expect(await h.worker.runOnce()).toMatchObject({ retrying: 1 });
      expect((await attemptsOf(event.id))[0]).toMatchObject({ status_code: null, error_code: 'connection_error' });
      expect((await deliveryOf(event.id)).last_error).toBe('connection_error');
    });
  });

  describe('M6 — SSRF en CADA entrega (DNS rebinding)', () => {
    it('registrado con IP pública y después resuelto a una privada: 0 entregas al receptor; vuelve a público y entrega', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);

      // 3 rondas hostiles (la escalera de esta prueba tiene 4 intentos: el 4.º ya con el DNS sano)
      for (const hostile of [['10.0.0.5'], ['169.254.169.254'], ['93.184.216.34', '192.168.0.9']]) {
        h.resolver.table[HOST] = hostile;
        h.clock.advance(HOUR);
        const before = h.transport.calls.length;
        await h.worker.runOnce();
        expect(h.transport.calls).toHaveLength(before);
      }
      expect(receiver.log).toHaveLength(0);
      expect((await attemptsOf(event.id)).every((a) => a.error_code === 'ssrf_private_address')).toBe(true);

      h.resolver.table[HOST] = ['93.184.216.34'];
      h.clock.advance(HOUR);
      await h.worker.runOnce();
      expect(receiver.accepted).toHaveLength(1);
    });

    it('si el nombre deja de resolver, la entrega se reintenta (ssrf_unresolvable) y no se conecta a nada', async () => {
      const merchant = newMerchantId();
      await endpointFor(h, merchant);
      await listen({ secrets: [] });
      h.resolver.table[HOST] = new Error('ENOTFOUND');
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      await h.worker.runOnce();
      expect(h.transport.calls).toHaveLength(0);
      expect((await attemptsOf(event.id))[0].error_code).toBe('ssrf_unresolvable');
      h.resolver.table[HOST] = ['93.184.216.34'];
    });
  });

  describe('idempotencia y aislamiento de la entrega', () => {
    it('republicar el MISMO evento no duplica la entrega (inbox y UNIQUE por endpoint+evento)', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      expect((await h.ingest.ingest(event)).kind).toBe('queued');
      expect(await h.ingest.ingest(event)).toEqual({ kind: 'duplicate' });
      // saltando el inbox, la tabla de entregas es la segunda barrera
      const engine = h.app.get<DeliveryEngine>(DELIVERY_ENGINE);
      expect(await engine.publish(h.db.pool, { merchantId: merchant, eventId: event.id, eventType: event.type, payload: '{}' })).toBe(0);
      await h.worker.runOnce();
      h.clock.advance(HOUR);
      await h.worker.runOnce();
      expect(receiver.accepted).toHaveLength(1);
      expect(receiver.log).toHaveLength(1);
      const rows = await h.db.pool.query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE event_id = $1', [event.id]);
      expect(rows.rows[0].n).toBe(1);
    });

    it('cada endpoint recibe SOLO lo que suscribió y SOLO de su comercio', async () => {
      const merchant = newMerchantId();
      const other = newMerchantId();
      const a = await endpointFor(h, merchant, { ...BODY, enabled_events: ['payout.paid'] });
      const b = await endpointFor(h, merchant, { ...BODY, enabled_events: ['*'] });
      const c = await endpointFor(h, other);
      await h.ingest.ingest(cloudEvent('payment_intent.succeeded', merchant));
      const rows = await h.db.pool.query('SELECT endpoint_id FROM webhook_deliveries WHERE endpoint_id = ANY ($1)', [[a.id, b.id, c.id]]);
      expect(rows.rows.map((r) => r.endpoint_id)).toEqual([b.id]);
    });

    it('un endpoint borrado con entregas pendientes no recibe nada', async () => {
      const merchant = newMerchantId();
      const { id, secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      await h.as(merchant).delete(`/webhook_endpoints/${id}`);
      expect((await h.worker.runOnce()).claimed).toBe(0);
      expect(receiver.log).toHaveLength(0);
      expect(await deliveryOf(event.id)).toMatchObject({ status: 'dead', last_error: 'endpoint_deleted' });
    });
  });

  describe('concurrencia', () => {
    it('un endpoint LENTO no ahoga a los demás: tope de entregas en vuelo por endpoint y tope de lote por endpoint', async () => {
      const slowHost = 'lento.comercio.example';
      h.resolver.table[slowHost] = ['93.184.216.50'];
      const merchant = newMerchantId();
      const slow = await endpointFor(h, merchant, { url: `https://${slowHost}/pay`, enabled_events: ['payout.paid'] });
      const fast = await endpointFor(h, merchant, { url: `https://${HOST}/pay`, enabled_events: ['payment_intent.succeeded'] });
      const slowReceiver = new WebhookReceiver({ secrets: [slow.secret], now: () => Math.floor(h.clock.now().getTime() / 1000) });
      const fastReceiver = new WebhookReceiver({ secrets: [fast.secret], now: () => Math.floor(h.clock.now().getTime() / 1000) });
      h.transport.route(slowHost, await slowReceiver.listen());
      h.transport.route(HOST, await fastReceiver.listen());
      h.transport.calls.length = 0;
      h.transport.finished.length = 0;
      h.transport.maxInFlight.clear();
      h.transport.delays.set(slowHost, 300);

      for (let i = 0; i < 25; i += 1) await h.ingest.ingest(cloudEvent('payout.paid', merchant)); // 25 para el lento
      const fastEvent = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(fastEvent); // 1 para el rápido

      const started = Date.now();
      const summary = await h.worker.runOnce();
      const fastDone = h.transport.finished.find((f) => f.webhookId === fastEvent.id)!.at - started;

      expect(summary.claimed).toBe(h.config.delivery.perEndpointBatch + 1); // el lento no se lleva todo el lote
      expect(h.transport.maxInFlight.get(slowHost)).toBeLessThanOrEqual(h.config.delivery.perEndpointConcurrency);
      expect(fastDone).toBeLessThan(200); // no esperó a las entregas lentas
      const pendingSlow = await h.db.pool.query("SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND attempts = 0", [slow.id]);
      expect(pendingSlow.rows[0].n).toBe(15);
      h.transport.delays.clear();
      await slowReceiver.close();
      await fastReceiver.close();
    });

    it('3 trabajadores a la vez sobre 40 entregas: cada una se intenta UNA vez (SKIP LOCKED + arriendo)', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const events = Array.from({ length: 40 }, () => cloudEvent('payment_intent.succeeded', merchant));
      for (const e of events) await h.ingest.ingest(e);

      const runs = await Promise.all([h.worker.runOnce(), h.worker.runOnce(), h.worker.runOnce()]);
      let rest = 40 - runs.reduce((n, r) => n + r.claimed, 0);
      while (rest > 0) rest -= (await h.worker.runOnce()).claimed;

      expect(h.transport.calls).toHaveLength(40);
      expect(new Set(h.transport.calls.map((c) => c.headers['webhook-id'])).size).toBe(40);
      expect(receiver.accepted).toHaveLength(40);
      expect(receiver.log.every((e) => e.outcome === 'ok')).toBe(true);
    });

    it('una entrega que OTRO trabajador está reclamando en este instante se SALTA (FOR UPDATE SKIP LOCKED), no se espera ni se duplica', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const locked = cloudEvent('payment_intent.succeeded', merchant);
      const free = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(locked);
      await h.ingest.ingest(free);

      const other = await h.db.pool.connect();
      try {
        await other.query('BEGIN');
        await other.query('SELECT 1 FROM webhook_deliveries WHERE event_id = $1 FOR UPDATE', [locked.id]);
        const summary = await h.worker.runOnce(); // si esperara el candado, esta llamada no terminaría
        expect(summary.claimed).toBe(1);
        expect(h.transport.calls.map((c) => c.headers['webhook-id'])).toEqual([free.id]);
      } finally {
        await other.query('ROLLBACK');
        other.release();
      }
      expect(await h.worker.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(receiver.accepted.map((e) => e.webhookId).sort()).toEqual([locked.id, free.id].sort());
    });

    it('un trabajador que murió a mitad (arriendo vigente) no bloquea para siempre: vencido el arriendo otro retoma la entrega', async () => {
      const merchant = newMerchantId();
      const { secret } = await endpointFor(h, merchant);
      await listen({ secrets: [secret] });
      const event = cloudEvent('payment_intent.succeeded', merchant);
      await h.ingest.ingest(event);
      // «reclamó» y murió: intentos 1 y arriendo de 60 s hacia adelante
      await h.db.pool.query(`UPDATE webhook_deliveries SET attempts = 1, next_attempt_at = $2::timestamptz + interval '60 seconds' WHERE event_id = $1`, [event.id, h.clock.now().toISOString()]);
      expect((await h.worker.runOnce()).claimed).toBe(0);
      h.clock.advance(61_000);
      expect(await h.worker.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(receiver.accepted).toHaveLength(1);
      expect(await deliveryOf(event.id)).toMatchObject({ attempts: 2 });
    });
  });
});
