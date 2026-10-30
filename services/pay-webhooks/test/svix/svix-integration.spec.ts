import { randomBytes } from 'node:crypto';
import { processOnce } from '@pay/outbox';
import { verify, WebhookVerificationError } from '@pay/webhook-signature';
import { EngineRejectedError, type OutboundMessage } from '../../src/engine/delivery-engine';
import { SvixEngine } from '../../src/engine/svix/svix-engine';
import { SvixApiError, SvixClient, SvixUnavailableError } from '../../src/engine/svix/svix-client';
import { SvixReconciler } from '../../src/engine/svix/svix-reconciler';
import { disableEndpoint, insertEndpoint } from '../../src/endpoints/endpoint.repository';
import { cloudEvent } from '../fixtures';
import { newKey, newMerchantId } from '../harness';
import { eventually, newSvixClient } from './svix-env';
import { startSvixHarness, type SvixHarness } from './svix-harness';

/**
 * P1.H3.M1 — `SvixEngine` contra un svix-server REAL (1.104.0), Postgres real y receptores HTTPS reales que verifican con
 * `@pay/webhook-signature`. Lo único simulado: el DNS del guard de SSRF (para que `receptor.comercio.example` pase por «público») y, en la
 * sección de resultados ambiguos, un `fetch` que pierde la respuesta o descarta la petición para provocar el timeout.
 * La escalera de reintentos de Svix es la de prueba (1, 2 y 3 s; ver svix-env.ts).
 */
// Cada prueba espera entregas reales de Svix (escalera de 1, 2 y 3 s): más margen que el de 20 s por defecto.
const t = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TYPE = 'payment_intent.succeeded';

