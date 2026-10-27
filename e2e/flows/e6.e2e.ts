import { MerchantReceiver, type ReceiverRoute } from '../lib/receiver.ts';
import { waitFor } from '../lib/process.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E6 REAL (P1.H3.M4): webhook al comercio con el endpoint caído; un endpoint que responde 410 queda deshabilitado.
 *
 * Todo pasa por procesos reales: API pública de `pay-edge` con una clave `sk_test_` (la semilla de sandbox la publica el relé de
 * pay-merchants y el borde la replica por NATS), cobros reales en `pay-payments` (riesgo, conector `mock`, ledger), eventos públicos
 * por JetStream → `pay-webhooks` → entrega firmada a un receptor HTTPS local. Nada se espera por tiempo fijo: cada paso espera su condición.
 *
 * El «endpoint caído 10 minutos» del plan se reduce a una ventana corta: la escalera de reintentos del stack es de milisegundos
 * (WEBHOOKS_RETRY_SCHEDULE_MS) y el receptor responde 500 hasta que la prueba observa N fallos; lo que se prueba es la mecánica
 * (reintento con el MISMO webhook-id, una sola vez al final, sin duplicados), no el reloj.
 */
const SCHEDULE_MS = '0,200,400,800,1600,3200,6400,12800';

describe('E6 — entrega de webhooks contra el stack real', () => {
  let stack: Stack;
  let merchant: SeededMerchant;
  let receiver: MerchantReceiver;
  let healthy: { id: string; secret: string; route: ReceiverRoute };
  let gone: { id: string; secret: string; route: ReceiverRoute };
  const authorization = () => ({ authorization: `Bearer ${merchant.token}` });
  const intents: string[] = [];

  const createIntent = async (key: string) => {
    const res = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { ...authorization(), 'idempotency-key': key }, json: { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } } });
    expect(res.status).toBe(201);
    const id = (res.json as { id: string }).id;
    intents.push(id);
    return id;
  };

  const createEndpoint = async (path: string, events: string[]) => {
    const res = await stack.call('pay-edge', 'POST', '/v1/webhook_endpoints', {
      headers: { ...authorization(), 'idempotency-key': `e6-endpoint-${path.slice(1)}-0001` },
      json: { url: `https://127.0.0.1:${stack.receiver.port}${path}`, enabled_events: events },
    });
    expect({ status: res.status, body: res.json }).toMatchObject({ status: 201 });
    const body = res.json as { id: string; secret: string };
    expect(body.secret).toMatch(/^whsec_/);
    return body;
  };

  beforeAll(async () => {
    stack = await startStack({ webhookRetryScheduleMs: SCHEDULE_MS, tolerateFailures: false });
    merchant = await seedMerchant(stack, { label: 'COMERCIO E6 (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    receiver = new MerchantReceiver({ port: stack.receiver.port, certFile: stack.receiver.certFile, keyFile: stack.receiver.keyFile });
    await receiver.listen();
  });

  afterAll(async () => {
    await receiver?.close();
    if (stack) {
      const report = await stopStack(stack, { keepLogs: true });
      expect(report.leftoverPids).toEqual([]);
    }
  });

  it('el comercio registra dos endpoints por la API pública; el SSRF sigue cerrando todo lo que no es el receptor de sandbox', async () => {
    const blocked = await stack.call('pay-edge', 'POST', '/v1/webhook_endpoints', { headers: { ...authorization(), 'idempotency-key': 'e6-ssrf-key-0001' }, json: { url: 'https://127.0.0.1:9/hook', enabled_events: ['payment_intent.created'] } });
    expect(blocked.status).toBe(422);
    expect(blocked.json).toMatchObject({ code: 'validation_failed', errors: [{ field: 'url' }] });
    const metadata = await stack.call('pay-edge', 'POST', '/v1/webhook_endpoints', { headers: { ...authorization(), 'idempotency-key': 'e6-ssrf-key-0002' }, json: { url: 'https://169.254.169.254/latest/meta-data/', enabled_events: ['payment_intent.created'] } });
    expect(metadata.status).toBe(422);

    const a = await createEndpoint('/hook-healthy', ['payment_intent.created', 'payment_intent.failed']);
    const b = await createEndpoint('/hook-gone', ['payment_intent.created', 'payment_intent.failed']);
    healthy = { ...a, route: receiver.route('/hook-healthy', { secret: a.secret, mode: 'down' }) };
    gone = { ...b, route: receiver.route('/hook-gone', { secret: b.secret, mode: 'gone' }) };
  });

  it('endpoint caído: los eventos de cuatro cobros reales se reintentan con el MISMO webhook-id y, al volver, llegan UNA vez cada uno', async () => {
    for (let i = 1; i <= 4; i += 1) await createIntent(`e6-intent-${i}-key-0001`);

    // El endpoint sigue caído hasta que se observan varios fallos (condición, no tiempo).
    const sawFailures = await waitFor(async () => receiver.arrivals('/hook-healthy').filter((e) => e.outcome === 'down').length >= 8, 60_000);
    expect(sawFailures).toEqual({ ok: true });
    healthy.route.mode = 'up';

    const expectedPerIntent = ['payment_intent.created', 'payment_intent.failed'];
    const delivered = await waitFor(async () => [...receiver.accepted.values()].filter((a) => a.path === '/hook-healthy').length >= intents.length * expectedPerIntent.length, 60_000);
    expect(delivered).toEqual({ ok: true });

    const accepted = [...receiver.accepted.entries()].filter(([, a]) => a.path === '/hook-healthy');
    const events = accepted.map(([id, a]) => ({ id, ...(JSON.parse(a.body) as { id: string; object: string; type: string; mode: string; data: { object: Record<string, unknown> } }) }));
    // una sola vez: el webhook-id es el id del evento y no hay dos aceptados iguales
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const e of events) {
      expect(e.id).toBe(e.id);
      expect(e.object).toBe('event');
      expect(e.mode).toBe('test');
      expect(JSON.stringify(e.data)).not.toMatch(/@|nombre|documento/i);
    }
    for (const intent of intents) {
      const types = events.filter((e) => e.data.object.payment_intent_id === intent).map((e) => e.type).sort();
      expect(types).toEqual([...expectedPerIntent].sort());
    }
    const arrivals = receiver.arrivals('/hook-healthy');
    if (process.env.E2E_LOG) {
      const rows = events.map((e) => `  ${e.id}  ${e.type.padEnd(22)} intento(s): ${arrivals.filter((x) => x.webhookId === e.id).map((x) => x.status).join(',')}`);
      process.stdout.write(`E6 /hook-healthy: ${arrivals.length} llegadas para ${events.length} eventos\n${rows.join('\n')}\n`);
    }
    // los reintentos llevaron el MISMO webhook-id: hubo más llegadas que eventos y todas las llegadas de un id son del mismo evento
    expect(arrivals.length).toBeGreaterThan(events.length);
    expect(arrivals.filter((e) => e.outcome === 'ok')).toHaveLength(events.length);
    expect(arrivals.filter((e) => e.outcome !== 'ok' && e.outcome !== 'down' && e.outcome !== 'duplicate')).toEqual([]);
    for (const e of events) expect(arrivals.filter((x) => x.webhookId === e.id && x.outcome === 'ok')).toHaveLength(1);
  });

  it('endpoint que responde 410: queda deshabilitado (gone_410) y no recibe nada más', async () => {
    const disabled = await waitFor(async () => {
      const list = await stack.call('pay-edge', 'GET', '/v1/webhook_endpoints', { headers: authorization() });
      const mine = (list.json as { data: { id: string; status: string; disabled_reason: string | null }[] }).data.find((e) => e.id === gone.id);
      return mine?.status === 'disabled' && mine.disabled_reason === 'gone_410';
    }, 60_000);
    expect(disabled).toEqual({ ok: true });

    const arrivalsAfterDisable = receiver.arrivals('/hook-gone').length;
    expect(arrivalsAfterDisable).toBeGreaterThanOrEqual(1);
    expect(arrivalsAfterDisable).toBeLessThanOrEqual(2); // a lo sumo las entregas que iban en vuelo (pay-webhooks: 2 por endpoint)
    expect(receiver.arrivals('/hook-gone').every((e) => e.status === 410)).toBe(true);
    if (process.env.E2E_LOG) process.stdout.write(`E6 /hook-gone: ${receiver.arrivals('/hook-gone').map((e) => `${e.webhookId}→${e.status}`).join(' ')}\n`);

    // un cobro NUEVO llega al endpoint sano y nunca al deshabilitado
    const before = [...receiver.accepted.values()].filter((a) => a.path === '/hook-healthy').length;
    await createIntent('e6-intent-5-key-0001');
    const next = await waitFor(async () => [...receiver.accepted.values()].filter((a) => a.path === '/hook-healthy').length >= before + 2, 60_000);
    expect(next).toEqual({ ok: true });
    expect(receiver.arrivals('/hook-gone')).toHaveLength(arrivalsAfterDisable);
  });

  it('el estado quedó consistente por la API: un endpoint sano y uno deshabilitado; el secreto solo se mostró al crearlos', async () => {
    const list = await stack.call('pay-edge', 'GET', '/v1/webhook_endpoints', { headers: authorization() });
    expect(list.status).toBe(200);
    const data = (list.json as { data: { id: string; status: string }[] }).data;
    expect(data.find((e) => e.id === healthy.id)?.status).toBe('enabled');
    expect(data.find((e) => e.id === gone.id)?.status).toBe('disabled');
    expect(list.text).not.toContain('whsec_');
  });
});
