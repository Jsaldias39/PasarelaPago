import { Pool, type PoolConfig } from 'pg';
import { guardPool } from './pool-guard';

/**
 * Único lugar donde este servicio crea un `pg.Pool`: nace SIEMPRE con `guardPool` (manejadores de `error` del pool y de cada cliente), para que
 * un corte de Postgres —en una conexión ociosa o en una prestada, a mitad de una transacción— no tumbe el proceso (ver `pool-guard.ts`).
 * Los clientes que prestan `@pay/idempotency` y `@pay/outbox` salen de este mismo pool, así que quedan cubiertos.
 */
export function createPgPool(options: PoolConfig): Pool {
  return guardPool(new Pool(options), 'PgPool');
}
