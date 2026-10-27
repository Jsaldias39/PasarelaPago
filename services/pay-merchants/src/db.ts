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

/** Id con prefijo: `mc_` + 16 caracteres `[a-z2-7]` (cumple `^<prefijo>_[a-z0-9]{10,40}$`). */
export function newId(prefix: 'mc' | 'kd' | 'ca'): string {
  let body = '';
  for (const byte of randomBytes(16)) body += ALPHABET[byte % 32];
  return `${prefix}_${body}`;
}

/** Código SQLSTATE de un error de `pg`, si lo es. */
export function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}
