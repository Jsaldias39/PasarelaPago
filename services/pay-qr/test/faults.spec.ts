import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { createIsolatedDatabase, TEST_DATABASE_URL, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../src/app.module';
import { loadConfig, SERVICE_CONFIG } from '../src/config';
import { PG_POOL } from '../src/database.module';

// Gate «Fallos»: la base propia se cae a mitad de servicio. Nunca un resultado inventado, nunca un detalle interno en la respuesta, y al volver, reintentar converge.
const REPO = join(process.cwd(), '../..');
const SQL = [join(process.cwd(), 'sql/001_qr_codes.sql'), join(REPO, 'contracts/packages/idempotency/sql/001_idempotency_keys.sql')];
const LEAK = 'password=SECRETO-DE-LA-BASE host=10.0.0.5 SELECT * FROM qr_codes';
let broken = false;
/** [DOBLE] Pool que, mientras `broken`, falla como una conexión caída (con un mensaje que NO debe salir al cliente). */
const flaky = (pool: Pool): Pool =>
  new Proxy(pool, {
    get(target, prop, receiver) {
      if (broken && (prop === 'query' || prop === 'connect')) return () => Promise.reject(Object.assign(new Error(`connection terminated unexpectedly: ${LEAK}`), { code: '57P01' }));
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

let db: IsolatedDatabase;
let app: INestApplication;
let appPool: Pool;
let seq = 0;
const uniqueKey = () => `key-${process.pid}-${(seq += 1)}-padding`;
const intentId = () => `pi_${String(Date.now()).slice(-8)}${String((seq += 1)).padStart(4, '0')}xyz`;
const as = { 'x-service-id': 'pay-connectors', 'x-pay-mode': 'test' };
const dynamic = () => ({ kind: 'dynamic', merchant_id: 'mc_clinicasantacruz1', merchant_name: 'Clínica Santa María', merchant_city: 'Santa Cruz', currency: 'BOB', amount_minor: 10000, payment_intent_id: intentId(), expires_at: new Date(Date.now() + 3_600_000).toISOString() });

beforeAll(async () => {
  db = await createIsolatedDatabase(SQL);
  appPool = new Pool({ connectionString: TEST_DATABASE_URL, options: `-c search_path=${db.schema}`, max: 10 });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PG_POOL)
    .useValue(flaky(appPool))
    .overrideProvider(SERVICE_CONFIG)
    .useValue(loadConfig())
    .compile();
  app = moduleRef.createNestApplication();
  await app.listen(0);
});
afterAll(async () => {
  broken = false;
  await app.close();
  await db.drop();
});
afterEach(() => {
  broken = false;
});

describe('base propia caída a mitad de servicio', () => {
  it('cada operación responde 500 `internal_error` sin filtrar la cadena de conexión, el SQL ni la pila; la salud lo dice (503) y el proceso sigue vivo', async () => {
    const http = () => request(app.getHttpServer());
    broken = true;
    const responses = [
      await http().post('/qr').set(as).set('idempotency-key', uniqueKey()).send(dynamic()),
      await http().get('/qr/qr_abcdefghij12').set(as),
      await http().get('/qr-references/ABC123').set(as),
      await http().post('/qr/qr_abcdefghij12/cancel').set(as).set('idempotency-key', uniqueKey()).send({}),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('internal_error');
      expect(JSON.stringify(response.body) + response.text).not.toMatch(/SECRETO|10\.0\.0\.5|SELECT|qr_codes|terminated|at Object|\.ts:/);
    }
    expect((await http().get('/health/ready')).status).toBe(503);
    expect((await http().get('/health/live')).status).toBe(200);
    // La decodificación no usa la base: sigue sirviendo con la base caída (no depende de ella).
    const payload = '00020101021226280004test0105ABC1252040000530306854050.005802BO5904Test6004City63041234';
    expect((await http().post('/qr/decode').set(as).send({ payload })).status).not.toBe(500);
  });

  it('al volver la base, REINTENTAR con la misma Idempotency-Key converge: UN solo QR, y un reintento posterior devuelve el mismo', async () => {
    const body = dynamic();
    const key = uniqueKey();
    broken = true;
    expect((await request(app.getHttpServer()).post('/qr').set(as).set('idempotency-key', key).send(body)).status).toBe(500);
    broken = false;
    const retry = await request(app.getHttpServer()).post('/qr').set(as).set('idempotency-key', key).send(body);
    expect(retry.status).toBe(201);
    const again = await request(app.getHttpServer()).post('/qr').set(as).set('idempotency-key', key).send(body);
    expect(again.body.id).toBe(retry.body.id);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM qr_codes WHERE payment_intent_id = $1', [body.payment_intent_id])).rows[0].n).toBe(1);
    expect((await request(app.getHttpServer()).get('/health/ready')).status).toBe(200);
  });
});
