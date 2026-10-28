import type { Pool, PoolClient } from 'pg';
import { watchClient } from '../pg-client';

/** Ejecuta `work` en una transacción de Postgres: commit si termina, rollback si lanza. */
export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const watch = watchClient(client);
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Si la conexión murió, el ROLLBACK falla y taparía el error de verdad (Postgres ya deshizo la transacción al cortar).
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    watch.release();
  }
}
