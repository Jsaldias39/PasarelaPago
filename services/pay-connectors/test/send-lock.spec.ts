import { Pool } from 'pg';
import { TEST_DATABASE_URL } from '@pay/testing';
import { withSendLock } from '../src/core/send-lock';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let pool: Pool;
// Pool CHICO a propósito: si los que esperan retuvieran una conexión, el dueño no podría ni registrar su resultado (interbloqueo).
beforeAll(() => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
});
afterAll(async () => pool.end());

describe('withSendLock: un solo envío a la vez por transacción de dinero', () => {
  it.each([1, 2, 3, 4, 5])('corrida %i: 12 envíos simultáneos del mismo id jamás se superponen', async () => {
    let inside = 0;
    let maxInside = 0;
    let order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, (_v, i) =>
        withSendLock(pool, `subject-${process.pid}-same`, async () => {
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
    await Promise.all(['a', 'b', 'c'].map((id) => withSendLock(pool, `subject-${process.pid}-${id}`, async () => { started.push(id); await sleep(60); })));
    expect(started).toHaveLength(3);
  });

  it('el candado se suelta aunque el trabajo falle', async () => {
    const id = `subject-${process.pid}-throws`;
    await expect(withSendLock(pool, id, async () => { throw new Error('falló el proveedor'); })).rejects.toThrow('falló el proveedor');
    await expect(withSendLock(pool, id, async () => 'entró', { timeoutMs: 500 })).resolves.toBe('entró');
  });

  it('si no se consigue en el plazo ⇒ 409 idempotency_request_in_progress (no espera para siempre)', async () => {
    const id = `subject-${process.pid}-slow`;
    const owner = withSendLock(pool, id, async () => sleep(300));
    await sleep(30);
    await expect(withSendLock(pool, id, async () => 'no debería', { timeoutMs: 100, pollMs: 10 })).rejects.toMatchObject({ code: 'idempotency_request_in_progress', status: 409 });
    await owner;
  });
});
