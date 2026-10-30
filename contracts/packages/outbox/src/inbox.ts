import type { PoolLike, Queryable } from './outbox';

/**
 * Efecto único por `(consumidor, evento)`: registra el id y ejecuta `work` **en la misma transacción**.
 * Si `work` falla, el id tampoco queda registrado y el reintento vuelve a procesar. Dos entregas simultáneas
 * del mismo evento se serializan en el índice único: una procesa y la otra ve `'duplicate'`.
 *
 * @param pool - Pool de la base del consumidor.
 * @param consumer - Nombre estable del consumidor (por ejemplo `pay-ledger.payment-succeeded`).
 * @param eventId - `id` del CloudEvent.
 * @param work - Efecto, ejecutado con el cliente de la transacción.
 */
export async function processOnce(
  pool: PoolLike,
  consumer: string,
  eventId: string,
  work: (client: Queryable) => Promise<void>,
): Promise<'processed' | 'duplicate'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      'INSERT INTO inbox_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1',
      [consumer, eventId],
    );
    if (claimed.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    await work(client);
    await client.query('COMMIT');
    return 'processed';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
