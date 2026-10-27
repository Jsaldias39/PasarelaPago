import { headers, type JetStreamClient, type JetStreamManager, type NatsConnection } from 'nats';
import type { CloudEvent } from './cloudevent';
import type { EventPublisher } from './outbox';

/** Ventana de deduplicación de JetStream por `Nats-Msg-Id`: 2 minutos es el valor por defecto del servidor. */
export const DEDUP_WINDOW_NS = 2 * 60 * 1_000_000_000;

/** Publica en JetStream con el id del evento como `Nats-Msg-Id`: la publicación repetida no duplica el mensaje. */
export class NatsEventPublisher implements EventPublisher {
  private readonly js: JetStreamClient;

  constructor(connection: NatsConnection) {
    this.js = connection.jetstream();
  }

  async publish(subject: string, event: CloudEvent): Promise<void> {
    const h = headers();
    h.set('content-type', 'application/cloudevents+json');
    await this.js.publish(subject, new TextEncoder().encode(JSON.stringify(event)), { msgID: event.id, headers: h });
  }
}

/**
 * Crea (o deja como está) el stream de un servicio.
 *
 * @param manager - Administrador de JetStream.
 * @param name - Nombre del stream, por ejemplo `PAY_PAYMENTS`.
 * @param subjects - Temas que captura, por ejemplo `['pay-payments.>']`.
 */
export async function ensureStream(manager: JetStreamManager, name: string, subjects: string[]): Promise<void> {
  try {
    await manager.streams.info(name);
  } catch {
    await manager.streams.add({ name, subjects, duplicate_window: DEDUP_WINDOW_NS });
  }
}
