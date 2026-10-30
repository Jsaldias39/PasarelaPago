import { randomBytes } from 'node:crypto';
import { EngineMisconfiguredError, EngineRejectedError, type OutboundMessage } from '../../src/engine/delivery-engine';
import { SvixEngine } from '../../src/engine/svix/svix-engine';
import { SvixClient } from '../../src/engine/svix/svix-client';
import { insertEndpoint } from '../../src/endpoints/endpoint.repository';
import { cloudEvent } from '../fixtures';
import { newKey, newMerchantId } from '../harness';
import { newSvixClient } from './svix-env';
import { startSvixHarness, type SvixHarness } from './svix-harness';

/**
 * REVISION-DINERO F8 (errores de Svix bien clasificados) y F5 (compensación del alta fallida), contra svix-server REAL, Postgres real y el servicio
 * completo. Solo se simula, con un `fetch` que envuelve al real, lo que Svix real no produce a pedido (un 413, un 404 de aplicación transitorio).
 */
const t = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);
const TYPE = 'payment_intent.succeeded';

describe('SvixEngine: errores definitivos, deriva de la aplicación y compensación del alta contra Svix REAL', () => {
  let s: SvixHarness;
  beforeAll(async () => {
    s = await startSvixHarness();
  });
  afterAll(async () => s.stop());

  const message = (merchantId: string, eventId: string = cloudEvent(TYPE, merchantId).id): OutboundMessage => ({ merchantId, eventId, eventType: TYPE, payload: `{"id":"${eventId}","object":"event"}` });
  const engineWith = (impl: typeof fetch) => new SvixEngine(newSvixClient(s.token, { fetchImpl: impl }), { rotationGraceSeconds: 3600 });
  const notFoundApp = () => new Response(JSON.stringify({ code: 'not_found', detail: 'Application not found' }), { status: 404, headers: { 'content-type': 'application/json' } });

  describe('F8 · clasificación de las respuestas de Svix al publicar', () => {
    t('INVÁLIDO: un 413 (mensaje demasiado grande) es un rechazo DEFINITIVO (EngineRejectedError), no un transitorio que se reentrega sin fin', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      let hits = 0;
      const tooLarge: typeof fetch = async (input, init) => {
        if (String(init?.method) === 'POST' && new URL(String(input)).pathname.endsWith('/msg')) {
          hits += 1;
          return new Response(JSON.stringify({ code: 'payload_too_large' }), { status: 413 });
        }
        return fetch(input, init);
      };
      const error = await engineWith(tooLarge).publish(s.h.db.pool, message(merchant)).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'EngineRejectedError', reason: 'rejected_by_engine' });
      expect(hits).toBe(1); // un 4xx definitivo no se reintenta
    });

    t('INVÁLIDO: credenciales rechazadas (401 real de Svix) ⇒ EngineMisconfiguredError visible: el evento NO se descarta, NO se confirma, queda en la métrica y el inbox sin rastro', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      const wrongToken = new SvixEngine(new SvixClient({ baseUrl: process.env.PAY_TEST_SVIX_URL ?? 'http://127.0.0.1:54800', authToken: 'aaa.bbb.ccc', timeoutMs: 5_000, maxAttempts: 4, sleep: async () => undefined }), { rotationGraceSeconds: 60 });
      const original = s.engine.publishDetailed?.bind(s.engine);
      const originalPublish = s.engine.publish.bind(s.engine);
      s.engine.publishDetailed = (db, m) => wrongToken.publishDetailed(db, m);
      s.engine.publish = (db, m) => wrongToken.publish(db, m);
      const event = cloudEvent(TYPE, merchant);
      const before = { engine: s.h.ingest.metrics.engineMisconfigured, rejected: s.h.ingest.metrics.rejectedEngine };
      try {
        const error = await s.h.ingest.ingest(event).catch((e: unknown) => e);
        expect(error).toMatchObject({ name: 'EngineMisconfiguredError', status: 401 });
        expect(error).toBeInstanceOf(EngineMisconfiguredError);
        expect(String((error as Error).message) + String((error as Error).stack)).not.toContain('aaa.bbb.ccc');
      } finally {
        if (original) s.engine.publishDetailed = original;
        s.engine.publish = originalPublish;
      }
      expect(s.h.ingest.metrics.engineMisconfigured).toBe(before.engine + 1);
      expect(s.h.ingest.metrics.rejectedEngine).toBe(before.rejected); // no es un rechazo del mensaje
      expect((await s.h.db.pool.query('SELECT 1 FROM inbox_events WHERE event_id = $1', [event.id])).rowCount).toBe(0); // se reintentará
      expect(await s.messages(merchant)).toEqual([]);
    });

    t('INVÁLIDO: el consumidor detiene el lote ante EngineMisconfiguredError (nak largo, «halt»); un error cualquiera sigue el lote con la espera corta', async () => {
      const calls: string[] = [];
      const fake = (): never & Record<string, unknown> =>
        ({ subject: 'pay-payments.payment_intent.succeeded', string: () => '{}', ack: () => calls.push('ack'), term: () => calls.push('term'), nak: (delay: number) => calls.push(`nak:${delay}`) }) as never;
      const original = s.h.ingest.ingest.bind(s.h.ingest);
      const handle = (s.h.consumer as unknown as { handle(message: unknown): Promise<string> }).handle.bind(s.h.consumer);
      try {
        s.h.ingest.ingest = async () => {
          throw new EngineMisconfiguredError(403);
        };
        expect(await handle(fake())).toBe('halt');
        s.h.ingest.ingest = async () => {
          throw new Error('transitorio');
        };
        expect(await handle(fake())).toBe('continue');
        s.h.ingest.ingest = async () => ({ kind: 'queued', deliveries: 1 });
        expect(await handle(fake())).toBe('continue');
      } finally {
        s.h.ingest.ingest = original;
      }
      expect(calls).toEqual(['nak:60000', 'nak:2000', 'ack']);
    });

    t('CORRECTO: un 404 de la APLICACIÓN con los endpoints intactos ⇒ se recrea la aplicación UNA vez (idempotente) y se reintenta: el mensaje se crea', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      const calls: string[] = [];
      let first = true;
      const flaky: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method} ${path}`);
        if (first && String(init?.method) === 'POST' && path.endsWith('/msg')) {
          first = false;
          return notFoundApp();
        }
        return fetch(input, init);
      };
      const msg = message(merchant);
      expect(await engineWith(flaky).publish(s.h.db.pool, msg)).toBe(1);
      expect(calls.filter((c) => c === 'POST /api/v1/app')).toHaveLength(1); // recreada una sola vez
      expect(calls.filter((c) => c.endsWith('/msg'))).toHaveLength(2); // y el POST repetido, una sola vez
      expect(await s.messages(merchant)).toEqual([msg.eventId]);
    });

    t('INVÁLIDO: la aplicación DESAPARECIÓ de Svix con sus endpoints ⇒ se recrea pero el evento NO se da por publicado (EngineDriftError): queda pendiente y no se crea ningún mensaje', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      await s.client.call('DELETE', `/api/v1/app/${merchant}`, { expect: [204] }); // Svix pierde la aplicación y, con ella, el endpoint
      expect(await s.client.listEndpoints(merchant)).toBeUndefined();

      const msg = message(merchant);
      const error = await s.engine.publish(s.h.db.pool, msg).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'EngineDriftError', missingEndpoints: 1 });
      expect(error).not.toBeInstanceOf(EngineRejectedError); // no se descarta: se reintenta
      expect(await s.client.listEndpoints(merchant)).toEqual([]); // la aplicación sí quedó recreada
      expect(await s.messages(merchant)).toEqual([]); // y NADA se publicó «con éxito» a una aplicación sin endpoints
    });

    t('CORRECTO: el 409 «ya existe» (inbox perdido) no cuenta como «sin endpoints»: sube alreadyPublished y noEndpoints no se mueve', async () => {
      const merchant = newMerchantId();
      await s.createEndpoint(merchant, await s.receiver());
      const event = cloudEvent(TYPE, merchant);
      expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'queued', deliveries: 1 });
      await s.h.db.pool.query('DELETE FROM inbox_events WHERE event_id = $1', [event.id]); // se cayó el proceso antes del commit del inbox
      const before = { ...s.h.ingest.metrics };
      expect(await s.h.ingest.ingest(event)).toEqual({ kind: 'queued', deliveries: 0 });
      expect(s.h.ingest.metrics.noEndpoints).toBe(before.noEndpoints);
      expect(s.h.ingest.metrics.alreadyPublished).toBe(before.alreadyPublished + 1);
      expect(s.h.ingest.metrics.queued).toBe(before.queued);
    });

    t('LÍMITE: un evento de un comercio SIN endpoints sí cuenta como noEndpoints', async () => {
      const before = s.h.ingest.metrics.noEndpoints;
      expect(await s.h.ingest.ingest(cloudEvent(TYPE, newMerchantId()))).toEqual({ kind: 'queued', deliveries: 0 });
      expect(s.h.ingest.metrics.noEndpoints).toBe(before + 1);
    });
  });

  describe('F5 · alta fallida DESPUÉS de crear el endpoint en Svix', () => {
    const rowCount = async (merchant: string) => Number((await s.h.db.pool.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE merchant_id = $1', [merchant])).rows[0].n);

    t('CORRECTO: el alta falla de forma DEFINITIVA tras aprovisionar (se perdió el bloqueo de la clave: nunca hubo COMMIT) ⇒ el endpoint recién creado se borra de Svix y la fila no existe', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const original = s.engine.provisionEndpoint.bind(s.engine);
      s.engine.provisionEndpoint = async (db, endpoint) => {
        const out = await original(db, endpoint);
        // otro proceso le roba la clave: el UPDATE que avanza el punto de recuperación afecta 0 filas y la transacción se revierte
        await s.h.db.pool.query("UPDATE idempotency_keys SET lock_token = 'robado' WHERE scope = $1 AND state = 'started'", [merchant]);
        return out;
      };
      try {
        const res = await s.h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url: receiver.url, enabled_events: [TYPE] });
        expect(res.status).toBe(500);
      } finally {
        s.engine.provisionEndpoint = original;
      }
      expect(await rowCount(merchant)).toBe(0);
      expect(await s.client.listEndpoints(merchant)).toEqual([]); // no queda un endpoint vivo con un secreto que nadie recibió
    });

    t('INVÁLIDO (regla 11): resultado AMBIGUO (se corta la conexión de la transacción) ⇒ NO se borra el endpoint de Svix: lo resolverá la reconciliación', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const original = s.engine.provisionEndpoint.bind(s.engine);
      s.engine.provisionEndpoint = async (db, endpoint) => {
        const out = await original(db, endpoint);
        const pid = Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        await s.h.db.pool.query('SELECT pg_terminate_backend($1)', [pid]); // se cae la conexión con la transacción abierta
        return out;
      };
      try {
        const res = await s.h.as(merchant).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url: receiver.url, enabled_events: [TYPE] });
        expect(res.status).toBe(500);
      } finally {
        s.engine.provisionEndpoint = original;
      }
      expect(await rowCount(merchant)).toBe(0);
      const remote = (await s.client.listEndpoints(merchant)) ?? [];
      expect(remote).toHaveLength(1); // sigue ahí: ante la duda no se borra
      expect(remote[0].metadata).toEqual({ pay_owner: 'sandbox' });
    });

    t('INVÁLIDO: si provisionEndpoint mismo falla (409 de un uid ajeno) no hay nada que compensar: el endpoint existente NO se toca', async () => {
      const merchant = newMerchantId();
      const receiver = await s.receiver();
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: receiver.url, description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      await s.engine.provisionEndpoint(s.h.db.pool, record);
      await expect(s.engine.provisionEndpoint(s.h.db.pool, record)).rejects.toMatchObject({ status: 409 });
      expect((await s.client.listEndpoints(merchant))?.map((e) => e.uid)).toEqual([record.id]);
    });

    t('CORRECTO: compensateProvision nunca lanza: borra, tolera el 404 y ante un fallo del servidor solo lo registra', async () => {
      const merchant = newMerchantId();
      const record = await insertEndpoint(s.h.db.pool, { id: `we_${randomBytes(10).toString('hex')}`, merchantId: merchant, url: 'https://receptor.comercio.example/x', description: null, enabledEvents: [TYPE], signatureScheme: 'v1' });
      await s.engine.provisionEndpoint(s.h.db.pool, record);
      await expect(s.engine.compensateProvision(record)).resolves.toBeUndefined();
      expect(await s.client.listEndpoints(merchant)).toEqual([]);
      await expect(s.engine.compensateProvision(record)).resolves.toBeUndefined(); // ya no está: 404 es éxito
      const down = engineWith((async () => new Response('', { status: 503 })) as unknown as typeof fetch);
      await expect(down.compensateProvision(record)).resolves.toBeUndefined();
    });

    t('CORRECTO: los endpoints nuevos llevan la marca del propietario del entorno (metadata.pay_owner)', async () => {
      const merchant = newMerchantId();
      const { id } = await s.createEndpoint(merchant, await s.receiver());
      const remote = (await s.client.listEndpoints(merchant)) ?? [];
      expect(remote.find((e) => e.uid === id)?.metadata).toEqual({ pay_owner: 'sandbox' });
    });
  });
});
