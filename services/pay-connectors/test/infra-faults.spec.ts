import request from 'supertest';
import type { Pool } from 'pg';
import { MockConnector } from '../src/connectors/mock/mock.connector';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { LOCK_POOL, REGISTRY } from '../src/core/tokens';
import { PG_POOL } from '../src/database.module';
import type { ConnectorRegistry } from '../src/domain/registry';
import { asPayments, asSettlement, chargeBody, createTestApp, post, uniqueKey, type TestApp } from './support/app';
import { outboxEvents } from './support/events';

// Inyección de fallos de INFRAESTRUCTURA (no del producto): la base rechaza conexiones como lo haría un Postgres compartido casi lleno
// («sorry, too many clients already», SQLSTATE 53300). Es el único camino por el que una entrega puede no ser `applied` ni `duplicate`.
let t: TestApp;
let bank: SimulatedBank;
let mock: MockConnector;
let seq = 0;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get<SimulatedBank>(SIMULATED_BANK);
  mock = t.app.get<ConnectorRegistry>(REGISTRY).get('mock') as MockConnector;
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

type Connect = (cb?: (err: Error | undefined, client?: unknown, done?: () => void) => void) => unknown;

/** Hace fallar una de cada `every` conexiones. Devuelve la función que lo apaga. */
function injectConnectionFaults(pools: Pool[], every: number): () => void {
  const originals = pools.map((p) => (p as unknown as { connect: Connect }).connect);
  let n = 0;
  pools.forEach((pool, i) => {
    (pool as unknown as { connect: Connect }).connect = function (this: unknown, cb) {
      n += 1;
      if (n % every === 0) {
        const error = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
        if (typeof cb === 'function') {
          cb(error);
          return undefined;
        }
        return Promise.reject(error);
      }
      return (originals[i] as Connect).call(pool, cb);
    };
  });
  return () => pools.forEach((pool, i) => ((pool as unknown as { connect: Connect }).connect = originals[i] as Connect));
}

describe('fallos de infraestructura bajo contención: nunca un resultado inventado, y reintentar converge', () => {
  it.each([1, 2, 3, 4, 5])('corrida %i: 12 callbacks idénticos con una de cada 3 conexiones rechazada ⇒ cada respuesta es applied, duplicate o 500; reentregar converge a UN solo avance y UN evento', async () => {
    await t.reset();
    const created = await post(t.app, '/charges', chargeBody({}, t.clock), asPayments, uniqueKey());
    const [callback] = bank.dueCallbacks(t.clock.now()).filter((c) => c.reference === created.body.id);
    const signed = await mock.signCallback(callback as NonNullable<typeof callback>, t.clock.now());
    const deliver = () => request(t.app.getHttpServer()).post('/callbacks/mock').set(signed.headers).set('content-type', 'application/json').send(signed.rawBody.toString('utf8')).then((r) => r);

    const off = injectConnectionFaults([t.app.get<Pool>(PG_POOL)], 3);
    let first;
    try {
      first = await Promise.all(Array.from({ length: 12 }, deliver));
    } finally {
      off();
    }
    const outcomes = first.map((r) => (r.status === 200 ? (r.body.result as string) : `${r.status}:${r.body.code}`));
    for (const o of outcomes) expect(['applied', 'duplicate', '500:internal_error']).toContain(o);
    expect(outcomes.some((o) => o === '500:internal_error')).toBe(true); // la inyección sí mordió
    for (const r of first.filter((x) => x.status === 500)) expect(JSON.stringify(r.body)).not.toMatch(/too many clients|53300/); // el error de la base no sale al proveedor

    // El proveedor reintenta lo que no recibió 200 (es lo que hace un proveedor real ante un 5xx).
    const retried = await Promise.all(first.filter((r) => r.status !== 200).map(deliver));
    const all = [...first.filter((r) => r.status === 200), ...retried];
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(all.filter((r) => r.body.result === 'applied')).toHaveLength(1);
    expect(all.filter((r) => r.body.result === 'duplicate')).toHaveLength(11);
    expect(await outboxEvents(t.db.pool, 'connector.transaction.status_changed')).toHaveLength(1);
    expect((await t.db.pool.query('SELECT provider_status FROM connector_charges')).rows[0].provider_status).toBe('captured');
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: 10 pedidos simultáneos del mismo par de transferencia con conexiones rechazadas (datos y candados) ⇒ nada inventado, UNA orden en el proveedor, converge a `paid`', async () => {
    await t.reset();
    const b = { business_ref: `po_fault${process.pid}${(seq += 1)}:payout`, attempt: 1, connector: 'mock', amount_minor: 250000, currency: 'BOB', destination_ref: 'dest_comercio_0001' };
    const off = injectConnectionFaults([t.app.get<Pool>(PG_POOL), t.app.get<Pool>(LOCK_POOL)], 4);
    let first;
    try {
      first = await Promise.all(Array.from({ length: 10 }, () => post(t.app, '/transfers', b, asSettlement, uniqueKey()).then((r) => r)));
    } finally {
      off();
    }
    for (const r of first) {
      expect([200, 201, 500]).toContain(r.status);
      if (r.status === 500) expect(r.body.code).not.toBe('connector_unavailable'); // ambiguo/infra: jamás «no se envió»
    }
    // Reintento sin fallos: converge, y ninguna fila desapareció ni se duplicó la orden.
    const done = await post(t.app, '/transfers', b, asSettlement, uniqueKey());
    expect([200, 201]).toContain(done.status);
    expect(done.body.status).toBe('paid');
    const rows = (await t.db.pool.query('SELECT status FROM connector_transfers')).rows;
    expect(rows).toEqual([{ status: 'paid' }]);
    expect(bank.transferCount()).toBe(1);
  });
});
