import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Ejecuta `work` en una transacción. */
export async function withTx<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Id de evaluación: `ra_` + 16 caracteres `[a-z2-7]` (cumple `^ra_[a-z0-9]{10,40}$`). */
export function newAssessmentId(): string {
  let body = '';
  for (const byte of randomBytes(16)) body += ALPHABET[byte % 32];
  return `ra_${body}`;
}
