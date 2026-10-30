import { appendFileSync } from 'node:fs'; const out = (...a: unknown[]) => appendFileSync('<carpeta-de-la-evidencia>/results.txt', a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n');
import 'reflect-metadata';
import { gzipSync } from 'node:zlib';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import request from 'supertest';
import { AllExceptionsFilter } from '/home/user/mantra-core-health-api/src/common/filters/all-exceptions.filter';
import { PaymentsGatewayWebhooksController } from '/home/user/mantra-core-health-api/src/modules/payments/controllers/payments-gateway-webhooks.controller';
import { PaymentsGatewayWebhookService } from '/home/user/mantra-core-health-api/src/modules/payments/services/payments-gateway-webhook.service';
import { captureGatewayWebhookRawBody } from '/home/user/mantra-core-health-api/src/modules/payments/gateway/payments-gateway-raw-body';
import { TEST_API_KEY, TEST_WEBHOOK_SECRET, signTestWebhook } from '/home/user/mantra-core-health-api/src/modules/payments/gateway/payments-gateway.double.testing';

const EVENT = '0b5d1c5e-9f0a-4a52-8f3b-6a1d2f0f6c11';
const PAYLOAD = JSON.stringify({ id: EVENT, object: 'event', type: 'payment_intent.processing', created_at: 'x', mode: 'test', data: { object: { payment_intent_id: 'pi_c92215200m49', status: 'processing' } } });
const cfg: any = { viaGateway: true, baseUrl: 'https://x/v1', apiKey: TEST_API_KEY, mode: 'test', webhookSecrets: [TEST_WEBHOOK_SECRET], webhookPublicKeys: [], webhookToleranceSeconds: 300, timeoutMs: 1000, maxAttempts: 3, retryBaseMs: 10 };

async function build(prodLike: boolean) {
  const errors: string[] = [];
  const logger: any = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: (o: any, m: string) => errors.push(m) };
  const service = new PaymentsGatewayWebhookService(cfg, { transactional: async (cb: any) => cb({}) } as never, { findByGatewayIntentRefForUpdate: async () => null } as never, {} as never, {} as never, logger);
  const mod = await Test.createTestingModule({ controllers: [PaymentsGatewayWebhooksController], providers: [{ provide: PaymentsGatewayWebhookService, useValue: service }] }).compile();
  // prodLike: igual que main.ts => NO se pasa bodyParser:false (Nest registra el suyo si no ve 'jsonParser')
  const app = mod.createNestApplication(prodLike ? { logger: false } : { logger: false, bodyParser: false });
  app.use(json({ limit: '1mb', verify: captureGatewayWebhookRawBody }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));
  app.useGlobalFilters(new AllExceptionsFilter({ setContext: jest.fn(), warn: jest.fn(), error: jest.fn() } as any, { setAttribute: jest.fn(), recordException: jest.fn(), addEvent: jest.fn() } as any));
  await app.init();
  return { app, errors };
}

describe('REVISION http', () => {
  beforeAll(() => { jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
  const T = Math.floor(Date.now() / 1000);
  const headers = () => signTestWebhook({ id: EVENT, timestamp: T, payload: PAYLOAD });
  const row = async (label: string, fn: (srv: any) => any, prodLike = true) => {
    const { app, errors } = await build(prodLike);
    const res = await fn(app.getHttpServer());
    out(`${label} => ${res.status} ${JSON.stringify(res.body).slice(0, 200)} | errorLogs=${errors.length}`);
    await app.close();
  };
  it('matriz', async () => {
    await row('A prodLike (sin bodyParser:false) firmado', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json').set(headers()).send(PAYLOAD));
    await row('B text/plain firmado', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'text/plain').set(headers()).send(PAYLOAD));
    await row('C sin Content-Type, SIN firma (no autenticado)', (s) => request(s).post('/payments/gateway-webhooks').send(PAYLOAD));
    await row('D cuerpo vacio application/json sin firma', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json'));
    await row('E barra final firmado', (s) => request(s).post('/payments/gateway-webhooks/').set('Content-Type', 'application/json').set(headers()).send(PAYLOAD));
    await row('F mayusculas en ruta firmado', (s) => request(s).post('/Payments/Gateway-Webhooks').set('Content-Type', 'application/json').set(headers()).send(PAYLOAD));
    await row('G doble barra firmado', (s) => request(s).post('//payments/gateway-webhooks').set('Content-Type', 'application/json').set(headers()).send(PAYLOAD));
    await row('H Content-Encoding gzip firmado sobre inflado', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').set(headers()).send(gzipSync(PAYLOAD)));
    await row('I JSON no objeto ([]) sin firma', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json').send('[]'));
    await row('J JSON invalido sin firma', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json').send('{bad'));
    await row('K 2 MB sin firma', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json').send('{"a":"' + 'x'.repeat(2_000_000) + '"}'));
    await row('L ?query firmado', (s) => request(s).post('/payments/gateway-webhooks?x=1').set('Content-Type', 'application/json').set(headers()).send(PAYLOAD));
    await row('M charset=utf-16 firmado', (s) => request(s).post('/payments/gateway-webhooks').set('Content-Type', 'application/json; charset=utf-16').set(headers()).send(PAYLOAD));
  });
});
