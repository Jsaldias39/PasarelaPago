import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';

/**
 * Sin capacidad para tomar el candado. Es un 500 a propósito y NO un 409/422: `@pay/idempotency` GUARDA y repite toda respuesta 4xx para
 * esa clave, así que un 409 transitorio quedaría como respuesta definitiva y la misma clave jamás completaría. Un 5xx libera la clave.
 * No se llamó al proveedor, pero tampoco se afirma «no se envió» (regla 11): un intento anterior de otro proceso pudo haber llegado.
 */
const busy = () => new ProblemError('internal_error', { detail: 'No hay capacidad para enviar ahora; reintentá con la misma Idempotency-Key' });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Serializa los ENVÍOS al proveedor de una misma transacción de dinero (cobro, reembolso, transferencia): mientras uno llama al
 * proveedor, cualquier otro envío del mismo `subjectId` ESPERA y, al entrar, vuelve a leer el estado que dejó el primero.
 *
 * Candado de sesión de Postgres (`pg_advisory_lock`) sostenido durante TODA la llamada en una conexión de un pool DEDICADO Y PEQUEÑO
 * (`LOCK_POOL`, distinto del pool de datos): el trabajo del dueño usa el pool de datos, así que N envíos distintos a la vez jamás pueden
 * dejarlo sin conexión (sin interbloqueo). Se toma con `pg_try_advisory_lock` y sondeo: el que espera devuelve su conexión entre
 * intentos. Si no hay conexión de candado en el plazo del pool, o no se obtiene el candado en `timeoutMs` ⇒ 500 `internal_error`
 * SIN haber llamado al proveedor (seguro de reintentar con la misma clave; ver `busy`). El candado es de la base
 * a la que apunta el pool: debe ser LA MISMA base de los datos.
 */
export async function withSendLock<T>(pool: Pool, subjectId: string, work: () => Promise<T>, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const pollMs = options.pollMs ?? 15;
  const key = `send:${subjectId}`;
  for (;;) {
    let client;
    try {
      client = await pool.connect();
    } catch {
      // Sin conexión de candado (pool agotado, tiempo vencido, base llena): no se llamó al proveedor, es seguro reintentar.
      throw busy();
    }
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
    if (Date.now() >= deadline) throw busy();
    await sleep(pollMs);
  }
}
