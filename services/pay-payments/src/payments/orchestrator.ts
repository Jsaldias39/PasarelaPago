import { Client, Connection, WorkflowIdReusePolicy } from '@temporalio/client';
import { workflowIds, type ChargeSignal } from '../temporal/types';

/** Costura hacia Temporal: el servicio no conoce su cliente, así las pruebas pueden sustituirla y los errores se traducen acá. */
export interface PaymentOrchestrator {
  startPayment(intentId: string): Promise<void>;
  /** @returns `no_workflow` si el cobro no tiene un workflow en curso (ya terminó o nunca arrancó). */
  signalCharge(intentId: string, signal: ChargeSignal): Promise<'delivered' | 'no_workflow'>;
  wakePayment(intentId: string): Promise<void>;
  startRefund(refundId: string): Promise<void>;
  signalRefund(refundId: string, event: { status: 'succeeded' | 'failed'; failureCode?: string }): Promise<'delivered' | 'no_workflow'>;
  startDispute(disputeId: string): Promise<void>;
  resolveDispute(disputeId: string, outcome: 'won' | 'lost'): Promise<void>;
}

const isNamed = (error: unknown, name: string): boolean => error instanceof Error && error.name === name;

export class TemporalOrchestrator implements PaymentOrchestrator {
  private constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
    private readonly connection: Connection,
  ) {}

  static async connect(options: { address: string; namespace: string; taskQueue: string }): Promise<TemporalOrchestrator> {
    const connection = await Connection.connect({ address: options.address });
    return new TemporalOrchestrator(new Client({ connection, namespace: options.namespace }), options.taskQueue, connection);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  private async start(workflow: string, workflowId: string, arg: Record<string, string>): Promise<void> {
    try {
      await this.client.workflow.start(workflow, {
        args: [arg],
        taskQueue: this.taskQueue,
        workflowId,
        // Arrancar dos veces el mismo cobro (reintento de la API tras una caída) es normal: el segundo intento no hace nada.
        // Solo se vuelve a arrancar si el anterior terminó por fallo.
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      });
    } catch (error) {
      if (!isNamed(error, 'WorkflowExecutionAlreadyStartedError')) throw error;
    }
  }

  private async signal(workflowId: string, name: string, ...args: unknown[]): Promise<'delivered' | 'no_workflow'> {
    try {
      await this.client.workflow.getHandle(workflowId).signal(name, ...args);
      return 'delivered';
    } catch (error) {
      if (isNamed(error, 'WorkflowNotFoundError')) return 'no_workflow';
      throw error;
    }
  }

  startPayment(intentId: string): Promise<void> {
    return this.start('PaymentWorkflow', workflowIds.payment(intentId), { intentId });
  }
  signalCharge(intentId: string, signal: ChargeSignal): Promise<'delivered' | 'no_workflow'> {
    return this.signal(workflowIds.payment(intentId), 'connectorEvent', signal);
  }
  async wakePayment(intentId: string): Promise<void> {
    await this.signal(workflowIds.payment(intentId), 'wake');
  }
  startRefund(refundId: string): Promise<void> {
    return this.start('RefundWorkflow', workflowIds.refund(refundId), { refundId });
  }
  signalRefund(refundId: string, event: { status: 'succeeded' | 'failed'; failureCode?: string }): Promise<'delivered' | 'no_workflow'> {
    return this.signal(workflowIds.refund(refundId), 'refundEvent', event);
  }
  startDispute(disputeId: string): Promise<void> {
    return this.start('DisputeWorkflow', workflowIds.dispute(disputeId), { disputeId });
  }
  async resolveDispute(disputeId: string, outcome: 'won' | 'lost'): Promise<void> {
    const delivered = await this.signal(workflowIds.dispute(disputeId), 'resolveDispute', { outcome });
    if (delivered === 'no_workflow') throw new Error('La disputa no tiene un workflow en curso');
  }
}
