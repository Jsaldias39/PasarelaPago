import { join } from 'node:path';
import { createIsolatedDatabase, type IsolatedDatabase } from '@pay/testing';
import { ProblemError } from '@pay/problem';
import { hashRequest, IdempotencyStore, canonicalJson } from './index';

const SQL = join(__dirname, '../sql/001_idempotency_keys.sql');
let db: IsolatedDatabase;

beforeAll(async () => {
  db = await createIsolatedDatabase([SQL]);
  await db.pool.query('CREATE TABLE effects (id serial PRIMARY KEY, label text NOT NULL)');
});
afterAll(async () => db.drop());

const hash = hashRequest({ method: 'POST', path: '/v1/payment_intents', body: { amount_minor: 10000 } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = async (label: string) =>
  Number((await db.pool.query('SELECT count(*)::int AS n FROM effects WHERE label = $1', [label])).rows[0].n);

async function expectProblem(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('IdempotencyStore (contra Postgres real)', () => {
  it('REQ-P1: 50 peticiones concurrentes con la misma clave → UNA sola ejecución y la misma respuesta', async () => {
    const store = new IdempotencyStore(db.pool, { waitForCompletionMs: 5000 });
    const request = { scope: 'merchant_A', key: 'key-concurrent', requestHash: hash };
    const handler = async () => {
      await sleep(150); // ventana para que las 49 restantes encuentren la clave `started`
      await db.pool.query("INSERT INTO effects (label) VALUES ('concurrent')");
      return { status: 201, body: { id: 'pi_1', amount_minor: 10000 } };
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => store.execute(request, handler)));

    expect(await count('concurrent')).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(49);
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(r.body).toEqual({ id: 'pi_1', amount_minor: 10000 });
    }
  });

  it('sin espera, las concurrentes reciben 409 y ninguna ejecuta dos veces', async () => {
    const store = new IdempotencyStore(db.pool);
    const request = { scope: 'merchant_A', key: 'key-409', requestHash: hash };
    const handler = async () => {
      await sleep(200);
      await db.pool.query("INSERT INTO effects (label) VALUES ('409')");
      return { status: 201, body: { ok: true } };
    };
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => store.execute(request, handler)));

    expect(await count('409')).toBe(1);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ProblemError);
      expect(r.reason.code).toBe('idempotency_request_in_progress');
      expect(r.reason.status).toBe(409);
    }
    // Una vez terminada, el reintento repite la respuesta sin ejecutar.
    const again = await store.execute(request, handler);
    expect(again).toMatchObject({ status: 201, replayed: true });
    expect(await count('409')).toBe(1);
  });

  it('REQ-P3-1: la misma clave con OTRO pedido → 422 idempotency_key_reused y no ejecuta', async () => {
    const store = new IdempotencyStore(db.pool);
    await store.execute({ scope: 'merchant_A', key: 'key-reuse', requestHash: hash }, async () => ({ status: 201, body: {} }));
    const other = hashRequest({ method: 'POST', path: '/v1/payment_intents', body: { amount_minor: 99 } });
    const handler = jest.fn();
    await expectProblem(store.execute({ scope: 'merchant_A', key: 'key-reuse', requestHash: other }, handler), 'idempotency_key_reused');
    expect(handler).not.toHaveBeenCalled();
  });

  it('el mismo key en otro scope (otro comercio) es independiente', async () => {
    const store = new IdempotencyStore(db.pool);
    const handler = async () => {
      await db.pool.query("INSERT INTO effects (label) VALUES ('scopes')");
      return { status: 201, body: {} };
    };
    await store.execute({ scope: 'merchant_A', key: 'shared', requestHash: hash }, handler);
    await store.execute({ scope: 'merchant_B', key: 'shared', requestHash: hash }, handler);
    expect(await count('scopes')).toBe(2);
  });

  it('un error de negocio determinista (4xx) se guarda y se repite sin volver a ejecutar', async () => {
    const store = new IdempotencyStore(db.pool);
    const request = { scope: 'merchant_A', key: 'key-4xx', requestHash: hash };
    const handler = jest.fn(async () => {
      throw new ProblemError('insufficient_funds', { detail: 'Saldo menor al débito' });
    });
    const first = await store.execute(request, handler);
    const second = await store.execute(request, handler);
    expect(first).toMatchObject({ status: 422, replayed: false });
    expect(second).toMatchObject({ status: 422, replayed: true });
    expect(second.body).toMatchObject({ code: 'insufficient_funds' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe('recuperación ante caídas', () => {
    it('un error inesperado libera el bloqueo y el reintento retoma desde el último punto, sin repetir lo ya hecho', async () => {
      const store = new IdempotencyStore(db.pool);
      const request = { scope: 'merchant_A', key: 'key-crash', requestHash: hash };
      const run = async (crashAfterCharge: boolean) =>
        store.execute(request, async (ctx) => {
          if (ctx.recoveryPoint === 'started') {
            await ctx.atomic('charged', async (client) => {
              await client.query("INSERT INTO effects (label) VALUES ('charge')");
            });
          }
          if (crashAfterCharge) throw new Error('el proceso murió');
          await ctx.atomic('ledgered', async (client) => {
            await client.query("INSERT INTO effects (label) VALUES ('ledger')");
          });
          return { status: 201, body: { done: true } };
        });

      await expect(run(true)).rejects.toThrow('el proceso murió');
      expect(await count('charge')).toBe(1);

      const resumed = await run(false);
      expect(resumed).toMatchObject({ status: 201, replayed: false });
      expect(await count('charge')).toBe(1); // el cobro NO se repitió
      expect(await count('ledger')).toBe(1);
    });

    it('una fase atómica que falla deshace su trabajo y NO avanza el punto de recuperación', async () => {
      const store = new IdempotencyStore(db.pool);
      const request = { scope: 'merchant_A', key: 'key-atomic', requestHash: hash };
      await expect(
        store.execute(request, async (ctx) => {
          await ctx.atomic('half', async (client) => {
            await client.query("INSERT INTO effects (label) VALUES ('atomic')");
            throw new Error('falla a mitad de la fase');
          });
          return { status: 201, body: {} };
        }),
      ).rejects.toThrow('falla a mitad');
      expect(await count('atomic')).toBe(0);
      const row = (await db.pool.query("SELECT recovery_point FROM idempotency_keys WHERE key = 'key-atomic'")).rows[0];
      expect(row.recovery_point).toBe('started');
    });

    it('un bloqueo vencido (proceso muerto sin liberar) lo retoma otra petición, y solo una', async () => {
      const store = new IdempotencyStore(db.pool, { lockTimeoutMs: 1000, waitForCompletionMs: 0 });
      const request = { scope: 'merchant_A', key: 'key-stale', requestHash: hash };
      // Simula un proceso que reclamó la clave, avanzó hasta 'charged' y murió sin liberar.
      await db.pool.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash, state, recovery_point, locked_at, expires_at)
         VALUES ('merchant_A', 'key-stale', $1, 'started', 'charged', now() - interval '1 hour', now() + interval '1 day')`,
        [hash],
      );
      const seen: string[] = [];
      const handler = async (ctx: { recoveryPoint: string }) => {
        seen.push(ctx.recoveryPoint);
        await sleep(100);
        await db.pool.query("INSERT INTO effects (label) VALUES ('stale')");
        return { status: 201, body: { resumed: true } };
      };
      const settled = await Promise.allSettled(Array.from({ length: 10 }, () => store.execute(request, handler)));
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      expect(seen).toEqual(['charged']);
      expect(await count('stale')).toBe(1);
    });
  });

  it('una clave vencida deja de proteger y se puede reutilizar; purgeExpired la borra', async () => {
    const store = new IdempotencyStore(db.pool);
    await db.pool.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, state, response_status, response_body, expires_at)
       VALUES ('merchant_A', 'key-expired', 'otro', 'completed', 201, '{}', now() - interval '1 minute')`,
    );
    const fresh = await store.execute({ scope: 'merchant_A', key: 'key-expired', requestHash: hash }, async () => ({
      status: 201,
      body: { nuevo: true },
    }));
    expect(fresh.replayed).toBe(false);

    await db.pool.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, state, expires_at)
       VALUES ('merchant_A', 'key-old', 'x', 'started', now() - interval '1 day')`,
    );
    expect(await store.purgeExpired()).toBeGreaterThanOrEqual(1);
  });

  describe('hashRequest / canonicalJson', () => {
    it('no depende del orden de las claves ni de los undefined', () => {
      expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] }, u: undefined })).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
      const a = hashRequest({ method: 'post', path: '/x', body: { a: 1, b: 2 } });
      const b = hashRequest({ method: 'POST', path: '/x', body: { b: 2, a: 1 } });
      expect(a).toBe(b);
    });
    it('cambia con el método, la ruta o el cuerpo', () => {
      const base = hashRequest({ method: 'POST', path: '/x', body: { a: 1 } });
      expect(hashRequest({ method: 'PUT', path: '/x', body: { a: 1 } })).not.toBe(base);
      expect(hashRequest({ method: 'POST', path: '/y', body: { a: 1 } })).not.toBe(base);
      expect(hashRequest({ method: 'POST', path: '/x', body: { a: 2 } })).not.toBe(base);
    });
  });
});
