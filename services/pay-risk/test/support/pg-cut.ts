import { execFileSync } from 'node:child_process';
import type { Pool } from 'pg';

/** Un backend de Postgres que pertenece al proceso de servicio que se está probando (no a otra suite que corra a la vez con el mismo rol). */
export interface Backend {
  readonly pid: number;
  readonly applicationName: string;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly query: string;
}

/** Puertos locales de las conexiones TCP que el proceso `pid` tiene abiertas contra Postgres (`lsof`, sin tocar el código del servicio). */
function localPorts(pid: number, dbPort: string): number[] {
  let output = '';
  try {
    output = execFileSync('lsof', ['-a', '-nP', '-p', String(pid), `-iTCP:${dbPort}`, '-Fn'], { encoding: 'utf8' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Estas pruebas necesitan `lsof` para saber qué conexiones de Postgres son del proceso bajo prueba');
    return []; // lsof sale con 1 cuando no hay ninguna conexión abierta
  }
  return output
    .split('\n')
    .filter((line) => line.startsWith('n') && line.includes('->'))
    .map((line) => Number(/:(\d+)->/.exec(line)?.[1]))
    .filter((port) => Number.isInteger(port));
}

/** Backends de Postgres del proceso `pid`, vistos desde una conexión administrativa del mismo rol. */
export async function backendsOf(admin: Pool, pid: number, dbPort: string): Promise<Backend[]> {
  const ports = localPorts(pid, dbPort);
  if (ports.length === 0) return [];
  const found = await admin.query(
    `SELECT pid, application_name AS "applicationName", state, wait_event_type AS "waitEventType", query FROM pg_stat_activity WHERE datname = current_database() AND client_port = ANY($1::int[])`,
    [ports],
  );
  return found.rows as Backend[];
}

/** Corta un backend como lo haría un reinicio o un failover: `pg_terminate_backend`. */
export async function terminate(admin: Pool, pids: readonly number[]): Promise<void> {
  for (const pid of pids) await admin.query('SELECT pg_terminate_backend($1)', [pid]);
}

/**
 * Dirección REAL de Postgres (`inet_server_addr()`/`inet_server_port()`). Cuando Postgres corre en Docker con el puerto publicado por `docker-proxy`, el
 * servidor ve el puerto de ORIGEN del proxy y no el del proceso: no se puede saber de quién es cada backend. Conectando el proceso de servicio
 * directo a esa dirección, el puerto local que ve `lsof` es el mismo que ve `pg_stat_activity.client_port`.
 */
export async function directAddress(admin: Pool): Promise<{ host: string; port: string }> {
  const found = await admin.query('SELECT host(inet_server_addr()) AS host, inet_server_port()::text AS port');
  return found.rows[0] as { host: string; port: string };
}
