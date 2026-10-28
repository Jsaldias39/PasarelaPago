import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Un `pg.Pool` sin manejadores de `error` mata el proceso cuando Postgres corta una conexión (reinicio, failover, `pg_terminate_backend`):
 * Node trata un `error` sin escuchas como excepción no capturada. Hay dos caminos y los dos se cubren acá:
 *
 * 1. Conexión OCIOSA: el pool emite `error` y descarta el cliente; el siguiente `query`/`connect` abre otro. Se avisa SOLO con el nombre del error.
 * 2. Conexión PRESTADA (`pool.connect()`: transacciones, candados): el pool le quita su escucha mientras está en uso, así que el `error` del cliente
 *    cuando la conexión termina queda sin manejador. A quien tenía la consulta en vuelo ya le llega el rechazo (y responde con un error del contrato);
 *    este manejador solo evita que el evento tumbe el proceso. El cliente no vuelve a usarse: el pool lo descarta al devolverlo con error.
 *
 * Nunca se registra `error.message`: puede traer el host, el rol o el texto de la consulta.
 */
export function guardPool(pool: Pool, context: string): Pool {
  const logger = new Logger(context);
  // pool.on('error', (error) => logger.warn({ err: error.name }, 'Conexión ociosa cortada por Postgres; el pool la repone'));
  pool.on('connect', (client) => {
    client.on('error', () => undefined);
  });
  return pool;
}
