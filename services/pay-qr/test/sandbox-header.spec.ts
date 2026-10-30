import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../src/app.module';
import { loadConfig, SERVICE_CONFIG } from '../src/config';
import { PG_POOL } from '../src/database.module';

// D-26 (contracts/openapi/common.yaml, `XPayModeSandbox`): en un despliegue sandbox TODA respuesta lleva `X-Pay-Mode: sandbox`; en live, ninguna.
// Es la cabecera de la RESPUESTA (el despliegue); la de la PETICIÓN (`test|live`, la clave: D-28) es otra y no se toca.
const SQL = [join(process.cwd(), 'sql/ddl.sql')];

let db: IsolatedDatabase;
let sandbox: INestApplication;
let live: INestApplication;
const pools: Pool[] = [];
let seq = 0;
const uniqueKey = () => `key-${process.pid}-${(seq += 1)}-padding`;
const intentId = () => `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`;
const as = (mode: 'test' | 'live') => ({ 'x-service-id': 'pay-connectors', 'x-pay-mode': mode });
const dynamic = () => ({ kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB', amount_minor: 10000, payment_intent_id: intentId(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });

async function build(mode: 'sandbox' | 'live'): Promise<INestApplication> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}`, max: 5 });
  pools.push(pool);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(SERVICE_CONFIG)
    .useValue({ ...loadConfig(), mode })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return app;
}

beforeAll(async () => {
  db = await createIsolatedDatabase(SQL);
  sandbox = await build('sandbox');
  live = await build('live');
});
afterAll(async () => {
  await sandbox.close();
  await live.close();
  await db.drop();
});

/** Un recorrido por todos los tipos de respuesta del servicio: éxito (JSON, PNG, SVG), errores del contrato, rechazos del guard, rutas inexistentes y salud. */
async function walk(app: INestApplication, mode: 'test' | 'live'): Promise<Array<[string, request.Response]>> {
  const http = () => request(app.getHttpServer());
  const out: Array<[string, request.Response]> = [];
  const created = await http().post('/qr').set(as(mode)).set('idempotency-key', uniqueKey()).send(dynamic());
  out.push([`POST /qr (${created.status})`, created]);
  const id = (created.body as { id?: string }).id ?? 'qr_inexistente0001';
  const reference = (created.body as { reference?: string }).reference ?? 'ABC123';
  out.push(['GET /health/live', await http().get('/health/live')]);
  out.push(['GET /health/ready', await http().get('/health/ready')]);
  out.push([`GET /qr/{id} (${mode})`, await http().get(`/qr/${id}`).set(as(mode))]);
  out.push(['GET /qr/{id}/image (png)', await http().get(`/qr/${id}/image`).set(as(mode))]);
  out.push(['GET /qr/{id}/image (svg)', await http().get(`/qr/${id}/image?format=svg`).set(as(mode))]);
  out.push(['GET /qr-references/{ref}', await http().get(`/qr-references/${reference}`).set(as(mode))]);
  out.push(['POST /qr/decode', await http().post('/qr/decode').set(as(mode)).send({ payload: (created.body as { payload?: string }).payload ?? 'x' })]);
  out.push(['POST /qr sin cuerpo válido (422)', await http().post('/qr').set(as(mode)).set('idempotency-key', uniqueKey()).send({})]);
  out.push(['POST /qr sin identidad (403)', await http().post('/qr').set('idempotency-key', uniqueKey()).send({})]);
  out.push(['GET /qr/{id} inexistente (404)', await http().get('/qr/qr_inexistente0001').set(as(mode))]);
  out.push(['ruta que no existe (404)', await http().get('/no/existe').set(as(mode))]);
  return out;
}

describe('X-Pay-Mode: sandbox en las respuestas (pay-qr)', () => {
  it('correcto/límite: en un despliegue sandbox TODA respuesta la lleva (JSON, imágenes, errores, 403, 404, salud)', async () => {
    const responses = await walk(sandbox, 'test');
    expect(responses.find(([name]) => name.startsWith('POST /qr ('))?.[1].status).toBe(201);
    for (const [name, response] of responses) expect([name, response.headers['x-pay-mode']]).toEqual([name, 'sandbox']);
    expect(responses.map(([, r]) => r.status)).toEqual(expect.arrayContaining([200, 201, 403, 404, 422]));
  });

  it('inválido/límite: en un despliegue live NINGUNA respuesta la lleva (ni la salud, ni los errores)', async () => {
    const responses = await walk(live, 'live');
    expect(responses.find(([name]) => name.startsWith('POST /qr ('))?.[1].status).toBe(201);
    for (const [name, response] of responses) expect([name, response.headers['x-pay-mode']]).toEqual([name, undefined]);
  });

  it('la cabecera de la PETICIÓN no la cambia: una clave `live` contra un sandbox es 403 y la respuesta igual dice sandbox', async () => {
    const rejected = await request(sandbox.getHttpServer()).post('/qr').set(as('live')).set('idempotency-key', uniqueKey()).send(dynamic());
    expect(rejected.status).toBe(403);
    expect(rejected.headers['x-pay-mode']).toBe('sandbox');
    for (const mode of ['', 'sandbox', 'TEST']) {
      const response = await request(sandbox.getHttpServer()).get('/qr/qr_inexistente0001').set({ 'x-service-id': 'pay-connectors', 'x-pay-mode': mode });
      expect(response.headers['x-pay-mode']).toBe('sandbox');
    }
  });
});
