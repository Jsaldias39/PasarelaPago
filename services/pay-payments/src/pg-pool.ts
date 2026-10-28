import { Logger } from '@nestjs/common';
import { Pool, type PoolConfig } from 'pg';

/**
 * Único lugar donde este servicio crea un `pg.Pool`.
 *
 * Si Postgres corta una conexión OCIOSA (reinicio, failover, `pg_terminate_backend`, un balanceador) el pool emite `error`; sin manejador Node lo trata
 * como excepción no capturada y el proceso muere (defecto hallado por P5 en `pay-merchants`). Con el manejador el pool descarta esa conexión y abre
 * otra en la siguiente consulta. Una consulta EN CURSO cuya conexión se corta no pasa por aquí: su promesa rechaza con el error de `pg` y la maneja
 * quien consultó (el filtro de problemas la convierte en `500 internal_error`).
 *
 * El aviso lleva SOLO el nombre del error: el mensaje y el SQL pueden traer valores (regla 90.2.1).
 */
export function createPgPool(options: PoolConfig): Pool {
  const pool = new Pool(options);
  pool.on('error', (error) => new Logger('PgPool').warn({ err: error.name }, 'Conexión ociosa cortada por Postgres; el pool la repone'));
  return pool;
}
