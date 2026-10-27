import { enqueue, newCloudEvent, type Queryable } from '@pay/outbox';

/**
 * Publica un evento de pay-merchants por outbox, en la MISMA transacción que el cambio que lo causa.
 * `data` lleva solo ids, estados e importes; nunca nombres, documentos ni cuentas (regla 90.2). El esquema está en
 * contracts/asyncapi/merchants-schedules.yaml y las pruebas validan cada evento emitido contra él.
 */
export async function emit(
  client: Queryable,
  event: { type: string; merchantId: string; subject: string; data: Record<string, unknown>; aggregateType: string; aggregateId: string },
): Promise<void> {
  const cloudEvent = newCloudEvent({ source: '/pay-merchants', type: event.type, subject: event.subject, merchantId: event.merchantId, data: event.data });
  await enqueue(client, cloudEvent, { aggregateType: event.aggregateType, aggregateId: event.aggregateId });
}

export const iso = (value: Date): string => value.toISOString();
