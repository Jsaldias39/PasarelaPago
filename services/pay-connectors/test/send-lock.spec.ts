import { Pool } from 'pg';
import { TEST_DATABASE_URL } from '@pay/testing';
import { withSendLock } from '../src/core/send-lock';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let pool: Pool; // pool de DATOS (el trabajo)
let locks: Pool; // pool de CANDADOS (dedicado)
// Pools CHICOS a propósito: si el candado le quitara conexiones al trabajo, N envíos distintos a la vez se interbloquearían.
beforeAll(() => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
  locks = new Pool({ connectionString: TEST_DATABASE_URL, max: 3, connectionTimeoutMillis: 5000 });
});
afterAll(async () => {
  await pool.end();
  await locks.end();
});

describe('withSendLock: un solo envío a la vez por transacción de dinero', () => {
  it.each([1, 2, 3, 4, 5])('corrida %i: 12 envíos simultáneos del mismo id jamás se superponen', async () => {
    let inside = 0;
    let maxInside = 0;
    let order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_v, i) =>
        withSendLock(locks, `subject-${process.pid}-same`, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await sleep(5);
          order.push(i);
          // el dueño sigue pudiendo usar el pool aunque haya 11 esperando (no se interbloquea)
          await pool.query('SELECT 1');
          inside -= 1;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(order).toHaveLength(12);
    order = [];
  });

  it('ids distintos no se bloquean entre sí', async () => {
    const started: string[] = [];
    await Promise.all(['a', 'b', 'c'].map((id) => withSendLock(locks, `subject-${process.pid}-${id}`, async () => { started.push(id); await sleep(60); })));
    expect(started).toHaveLength(3);
  });

  it('el candado se suelta aunque el trabajo falle', async () => {
    const id = `subject-${process.pid}-throws`;
    await expect(withSendLock(locks, id, async () => { throw new Error('falló el proveedor'); })).rejects.toThrow('falló el proveedor');
    await expect(withSendLock(locks, id, async () => 'entró', { timeoutMs: 500 })).resolves.toBe('entró');
  });

  it('si no se consigue en el plazo ⇒ 500 (un 4xx quedaría guardado por la clave) y no espera para siempre', async () => {
    const id = `subject-${process.pid}-slow`;
    const owner = withSendLock(locks, id, async () => sleep(300));
    await sleep(30);
    await expect(withSendLock(locks, id, async () => 'no debería', { timeoutMs: 100, pollMs: 10 })).rejects.toMatchObject({ code: 'internal_error', status: 500 });
    await owner;
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: 30 envíos de ids DISTINTOS a la vez con pools de 3 conexiones terminan todos (sin agotar el pool ni interbloquearse)', async () => {
    const done: string[] = [];
    const started = Date.now();
    await Promise.all(
      Array.from({ length: 30 }, (_v, i) =>
        withSendLock(locks, `subject-${process.pid}-many-${i}`, async () => {
          // el trabajo necesita conexiones del pool de DATOS mientras sostiene su candado
          await pool.query('SELECT 1');
          await sleep(10);
          await pool.query('SELECT 2');
          done.push(String(i));
        }),
      ),
    );
    expect(done).toHaveLength(30);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('más envíos distintos que conexiones de candado y poco plazo ⇒ los que no caben fallan con un error DEFINIDO (500, reintentable) sin colgarse, y sin haber hecho el trabajo', async () => {
    const tiny = new Pool({ connectionString: TEST_DATABASE_URL, max: 2, connectionTimeoutMillis: 150 });
    let ran = 0;
    const started = Date.now();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_v, i) =>
          withSendLock(tiny, `subject-${process.pid}-tiny-${i}`, async () => {
            ran += 1;
            await sleep(500);
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(2);
      expect(failed).toHaveLength(4);
      for (const f of failed) expect(f.reason).toMatchObject({ code: 'internal_error', status: 500 });
      expect(ran).toBe(2); // los rechazados NO llegaron a ejecutar el trabajo (no se llamó al proveedor)
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      await tiny.end();
    }
  });
});

