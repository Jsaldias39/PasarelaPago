import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';

const logger = new Logger('PgClient');

/**
 * Vigila una conexión sacada del pool (`pool.connect()`). Mientras está prestada, el pool NO escucha sus errores: si Postgres la corta (reinicio,
 * failover, `pg_terminate_backend`) mientras el servicio espera a otro sistema entre dos consultas, la conexión emite `error` sin nadie escuchando y Node
 * mata el proceso. Acá el error solo se registra (únicamente su NOMBRE: el mensaje puede traer la consulta) y la conexión se descarta al devolverla;
 * la operación en curso falla con su propio error en la siguiente consulta.
 */
export function watchClient(client: PoolClient): { readonly dead: () => boolean; release: () => void } {
  let dead = false;
  const onError = (error: Error): void => {
    dead = true;
    logger.warn({ err: error.name }, 'Conexión prestada cortada por Postgres; se descarta al devolverla');
  };
  client.on('error', onError);
  return {
    dead: () => dead,
    release: () => {
      client.removeListener('error', onError);
      client.release(dead ? true : undefined);
    },
  };
}
