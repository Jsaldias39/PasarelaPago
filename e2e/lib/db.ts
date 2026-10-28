import { Client } from 'pg';
import type { Stack } from '../stack.ts';

/**
 * Lectura de apoyo de las pruebas sobre la base de UN servicio del stack, con el rol propio de ese servicio (el mismo que usa el arnés al sembrar,
 * ver `scheduleDb` en p5-schedules.ts). `short` es el nombre sin el prefijo (`payments`, `connectors`, `mockbank`…). Solo se la usa para LEER y
 * contar efectos («exactamente una fila»); nunca para corregir un dato (regla 97.1.5).
 */
export async function serviceDb<T>(stack: Stack, short: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: stack.infra.postgres.host, port: stack.infra.postgres.port, database: `pay_${short}`, user: `pay_${short}`, password: `dev_only_${short}` });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}
