import request from 'supertest';
import type { Pool } from 'pg';
import { asConnectors, chargeBody, createTestApp, type TestApp } from './support/app';

// Gate «Fallos»: la base propia se cae a mitad de servicio. Nunca un resultado inventado, nunca un detalle interno en la respuesta, y al volver, reintentar converge.
let broken = false;
const LEAK = 'password=SECRETO-DE-LA-BASE host=10.0.0.5 SELECT * FROM mb_charges';
/** [DOBLE] Pool que, mientras `broken`, falla como una conexión caída (con un mensaje que NO debe salir al cliente). */
const flaky = (pool: Pool): Pool =>
  new Proxy(pool, {
    get(target, prop, receiver) {
      if (broken && (prop === 'query' || prop === 'connect')) return () => Promise.reject(Object.assign(new Error(`connection terminated unexpectedly: ${LEAK}`), { code: '57P01' }));
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ wrapPool: flaky });
});
afterAll(async () => {
  broken = false;
  await t.close();
});
afterEach(() => {
  broken = false;
});
beforeEach(async () => {
  await t.reset();
});

describe('base propia caída a mitad de servicio', () => {
  it('cada operación responde 500 `internal_error` sin filtrar la cadena de conexión, el SQL ni la pila; la salud lo dice (503) y el proceso sigue vivo', async () => {
    const http = () => request(t.app.getHttpServer());
    broken = true;
    const body = chargeBody({}, t.clock);
    const responses = [
      await http().post('/sandbox/charges').set(asConnectors).send(body as object),
      await http().get(`/sandbox/charges/${body.reference as string}`).set(asConnectors),
      await http().post('/sandbox/transfers').set(asConnectors).send({ reference: 'po_x:payout:1', amount_minor: 5000, destination_ref: 'dest_1' }),
      await http().get(`/sandbox/statement?from=${new Date(0).toISOString()}&to=${new Date().toISOString()}`).set(asConnectors),
      await http().get('/sandbox/probe').set(asConnectors),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(response.body.code).toBe('internal_error');
      expect(response.headers['x-pay-mode']).toBe('sandbox');
      const text = JSON.stringify(response.body) + response.text;
      expect(text).not.toMatch(/SECRETO|10\.0\.0\.5|SELECT|mb_charges|terminated|at Object|\.ts:/);
    }
    expect((await http().get('/health/ready')).status).toBe(503);
    expect((await http().get('/health/live')).status).toBe(200);
  });

  it('al volver la base, REINTENTAR con la misma referencia converge: UN solo cobro, sin duplicados ni residuos', async () => {
    const body = chargeBody({ amount_minor: 10000 }, t.clock);
    broken = true;
    expect((await request(t.app.getHttpServer()).post('/sandbox/charges').set(asConnectors).send(body as object)).status).toBe(500);
    broken = false;
    const retry = await request(t.app.getHttpServer()).post('/sandbox/charges').set(asConnectors).send(body as object);
    expect(retry.status).toBe(201);
    const again = await request(t.app.getHttpServer()).post('/sandbox/charges').set(asConnectors).send(body as object);
    expect(again.status).toBe(200);
    expect(again.body.bank_reference).toBe(retry.body.bank_reference);
    expect((await t.db.pool.query('SELECT count(*)::int AS n FROM mb_charges WHERE reference = $1', [body.reference])).rows[0].n).toBe(1);
    expect((await request(t.app.getHttpServer()).get('/health/ready')).status).toBe(200);
  });

  it('un callback que no se puede entregar porque el receptor está caído NO se pierde: queda pendiente y sale cuando vuelve (ya probado en delivery.spec); aquí, la base caída tampoco rompe el ciclo de entrega', async () => {
    const body = chargeBody({}, t.clock);
    await request(t.app.getHttpServer()).post('/sandbox/charges').set(asConnectors).send(body as object);
    broken = true;
    const attempt = await request(t.app.getHttpServer()).post('/sandbox/admin/deliver').set({ 'x-service-id': 'pay-mockbank' });
    expect(attempt.status).toBe(500);
    expect(JSON.stringify(attempt.body)).not.toMatch(/SECRETO|SELECT/);
    broken = false;
    const ok = await request(t.app.getHttpServer()).post('/sandbox/admin/deliver').set({ 'x-service-id': 'pay-mockbank' });
    expect(ok.body).toEqual({ delivered: 1, failed: 0 });
  });
});
