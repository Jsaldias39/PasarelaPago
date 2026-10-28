import request from 'supertest';
import type { Pool } from 'pg';
import { PG_POOL } from '../src/database.module';
import { asPayments, chargeBody, createTestApp, uniqueKey, type TestApp } from './support/app';

// Gate «Fallos»: la base propia se CAE por completo a mitad de servicio (complementa `infra-faults.spec.ts`, que prueba contención parcial).
// Nunca un resultado inventado, nunca un detalle interno en la respuesta, la salud lo dice (503) y, al volver, reintentar con la misma clave converge.
const LEAK = 'password=SECRETO-DE-LA-BASE host=10.0.0.5 SELECT * FROM connector_charges';
let t: TestApp;
let pool: Pool;
let restore: (() => void) | undefined;

beforeAll(async () => {
  t = await createTestApp();
  pool = t.app.get<Pool>(PG_POOL);
});
afterAll(async () => {
  restore?.();
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** [DOBLE] La base «se cae»: query y connect del pool propio fallan con un mensaje que NO debe salir al cliente. */
function bringDown(): void {
  const original = { query: pool.query.bind(pool), connect: pool.connect.bind(pool) };
  const fail = () => Promise.reject(Object.assign(new Error(`connection terminated unexpectedly: ${LEAK}`), { code: '57P01' }));
  (pool as unknown as { query: unknown }).query = fail;
  (pool as unknown as { connect: unknown }).connect = fail;
  restore = () => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
  };
}

describe('base propia caída a mitad de servicio', () => {
  it('cada operación responde 5xx del contrato sin filtrar la cadena de conexión, el SQL ni la pila; la salud lo dice (503) y el proceso sigue vivo', async () => {
    const http = () => request(t.app.getHttpServer());
    bringDown();
    const responses = [
      await http().post('/charges').set(asPayments).set('idempotency-key', uniqueKey()).send(chargeBody({}, t.clock)),
      await http().get('/charges/ch_abcdefghij12').set(asPayments),
      await http().get('/charges/ch_abcdefghij12/status').set(asPayments),
      await http().get('/connectors/health').set(asPayments),
    ];
    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(response.body) + response.text).not.toMatch(/SECRETO|10\.0\.0\.5|SELECT|connector_charges|terminated|at Object|\.ts:/);
    }
    expect((await http().get('/health/ready')).status).toBe(503);
    expect((await http().get('/health/live')).status).toBe(200);
  });

  it('al volver la base, REINTENTAR con la misma Idempotency-Key converge: UN solo cobro, y repetirlo devuelve el mismo', async () => {
    const body = chargeBody({}, t.clock);
    const key = uniqueKey();
    bringDown();
    expect((await request(t.app.getHttpServer()).post('/charges').set(asPayments).set('idempotency-key', key).send(body as object)).status).toBeGreaterThanOrEqual(500);
    restore?.();
    restore = undefined;
    const retry = await request(t.app.getHttpServer()).post('/charges').set(asPayments).set('idempotency-key', key).send(body as object);
    expect(retry.status).toBe(201);
    const again = await request(t.app.getHttpServer()).post('/charges').set(asPayments).set('idempotency-key', key).send(body as object);
    expect(again.body.id).toBe(retry.body.id);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM connector_charges')).rows[0].n).toBe(1);
    expect((await request(t.app.getHttpServer()).get('/health/ready')).status).toBe(200);
  });
});
