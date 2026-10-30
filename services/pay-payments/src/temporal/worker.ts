import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import type { Deps } from '../deps';
import { createActivities } from './activities';
import { createDisputeActivities, createRefundActivities } from './activities-money';

export interface PaymentsWorker {
  /** Resuelve cuando el worker se detiene. */
  readonly done: Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Worker de Temporal de pay-payments: corre los workflows de cobro, reembolso y disputa y sus activities.
 * `workflowsPath` apunta al TypeScript en pruebas y a `dist/` en producción (el bundler de Temporal acepta los dos).
 */
export async function startPaymentsWorker(deps: Deps, options: { workflowsPath?: string } = {}): Promise<PaymentsWorker> {
  const { temporal } = deps.config;
  // El ciclo de vida es de Nest (y de `worker-main`), no del SDK: por defecto el Runtime atrapa SIGTERM/SIGINT por su cuenta, detiene el
  // worker ANTES de que corra el hook de apagado de Nest y éste fallaba con `IllegalStateError: Not running. Current state: STOPPED`.
  try {
    Runtime.install({ shutdownSignals: [] });
  } catch {
    // Ya hay un Runtime en este proceso (por ejemplo el de una prueba): se usa ese.
  }
  const connection = await NativeConnection.connect({ address: temporal.address });
  const worker = await Worker.create({
    connection,
    namespace: temporal.namespace,
    taskQueue: temporal.taskQueue,
    workflowsPath: options.workflowsPath ?? temporal.workflowsPath ?? require.resolve('./workflows'),
    activities: { ...createActivities(deps), ...createRefundActivities(deps), ...createDisputeActivities(deps) },
  });
  const done = worker.run().finally(() => connection.close());
  return {
    done,
    async shutdown() {
      // Idempotente: apagar un worker que ya se detuvo (o que se está deteniendo) no es un error.
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await done;
    },
  };
}
