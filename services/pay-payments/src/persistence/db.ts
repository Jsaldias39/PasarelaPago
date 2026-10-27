import type { Queryable } from '@pay/idempotency';

export type Db = Queryable;

/** Ejecuta `work` en una transacción de un cliente del pool y la confirma o deshace. */
export interface TxRunner {
  <T>(work: (client: Db) => Promise<T>): Promise<T>;
}

type PoolLike = { connect(): Promise<Db & { release(): void }> };

export const txRunner =
  (pool: PoolLike): TxRunner =>
  async <T>(work: (client: Db) => Promise<T>): Promise<T> => {
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
  };

export const num = (value: unknown): number => Number(value);
