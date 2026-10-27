import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serializa los ENVÍOS al proveedor de una misma transacción de dinero (cobro, reembolso, transferencia): mientras uno llama al
 * proveedor, cualquier otro envío del mismo `subjectId` ESPERA y, al entrar, vuelve a leer el estado que dejó el primero.
 *
 * Candado de sesión de Postgres (`pg_advisory_lock`) sostenido en una conexión dedicada durante TODA la llamada. Se toma con
 * `pg_try_advisory_lock` y sondeo: el que espera devuelve su conexión al pool entre intentos, así N esperando no agotan el pool
 * y dejan al dueño sin conexión para registrar su resultado. Si no se obtiene en `timeoutMs` ⇒ 409 `idempotency_request_in_progress`.
 */
export async function withSendLock<T>(pool: Pool, subjectId: string, work: () => Promise<T>, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const pollMs = options.pollMs ?? 15;
  const key = `send:${subjectId}`;
  for (;;) {
    const client = await pool.connect();
    let held = false;
    let broken = false;
    try {
      const got = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [key]);
      if (got.rows[0]?.ok === true) {
        held = true;
        return await work();
      }
    } finally {
      if (held) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        } catch {
          broken = true; // no se pudo soltar: la conexión se descarta (al cerrarse, Postgres libera el candado de sesión)
        }
      }
      client.release(broken ? true : undefined);
    }
    if (Date.now() >= deadline) throw new ProblemError('idempotency_request_in_progress');
    await sleep(pollMs);
  }
}
