import type { ReceiverOptions } from '../../src/receiver/webhook-receiver';
import { DELIVERY_ENGINE } from '../../src/engine/delivery-engine';
import { SVIX_RECONCILER } from '../../src/engine/svix/svix-reconcile.runner';
import type { SvixReconciler } from '../../src/engine/svix/svix-reconciler';
import { SvixApiError, type SvixClient } from '../../src/engine/svix/svix-client';
import type { SvixEngine } from '../../src/engine/svix/svix-engine';
import { HttpsReceiver, RECEIVER_HOST } from '../doubles/https-receiver';
import { createTestCertificate, type TestCertificate } from '../tls';
import { newKey, startWebhooks, type StartOptions, type WebhooksHarness } from '../harness';
import { assertSvixReady, newSvixClient, svixToken, SVIX_URL } from './svix-env';

export interface SvixHarness {
  readonly h: WebhooksHarness;
  readonly client: SvixClient;
  readonly token: string;
  readonly engine: SvixEngine;
  readonly reconciler: SvixReconciler;
  /** Receptor HTTPS real; su puerto ya está permitido por el guard de SSRF. Las claves se cargan al crear el endpoint. */
  receiver(override?: ReceiverOptions['override']): Promise<HttpsReceiver>;
  /** `POST /webhook_endpoints` por la API pública, y carga el secreto (o la clave pública) en el receptor para que verifique. */
  createEndpoint(merchantId: string, receiver: HttpsReceiver, body?: { enabled_events?: string[]; signature_scheme?: 'v1' | 'v1a' }): Promise<{ id: string; secret: string }>;
  /** Mensajes (por `eventId`) que Svix guarda para la aplicación del comercio. */
  messages(merchantId: string): Promise<string[]>;
  stop(): Promise<void>;
}

/** Servicio COMPLETO con `WEBHOOKS_ENGINE=svix`: Postgres real, svix-server real y receptores HTTPS reales. Solo el DNS del guard de SSRF es un doble. */
export async function startSvixHarness(options: Pick<StartOptions, 'env'> = {}): Promise<SvixHarness> {
  const token = svixToken();
  const client = newSvixClient(token);
  await assertSvixReady(client);
  const certificate: TestCertificate = createTestCertificate(RECEIVER_HOST);
  const allowedPorts: number[] = [443];
  const receivers: HttpsReceiver[] = [];
  const h = await startWebhooks({
    allowedPorts,
    resolverTable: { [RECEIVER_HOST]: ['93.184.216.34'] },
    env: { WEBHOOKS_ENGINE: 'svix', WEBHOOKS_SVIX_URL: SVIX_URL, WEBHOOKS_SVIX_AUTH_TOKEN: token, WEBHOOKS_SVIX_RECONCILE_INTERVAL_MS: '250', ...options.env },
  });
  const harness: SvixHarness = {
    h,
    client,
    token,
    engine: h.app.get<SvixEngine>(DELIVERY_ENGINE),
    reconciler: h.app.get<SvixReconciler>(SVIX_RECONCILER),
    async receiver(override) {
      const receiver = await new HttpsReceiver(override ? { override } : {}, certificate).listen();
      allowedPorts.push(receiver.port);
      receivers.push(receiver);
      return receiver;
    },
    async createEndpoint(merchantId, receiver, body = {}) {
      const res = await h.as(merchantId).post('/webhook_endpoints').set('Idempotency-Key', newKey()).send({ url: receiver.url, enabled_events: ['payment_intent.succeeded'], ...body });
      if (res.status !== 201) throw new Error(`alta falló: ${res.status} ${JSON.stringify(res.body)}`);
      const secret = res.body.secret as string;
      (secret.startsWith('whpk_') ? receiver.publicKeys : receiver.secrets).push(secret);
      return { id: res.body.id as string, secret };
    },
    async messages(merchantId) {
      try {
        const body = (await client.call('GET', `/api/v1/app/${merchantId}/msg`, { query: { limit: '250' }, expect: [200] })) as { data: { eventId: string | null }[] };
        return body.data.flatMap((m) => (m.eventId ? [m.eventId] : []));
      } catch (error) {
        if (error instanceof SvixApiError && error.status === 404) return []; // el comercio no tiene aplicación en Svix: ningún mensaje
        throw error;
      }
    },
    async stop() {
      await Promise.all(receivers.map((r) => r.close()));
      await h.stop();
      certificate.dispose();
    },
  };
  return harness;
}
