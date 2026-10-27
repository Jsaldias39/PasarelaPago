import { connect } from 'nats';
import type { Stack } from '../stack.ts';

export interface BusEvent {
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * Lee del stream de un servicio los eventos de un tema (desde el principio) con un consumidor efímero sin acuse, que se borra al
 * terminar: no altera lo que consumen los servicios. Es solo de lectura: sirve para contar efectos («exactamente una vez»).
 */
export async function readStream(stack: Stack, stream: string, subject: string, accept: (event: BusEvent) => boolean = () => true): Promise<BusEvent[]> {
  const nc = await connect({ servers: stack.infra.natsUrl, name: 'e2e-reader' });
  try {
    const jsm = await nc.jetstreamManager();
    const info = await jsm.streams.info(stream).catch(() => undefined);
    if (!info || info.state.messages === 0) return [];
    const consumer = await jsm.consumers.add(stream, { ack_policy: 'none' as never, deliver_policy: 'all' as never, filter_subject: subject, inactive_threshold: 30_000_000_000 });
    try {
      const reader = await nc.jetstream().consumers.get(stream, consumer.name);
      const batch = await reader.fetch({ max_messages: 1000, expires: 1_000 });
      const events: BusEvent[] = [];
      for await (const message of batch) {
        const raw = JSON.parse(message.string()) as { id: string; type: string; data: Record<string, unknown> };
        const event = { id: raw.id, type: raw.type, data: raw.data };
        if (accept(event)) events.push(event);
      }
      return events;
    } finally {
      await jsm.consumers.delete(stream, consumer.name).catch(() => undefined);
    }
  } finally {
    await nc.close();
  }
}

/** Eventos `connector.transaction.status_changed` de un intento de pago. */
export const connectorEvents = (stack: Stack, paymentIntentId: string) =>
  readStream(stack, 'PAY_CONNECTORS', 'pay-connectors.connector.transaction.status_changed', (e) => e.data.payment_intent_id === paymentIntentId);