describe('SvixEngine contra svix-server REAL', () => {
  let s: SvixHarness;
  beforeAll(async () => {
    s = await startSvixHarness();
  });
  afterAll(async () => s.stop());

  const message = (merchantId: string, eventId: string = cloudEvent(TYPE, merchantId).id, type: string = TYPE, payload: string = `{"id":"${eventId}","object":"event"}`): OutboundMessage => ({ merchantId, eventId, eventType: type, payload });
  const signatures = (header: string | string[] | undefined) => String(header).split(' ');
  const engineWith = (impl: typeof fetch) => new SvixEngine(newSvixClient(s.token, { fetchImpl: impl }), { rotationGraceSeconds: 3600 });

  describe('(1) idempotencia: el mismo evento dos veces ⇒ UN mensaje en Svix y UNA entrega', () => {
    t('inbox + 409 de Svix: republicar, y republicar tras perder el inbox (caída antes del commit), no duplica nada', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      await s.createEndpoint(merchant, receiver);
      const event = cloudEvent(TYPE, merchant);

      expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'queued', deliveries: 1 });
      expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'duplicate' }); // la barrera del inbox
      // Sin la barrera del inbox (se cayó el proceso entre Svix y el commit): ahora la que responde es Svix, con un 409 sobre el eventId.
      await s.h.db.pool.query('DELETE FROM inbox_events WHERE event_id = $1', [event.id]);
      expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'queued', deliveries: 0 });

      expect(await s.messages(merchant)).toEqual([event.id]);
      await eventually(async () => receiver.receiver.accepted.length, (n) => n === 1);
      await sleep(2_000);
      expect(receiver.requests).toHaveLength(1);
      expect(receiver.receiver.log).toEqual([{ webhookId: expect.stringMatching(/^msg_/), status: 200, outcome: 'ok' }]);
    });

    t('la transacción del inbox se revierte DESPUÉS de crear el mensaje en Svix: la reentrega converge en un solo mensaje y una sola entrega', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      await s.createEndpoint(merchant, receiver);
      const event = cloudEvent(TYPE, merchant);

      await expect(
        processOnce(s.h.db.pool, `pay-webhooks.${event.type}`, event.id, async (client) => {
          expect(await s.engine.publish(client, message(merchant, event.id))).toBe(1);
          throw new Error('caída simulada tras crear el mensaje');
        }),
      ).rejects.toThrow('caída simulada');
      expect((await s.h.db.pool.query('SELECT 1 FROM inbox_events WHERE event_id = $1', [event.id])).rowCount).toBe(0);

      expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'queued', deliveries: 0 });
      expect(await s.messages(merchant)).toEqual([event.id]);
      await eventually(async () => receiver.receiver.accepted.length, (n) => n === 1);
      await sleep(1_500);
      expect(receiver.requests).toHaveLength(1);
    });

    t('un evento con DOS endpoints suscriptos es UN mensaje; cada endpoint lo recibe una vez; republicar el mensaje no suma entregas', async () => {
      const merchant = newMerchantId();
      const [a, b] = [await s.receiver(), await s.receiver()];
      await s.createEndpoint(merchant, a);
      await s.createEndpoint(merchant, b);
      const msg = message(merchant);
      expect(await s.engine.publish(s.h.db.pool, msg)).toBe(2);
      expect(await s.engine.publish(s.h.db.pool, msg)).toBe(0);
      expect(await s.messages(merchant)).toEqual([msg.eventId]);
      await eventually(async () => [a.receiver.accepted.length, b.receiver.accepted.length], (n) => n[0] === 1 && n[1] === 1);
      await sleep(1_500);
      expect([a.requests.length, b.requests.length]).toEqual([1, 1]);
    });
  });

  describe('(2) correcto: entrega firmada que el comercio verifica', () => {
    t('llega por HTTPS con las cabeceras Standard Webhooks, el cuerpo es el payload público y @pay/webhook-signature lo verifica; una alteración se rechaza', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { secret } = await s.createEndpoint(merchant, receiver);
      const event = cloudEvent(TYPE, merchant);
      await s.h.ingest.ingest(event);
      await eventually(async () => receiver.requests.length, (n) => n >= 1);

      const request = receiver.requests[0];
      expect(request.headers['webhook-id']).toMatch(/^msg_/);
      expect(request.headers['content-type']).toBe('application/json');
      expect(Math.abs(Date.now() / 1000 - Number(request.headers['webhook-timestamp']))).toBeLessThan(30);
      expect(Object.keys(request.headers).filter((h) => h.startsWith('svix-'))).toEqual([]); // SVIX_WHITELABEL_HEADERS
      expect(() => verify({ headers: request.headers, payload: request.body, secrets: [secret] })).not.toThrow();
      expect(() => verify({ headers: request.headers, payload: `${request.body} `, secrets: [secret] })).toThrow(WebhookVerificationError);
      expect(() => verify({ headers: { ...request.headers, 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, payload: request.body, secrets: [secret] })).toThrow(WebhookVerificationError);
      expect(() => verify({ headers: request.headers, payload: request.body, secrets: ['whsec_ZmlybWEtZXF1aXZvY2FkYS1maXJtYS1lcXVpdm9jYWRh'] })).toThrow(WebhookVerificationError);

      const body = JSON.parse(request.body) as { id: string; type: string; mode: string; data: { object: Record<string, unknown> } };
      expect(body).toMatchObject({ id: event.id, type: TYPE, mode: 'test' });
      expect(body.data.object).toMatchObject({ payment_intent_id: event.data.payment_intent_id, amount_minor: 10000, currency: 'BOB' });
      expect(request.body).not.toMatch(/@/); // política de payload: ids, estados e importes; ningún correo
      expect(receiver.receiver.log).toEqual([{ webhookId: request.headers['webhook-id'], status: 200, outcome: 'ok' }]);
    });

    t('rotación v1: la entrega lleva DOS firmas; verifica con el secreto VIEJO y con el NUEVO, no con uno ajeno', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id, secret: oldSecret } = await s.createEndpoint(merchant, receiver);
      const rotated = await s.h.as(merchant).post(`/webhook_endpoints/${id}/rotate_secret`).set('Idempotency-Key', newKey());
      expect(rotated.status).toBe(200);
      const newSecret = rotated.body.secret as string;
      expect(newSecret).toMatch(/^whsec_/);
      expect(newSecret).not.toBe(oldSecret);
      receiver.secrets.push(newSecret);

      await s.h.ingest.ingest(cloudEvent(TYPE, merchant));
      await eventually(async () => receiver.requests.length, (n) => n >= 1);
      const { headers, body } = receiver.requests[0];
      expect(signatures(headers['webhook-signature'])).toHaveLength(2);
      if (process.env.SVIX_LOG) process.stdout.write(`Rotación v1, cabeceras recibidas: webhook-id=${headers['webhook-id']} webhook-timestamp=${headers['webhook-timestamp']} webhook-signature=${headers['webhook-signature']}\ncuerpo=${body}\n`);
      expect(() => verify({ headers, payload: body, secrets: [oldSecret] })).not.toThrow();
      expect(() => verify({ headers, payload: body, secrets: [newSecret] })).not.toThrow();
      expect(() => verify({ headers, payload: body, secrets: ['whsec_ZmlybWEtZXF1aXZvY2FkYS1maXJtYS1lcXVpdm9jYWRh'] })).toThrow(WebhookVerificationError);
      // el secreto que devuelve la API es el que Svix guarda
      expect(await s.client.getEndpointKey(merchant, id)).toBe(newSecret);
    });

    t('esquema v1a (Ed25519): el comercio recibe la whpk_, verifica con ella y sigue verificando con la vieja y la nueva durante la rotación', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id, secret: oldPublic } = await s.createEndpoint(merchant, receiver, { signature_scheme: 'v1a' });
      expect(oldPublic).toMatch(/^whpk_/);
      expect(await s.client.getEndpointKey(merchant, id)).toBe(oldPublic);

      await s.h.ingest.ingest(cloudEvent(TYPE, merchant));
      await eventually(async () => receiver.requests.length, (n) => n >= 1);
      const first = receiver.requests[0];
      expect(signatures(first.headers['webhook-signature']).map((x) => x.split(',')[0])).toEqual(['v1a']);
      expect(() => verify({ headers: first.headers, payload: first.body, publicKeys: [oldPublic] })).not.toThrow();

      const rotated = await s.h.as(merchant).post(`/webhook_endpoints/${id}/rotate_secret`).set('Idempotency-Key', newKey());
      const newPublic = rotated.body.secret as string;
      expect(newPublic).toMatch(/^whpk_/);
      expect(newPublic).not.toBe(oldPublic);
      receiver.publicKeys.push(newPublic);
      await s.h.ingest.ingest(cloudEvent(TYPE, merchant));
      await eventually(async () => receiver.requests.length, (n) => n >= 2);
      const second = receiver.requests[1];
      expect(signatures(second.headers['webhook-signature']).map((x) => x.split(',')[0])).toEqual(['v1a', 'v1a']);
      expect(() => verify({ headers: second.headers, payload: second.body, publicKeys: [oldPublic] })).not.toThrow();
      expect(() => verify({ headers: second.headers, payload: second.body, publicKeys: [newPublic] })).not.toThrow();
    });

    t('vencida la gracia, la entrega lleva UNA sola firma (la nueva) y el secreto viejo ya no verifica', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const engine = new SvixEngine(s.client, { rotationGraceSeconds: 1 });
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: receiver.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      const oldSecret = (await engine.provisionEndpoint(s.h.db.pool, record)).secret;
      const newSecret = (await engine.rotateEndpointSecret(s.h.db.pool, record)).secret;
      receiver.secrets.push(oldSecret, newSecret);
      await sleep(2_500);
      expect(await engine.publish(s.h.db.pool, message(merchant))).toBe(1);
      await eventually(async () => receiver.requests.length, (n) => n >= 1);
      const { headers, body } = receiver.requests[0];
      expect(signatures(headers['webhook-signature'])).toHaveLength(1);
      expect(() => verify({ headers, payload: body, secrets: [newSecret] })).not.toThrow();
      expect(() => verify({ headers, payload: body, secrets: [oldSecret] })).toThrow(WebhookVerificationError);
    });

    t('endpoint caído que luego vuelve: 500, 500 y 200 con el MISMO webhook-id; el receptor lo acepta una vez', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver(({ seen }) => (seen < 2 ? 500 : undefined));
      await s.createEndpoint(merchant, receiver);
      await s.h.ingest.ingest(cloudEvent(TYPE, merchant));
      await eventually(async () => receiver.receiver.accepted.length, (n) => n === 1);
      expect(receiver.receiver.log.map((l) => l.status)).toEqual([500, 500, 200]);
      expect(new Set(receiver.receiver.log.map((l) => l.webhookId)).size).toBe(1);
      // la marca de tiempo es la de CADA intento (el spec la pide fresca): no se firma con la del primero
      const stamps = receiver.requests.map((r) => Number(r.headers['webhook-timestamp']));
      expect(stamps[2]).toBeGreaterThan(stamps[0]);
    });
  });

  describe('(3) 410, baja por fallos y convergencia con Svix', () => {
    t('un 410 deshabilita el endpoint (gone_410) en Svix y en la tabla; no llegan más intentos ni mensajes nuevos', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver(() => 410);
      const { id } = await s.createEndpoint(merchant, receiver);
      for (let i = 0; i < 3; i += 1) expect(await s.h.ingest.ingest(cloudEvent(TYPE, merchant))).toEqual({ kind: 'queued', deliveries: 1 });
      await eventually(async () => receiver.requests.length, (n) => n >= 1);

      const summary = await eventually(() => s.reconciler.runOnce(), (r) => r.disabledGone >= 1);
      expect(summary.disabledGone).toBe(1);
      const listed = (await s.h.as(merchant).get('/webhook_endpoints')).body.data as { id: string; status: string; disabled_reason: string | null }[];
      expect(listed.find((e) => e.id === id)).toMatchObject({ status: 'disabled', disabled_reason: 'gone_410' });
      expect((await s.client.listEndpoints(merchant))?.find((e) => e.uid === id)?.disabled).toBe(true);

      await sleep(1_000); // deja caer lo que ya iba en vuelo
      const settled = receiver.requests.length;
      await sleep(4_500); // más que la siguiente espera de la escalera (3 s): los reintentos pendientes se descartaron al deshabilitar
      expect(receiver.requests).toHaveLength(settled);
      expect(await s.h.ingest.ingest(cloudEvent(TYPE, merchant))).toEqual({ kind: 'queued', deliveries: 0 });
      expect(receiver.requests).toHaveLength(settled);
    });

    t('Svix da de baja el endpoint por fallos continuos (sin 410) ⇒ too_many_failures [el disparador de 120 h se SIMULA con PATCH disabled]', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id } = await s.createEndpoint(merchant, receiver);
      await s.client.setEndpointDisabled(merchant, id, true);
      const summary = await s.reconciler.runOnce();
      expect(summary.disabledFailing).toBeGreaterThanOrEqual(1);
      const listed = (await s.h.as(merchant).get('/webhook_endpoints')).body.data as { id: string; status: string; disabled_reason: string | null }[];
      expect(listed.find((e) => e.id === id)).toMatchObject({ status: 'disabled', disabled_reason: 'too_many_failures' });
    });

    t('un endpoint deshabilitado aquí que Svix sigue teniendo activo se deshabilita también en Svix', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id } = await s.createEndpoint(merchant, receiver);
      await disableEndpoint(s.h.db.pool, id, 'manual');
      expect((await s.client.listEndpoints(merchant))?.find((e) => e.uid === id)?.disabled).toBe(false);
      const summary = await s.reconciler.runOnce();
      expect(summary.alignedDisabled).toBeGreaterThanOrEqual(1);
      expect((await s.client.listEndpoints(merchant))?.find((e) => e.uid === id)?.disabled).toBe(true);
    });

    t('un endpoint de Svix sin fila local (alta revertida) se borra pasada la gracia; con gracia vigente no se toca; los que sí tienen fila quedan', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id } = await s.createEndpoint(merchant, receiver);
      const orphan = `we_${randomBytes(10).toString('hex')}`;
      // un huérfano PROPIO: lleva la marca del entorno (F2); sin ella el reconciliador no lo toca (ver svix-reconciler-guards.spec.ts)
      await s.client.createEndpoint(merchant, { uid: orphan, url: receiver.url, eventTypes: [TYPE], secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oDC2FVsBQIhrs=', metadata: { pay_owner: 'sandbox' } });

      const patient = new SvixReconciler(s.h.db.pool, s.client, { orphanGraceMs: 3_600_000, concurrency: 2 });
      expect((await patient.runOnce()).orphansDeleted).toBe(0);
      expect((await s.client.listEndpoints(merchant))?.map((e) => e.uid).sort()).toEqual([id, orphan].sort());

      const strict = new SvixReconciler(s.h.db.pool, s.client, { orphanGraceMs: 0, clockMarginMs: 0, concurrency: 2 });
      expect((await strict.runOnce()).orphansDeleted).toBeGreaterThanOrEqual(1);
      expect((await s.client.listEndpoints(merchant))?.map((e) => e.uid)).toEqual([id]);
      // y nada de lo que no es nuestro: un endpoint con uid ajeno al formato we_… no se borra
      await s.client.createEndpoint(merchant, { uid: 'ajeno-al-formato', url: receiver.url, eventTypes: [TYPE], secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oDC2FVsBQIhrs=' });
      await strict.runOnce();
      expect((await s.client.listEndpoints(merchant))?.map((e) => e.uid).sort()).toEqual([id, 'ajeno-al-formato'].sort());
    });

    t('un endpoint local que Svix no tiene se REPORTA (missingInSvix) y no se recrea: el comercio perdería su secreto', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id } = await s.createEndpoint(merchant, receiver);
      await s.client.deleteEndpoint(merchant, id);
      const summary = await s.reconciler.runOnce();
      expect(summary.missingInSvix).toBeGreaterThanOrEqual(1);
      expect((await s.client.listEndpoints(merchant))?.map((e) => e.uid)).toEqual([]);
    });

    t('la baja por la API borra el endpoint en Svix: no recibe nada más y repetirla da 404', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { id } = await s.createEndpoint(merchant, receiver);
      expect((await s.h.as(merchant).delete(`/webhook_endpoints/${id}`)).status).toBe(204);
      expect((await s.client.listEndpoints(merchant))?.map((e) => e.uid)).toEqual([]);
      expect(await s.h.ingest.ingest(cloudEvent(TYPE, merchant))).toEqual({ kind: 'queued', deliveries: 0 });
      expect((await s.h.as(merchant).delete(`/webhook_endpoints/${id}`)).status).toBe(404);
      await sleep(1_000);
      expect(receiver.requests).toHaveLength(0);
    });
  });

  describe('(4) límite e inválido', () => {
    t('LÍMITE: evento sin endpoint, de un tipo no suscripto o de un comercio ajeno ⇒ 0 entregas y NINGÚN mensaje en Svix', async () => {
      const merchant = newMerchantId();
      expect(await s.h.ingest.ingest(cloudEvent(TYPE, merchant))).toEqual({ kind: 'queued', deliveries: 0 });
      expect(await s.messages(merchant)).toEqual([]);

      const receiver = await s.receiver();
      await s.createEndpoint(merchant, receiver, { enabled_events: ['payout.paid'] });
      const unsubscribed = cloudEvent(TYPE, merchant);
      expect(await s.h.ingest.ingest(unsubscribed)).toEqual({ kind: 'queued', deliveries: 0 });
      const stranger = cloudEvent('payout.paid', newMerchantId());
      expect(await s.h.ingest.ingest(stranger)).toEqual({ kind: 'queued', deliveries: 0 });
      expect(await s.messages(merchant)).toEqual([]);
      await sleep(1_000);
      expect(receiver.requests).toHaveLength(0);
    });

    t('LÍMITE: «*» recibe todos los tipos públicos; un tipo exacto, solo ese', async () => {
      const merchant = newMerchantId();
      const [all, only] = [await s.receiver(), await s.receiver()];
      await s.createEndpoint(merchant, all, { enabled_events: ['*'] });
      await s.createEndpoint(merchant, only, { enabled_events: ['refund.created'] });
      expect(await s.h.ingest.ingest(cloudEvent('payout.paid', merchant))).toEqual({ kind: 'queued', deliveries: 1 });
      expect(await s.h.ingest.ingest(cloudEvent('refund.created', merchant, { refund_id: 'rf_abcdefghij12' }))).toEqual({ kind: 'queued', deliveries: 2 });
      await eventually(async () => [all.receiver.accepted.length, only.receiver.accepted.length], (n) => n[0] === 2 && n[1] === 1);
      await sleep(1_000);
      expect([all.requests.length, only.requests.length]).toEqual([2, 1]);
    });

    it.each([['un arreglo', '[1,2]'], ['una cadena', '"texto"'], ['null', 'null'], ['un número', '42'], ['no es JSON', 'esto no es json']])('INVÁLIDO: payload %s ⇒ EngineRejectedError(payload_invalid) y nada en Svix', async (_name, payload) => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      await s.createEndpoint(merchant, receiver);
      const msg = message(merchant, cloudEvent(TYPE, merchant).id, TYPE, payload);
      await expect(s.engine.publish(s.h.db.pool, msg)).rejects.toMatchObject({ name: 'EngineRejectedError', reason: 'payload_invalid' });
      expect(await s.messages(merchant)).toEqual([]);
    });

    t('INVÁLIDO: un eventId que Svix rechaza (257 caracteres) ⇒ EngineRejectedError(rejected_by_engine), definitivo', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      await expect(s.engine.publish(s.h.db.pool, message(merchant, 'a'.repeat(257)))).rejects.toMatchObject({ name: 'EngineRejectedError', reason: 'rejected_by_engine' });
      // …y el límite exacto (256) sí pasa
      const ok = await s.engine.publish(s.h.db.pool, message(merchant, 'b'.repeat(256)));
      expect(ok).toBe(1);
    });

    t('LÍMITE: el eventId es único POR APLICACIÓN en Svix 1.104.0 (el OpenAPI dice «por entorno»): el mismo eventId en dos comercios crea dos mensajes', async () => {
      const [a, b] = [newMerchantId(), newMerchantId()];
      const [ra, rb] = [await s.receiver(), await s.receiver()];
      await s.createEndpoint(a, ra);
      await s.createEndpoint(b, rb);
      const shared = cloudEvent(TYPE, a).id;
      expect(await s.engine.publish(s.h.db.pool, message(a, shared))).toBe(1);
      expect(await s.engine.publish(s.h.db.pool, message(b, shared))).toBe(1);
      expect(await s.messages(a)).toEqual([shared]);
      expect(await s.messages(b)).toEqual([shared]);
      await eventually(async () => [ra.receiver.accepted.length, rb.receiver.accepted.length], (n) => n[0] === 1 && n[1] === 1);
    });

    t('INVÁLIDO [Svix SIMULADO: el servidor real no produce este caso]: un 409 cuyo mensaje no está en la aplicación del comercio ⇒ EngineRejectedError(event_id_conflict)', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      const impl: typeof fetch = async (input, init) => {
        const { pathname } = new URL(String(input));
        if (init?.method === 'POST' && pathname.endsWith('/msg')) return new Response('{"code":"conflict","detail":"A conflict has occurred"}', { status: 409 });
        if (init?.method === 'GET' && pathname.includes('/msg/')) return new Response('{"code":"not_found","detail":"Entity not found"}', { status: 404 });
        return fetch(input, init);
      };
      await expect(engineWith(impl).publish(s.h.db.pool, message(merchant))).rejects.toMatchObject({ name: 'EngineRejectedError', reason: 'event_id_conflict' });
    });

    t('INVÁLIDO [defensa de Svix, la nuestra queda saltada a propósito]: un endpoint que llegó a Svix apuntando a una IP privada, al loopback o a «localhost» NO recibe nada', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      // la dirección del anfitrión vista desde el contenedor (puerta de enlace de Docker; `host-gateway` de compose.yml): privada, y el receptor SÍ escucha ahí
      const privateIp = process.env.PAY_TEST_SVIX_HOST_GATEWAY ?? '172.17.0.1';
      await s.client.ensureApp(merchant, merchant);
      const targets = { privada: `https://${privateIp}:${receiver.port}/hook`, loopback: `https://127.0.0.1:${receiver.port}/hook`, localhost: `https://localhost:${receiver.port}/hook`, metadatos: 'https://169.254.169.254/latest/meta-data' };
      for (const [name, url] of Object.entries(targets)) await s.client.createEndpoint(merchant, { uid: `we_${name}${randomBytes(4).toString('hex')}`.slice(0, 40), url, eventTypes: null, secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oDC2FVsBQIhrs=' });
      const msg = message(merchant);
      await s.client.createMessage(merchant, { eventId: msg.eventId, eventType: TYPE, payload: JSON.parse(msg.payload) as Record<string, unknown> });
      const endpoints = (await s.client.listEndpoints(merchant)) ?? [];
      expect(endpoints).toHaveLength(4);
      const verdicts: string[] = [];
      for (const endpoint of endpoints) {
        const attempts = await eventually(
          async () => ((await s.client.call('GET', `/api/v1/app/${merchant}/attempt/endpoint/${endpoint.uid}`, { expect: [200] })) as { data: { responseStatusCode: number; response: string }[] }).data,
          (list) => list.length >= 1,
          10_000,
        );
        verdicts.push(`${endpoint.url.replace(/:\d+/, ':PUERTO')} → ${attempts[0].responseStatusCode} «${attempts[0].response}»`);
        expect(attempts[0].responseStatusCode).toBe(0);
        expect(attempts[0].response).toMatch(/blocked/);
      }
      expect(receiver.requests).toHaveLength(0);
      if (process.env.SVIX_SSRF_LOG) process.stdout.write(`SSRF en Svix:\n  ${verdicts.join('\n  ')}\n`);
    });

    t('INVÁLIDO: el ingest convierte un rechazo definitivo del motor en «rejected» (se descarta, no se reintenta) y no deja rastro en el inbox', async () => {
      const merchant = newMerchantId();
      const event = cloudEvent(TYPE, merchant);
      const original = s.engine.publish.bind(s.engine);
      s.engine.publish = async () => {
        throw new EngineRejectedError('payload_invalid');
      };
      const before = s.h.ingest.metrics.rejectedEngine;
      try {
        expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'rejected', reason: 'engine_rejected', detail: 'payload_invalid' });
      } finally {
        s.engine.publish = original;
      }
      expect(s.h.ingest.metrics.rejectedEngine).toBe(before + 1);
      expect((await s.h.db.pool.query('SELECT 1 FROM inbox_events WHERE event_id = $1', [event.id])).rowCount).toBe(0);
    });

    t('INVÁLIDO: una URL a la red interna se rechaza con 422 ANTES de tocar Svix (ni aplicación ni endpoint)', async () => {
      const merchant = newMerchantId();
      for (const url of ['https://127.0.0.1/pay', 'https://169.254.169.254/latest', 'https://10.0.0.5/pay', 'http://hooks.comercio.example/pay']) {
        const res = await s.h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url, enabled_events: [TYPE] });
        expect(res.status).toBe(422);
      }
      expect(await s.client.listEndpoints(merchant)).toBeUndefined();
    });
  });

  describe('(5) resultado ambiguo (CLAUDE.md regla 11): timeout, 5xx o corte NO prueban que no se ejecutó', () => {
    /** `fetch` real al que se le pierde la respuesta (el servidor SÍ ejecutó) o se le descarta la petición (el servidor NO la vio), según el plan. */
    const lossy = (plan: (method: string, path: string, call: number) => 'pass' | 'lose-response' | 'drop-request') => {
      const calls: string[] = [];
      let count = 0;
      const impl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const action = plan(String(init?.method), url.pathname, (count += 1));
        calls.push(`${init?.method} ${url.pathname} ${action}`);
        if (action === 'drop-request') throw new TypeError('fetch failed');
        const response = await fetch(input, init);
        if (action === 'lose-response') {
          await response.arrayBuffer();
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        }
        return response;
      };
      return { impl, calls };
    };

    t('crear el mensaje: Svix lo creó pero se perdió la respuesta ⇒ se reintenta con el MISMO eventId, el 409 se resuelve y hay UN mensaje y UNA entrega', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      await s.createEndpoint(merchant, receiver);
      const { impl, calls } = lossy((method, path, call) => (method === 'POST' && path.endsWith('/msg') && call === 1 ? 'lose-response' : 'pass'));
      const msg = message(merchant);
      expect(await engineWith(impl).publish(s.h.db.pool, msg)).toBe(0); // 409 ⇒ «ya existía»: no se afirma haberlo creado
      expect(calls.filter((c) => c.endsWith('/msg lose-response') || c.endsWith('/msg pass'))).toHaveLength(2); // el mismo POST dos veces
      expect(await s.messages(merchant)).toEqual([msg.eventId]);
      await eventually(async () => receiver.receiver.accepted.length, (n) => n === 1);
      await sleep(1_500);
      expect(receiver.requests).toHaveLength(1);
    });

    t('crear el mensaje: Svix no responde NUNCA ⇒ el error sube (SvixUnavailableError), no se borra ni anula nada y la reentrega con el mismo eventId lo crea', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      await s.createEndpoint(merchant, receiver);
      const { impl, calls } = lossy((method, path) => (method === 'POST' && path.endsWith('/msg') ? 'drop-request' : 'pass'));
      const msg = message(merchant);
      await expect(engineWith(impl).publish(s.h.db.pool, msg)).rejects.toBeInstanceOf(SvixUnavailableError);
      expect(calls.filter((c) => c.includes('/msg'))).toHaveLength(4); // maxAttempts del cliente
      expect(await s.messages(merchant)).toEqual([]);
      // la reentrega de NATS: mismo eventId, Svix ya sano
      expect(await s.engine.publish(s.h.db.pool, msg)).toBe(1);
      await eventually(async () => receiver.receiver.accepted.length, (n) => n === 1);
      expect(await s.messages(merchant)).toEqual([msg.eventId]);
    });

    t('un 503 del servidor tampoco es «no existe»: se reintenta y, agotado, sube como ambiguo', async () => {
      let hits = 0;
      const failing = async () => {
        hits += 1;
        return new Response('', { status: 503 });
      };
      const engine = new SvixEngine(newSvixClient(s.token, { fetchImpl: failing as unknown as typeof fetch }), { rotationGraceSeconds: 60 });
      const merchant = newMerchantId();
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: 'https://hooks.comercio.example/x', description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      await expect(engine.publish(s.h.db.pool, message(merchant))).rejects.toMatchObject({ name: 'SvixUnavailableError', reason: 'server_error', status: 503 });
      expect(hits).toBe(4);
      expect(record.id).toMatch(/^we_/);
    });

    t('crear el endpoint: se perdió la respuesta ⇒ el 409 del reintento se reconoce como propio (misma clave) y el secreto entregado es el que firma', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const { impl } = lossy((method, path, call) => (method === 'POST' && path.endsWith('/endpoint') && call <= 3 ? 'lose-response' : 'pass'));
      const engine = engineWith(impl);
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: receiver.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      const { secret } = await engine.provisionEndpoint(s.h.db.pool, record);
      receiver.secrets.push(secret);
      expect(await s.client.getEndpointKey(merchant, record.id)).toBe(secret);
      expect(await s.engine.publish(s.h.db.pool, message(merchant))).toBe(1);
      await eventually(async () => receiver.receiver.accepted.length, (n) => n === 1);
    });

    t('crear el endpoint: un uid que YA existe con otra clave es un conflicto real (409), no se adopta', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: receiver.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      await s.engine.provisionEndpoint(s.h.db.pool, record);
      await expect(s.engine.provisionEndpoint(s.h.db.pool, record)).rejects.toMatchObject({ name: 'SvixApiError', status: 409 });
    });

    t('rotar: se perdió la respuesta ⇒ se comprueba la clave antes de repetir; queda UNA rotación (dos firmas, no tres) y el secreto devuelto es el vigente', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: receiver.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      const oldSecret = (await s.engine.provisionEndpoint(s.h.db.pool, record)).secret;
      const { impl, calls } = lossy((method, path, call) => (method === 'POST' && path.endsWith('/secret/rotate') && call === 1 ? 'lose-response' : 'pass'));
      const newSecret = (await engineWith(impl).rotateEndpointSecret(s.h.db.pool, record)).secret;
      expect(calls.filter((c) => c.includes('/secret/rotate'))).toHaveLength(1); // no se repitió a ciegas
      expect(await s.client.getEndpointKey(merchant, record.id)).toBe(newSecret);
      receiver.secrets.push(oldSecret, newSecret);
      expect(await s.engine.publish(s.h.db.pool, message(merchant))).toBe(1);
      await eventually(async () => receiver.requests.length, (n) => n >= 1);
      expect(signatures(receiver.requests[0].headers['webhook-signature'])).toHaveLength(2);
    });

    t('rotar un endpoint que no existe ⇒ 404 definitivo (no se confunde con un resultado ambiguo)', async () => {
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: newMerchantId(), url: 'https://hooks.comercio.example/x', description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      await expect(s.engine.rotateEndpointSecret(s.h.db.pool, record)).rejects.toBeInstanceOf(SvixApiError);
    });
  });

  describe('(6) autenticación con Svix', () => {
    t('un token que Svix no acepta ⇒ 401 definitivo, UNA sola llamada (no se reintenta) y el token no aparece en el error', async () => {
      let hits = 0;
      const counting: typeof fetch = async (input, init) => {
        hits += 1;
        return fetch(input, init);
      };
      const bad = new SvixClient({ baseUrl: process.env.PAY_TEST_SVIX_URL ?? 'http://127.0.0.1:54800', authToken: 'aaa.bbb.ccc', timeoutMs: 5_000, maxAttempts: 4, sleep: async () => undefined, fetchImpl: counting });
      const error = await bad.ensureApp('mc_sintoken', 'x').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SvixApiError);
      expect((error as SvixApiError).status).toBe(401);
      expect(hits).toBe(1);
      expect(JSON.stringify(error) + String((error as Error).message) + String((error as Error).stack)).not.toContain('aaa.bbb.ccc');
    });
  });
});

