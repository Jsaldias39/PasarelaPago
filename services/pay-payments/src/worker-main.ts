import 'reflect-metadata';
import { Pool } from 'pg';
import { loadConfig } from './config';
import { createDeps } from './deps';
import { startPaymentsWorker } from './temporal/worker';

/**
 * Proceso del worker de Temporal, separado de la API (`TEMPORAL_RUN_WORKER=false` en la API). Escala y se reinicia aparte:
 * si cae, Temporal reintenta las activities en otro worker y el cobro sigue (REQ-P3-4).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new Pool({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.name, max: 10, application_name: 'pay-payments-worker' });
  const worker = await startPaymentsWorker(createDeps(pool, config));
  const stop = () => void worker.shutdown().then(() => pool.end());
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.write(`WORKER_READY pid=${process.pid} queue=${config.temporal.taskQueue}\n`);
  await worker.done;
}

main().catch((error: unknown) => {
  // Solo nombre y mensaje: nada de objetos con datos.
  process.stderr.write(`WORKER_ERROR ${(error as Error).name}: ${(error as Error).message}\n`);
  process.exit(1);
});
