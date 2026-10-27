import type { Pool, PoolClient } from 'pg';

/** Corre `work` en una transacción: o pasa todo (incluido el `enqueue` del outbox) o nada. */
export async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** SQLSTATE de violación de unicidad (`unique_violation`) y, si hay, el índice que la causó. */
export function uniqueViolation(error: unknown): { constraint: string | undefined } | null {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' ? { constraint: e.constraint } : null;
}
