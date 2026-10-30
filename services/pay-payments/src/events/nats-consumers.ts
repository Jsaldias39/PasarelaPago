import { AckPolicy, DeliverPolicy, connect, type ConsumerMessages, type NatsConnection } from 'nats';
import { ensureStream, type CloudEvent } from '@pay/outbox';
import { Logger } from '@nestjs/common';
import { DEFAULT_REDELIVERY, ensureUnlimitedDurable, redeliveryDelayMs, retryLogFields, type RedeliveryPolicy } from './consumer-redelivery';
import { EventHandlers, PoisonEventError } from './handlers';

export interface ConsumerSpec {
  readonly subject: string;
  readonly durable: string;
  readonly handle: (event: CloudEvent) => Promise<unknown>;
}

/** Stream dueño de un tema `pay-<servicio>.<...>`: `PAY_<SERVICIO>` (el mismo nombre con el que lo crea su publicador). */
export const streamOf = (subject: string): string => (subject.split('.')[0] ?? '').toUpperCase().replace(/-/g, '_');

/**
 * Consumidores JetStream de pay-payments: durables, ack explícito, reintento con espera si el efecto falla y descarte (`term`)
 * de lo que nunca se podrá procesar. La entrega es al menos una vez; el efecto único lo da el inbox de cada handler.
 *
 * Entrega SIN tope (`max_deliver: -1`, RE-REVISION-DINERO F-B2): un cambio de estado del conector, del comercio o de la tarifa que no se pudo
 * aplicar (Temporal o la base caídos) no se abandona a las N entregas; el handler es idempotente, la espera crece hasta un tope, y lo definitivo se
 * `term`ina. Ver consumer-redelivery.ts.
 */
export class NatsConsumers {
  private readonly logger = new Logger(NatsConsumers.name);
  private connection: NatsConnection | undefined;
  private readonly loops: Promise<void>[] = [];
  private readonly iterators: ConsumerMessages[] = [];
  /** Espera tras cada fallo: `base · 2^(entregas-1)` con tope. Pública para que las pruebas la acorten. */
  redelivery: RedeliveryPolicy = DEFAULT_REDELIVERY;

  static specs(handlers: EventHandlers, subjects: { connectorStatus: string; merchantEvents: string; feeSchedule: string }, prefix = 'pay-payments'): ConsumerSpec[] {
    return [
      { subject: subjects.connectorStatus, durable: `${prefix}-connector-status`, handle: (e) => handlers.connectorStatusChanged(e) },
      { subject: subjects.merchantEvents, durable: `${prefix}-merchant`, handle: (e) => handlers.merchantChanged(e) },
      { subject: subjects.feeSchedule, durable: `${prefix}-fee-schedule`, handle: (e) => handlers.feeSchedulePublished(e) },
    ];
  }

  async start(natsUrl: string, specs: readonly ConsumerSpec[]): Promise<void> {
    this.connection = await connect({ servers: natsUrl, name: 'pay-payments-consumers' });
    const manager = await this.connection.jetstreamManager();
    const js = this.connection.jetstream();
    for (const spec of specs) {
      const stream = streamOf(spec.subject);
      await ensureStream(manager, stream, [`${spec.subject.split('.')[0]}.>`]);
      await ensureUnlimitedDurable(
        manager,
        stream,
        { durable_name: spec.durable, filter_subject: spec.subject, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All },
        (fields, text) => this.logger.warn(fields, text),
      );
      const consumer = await js.consumers.get(stream, spec.durable);
      const messages = await consumer.consume();
      this.iterators.push(messages);
      this.loops.push(this.run(messages, spec));
    }
  }

  private async run(messages: ConsumerMessages, spec: ConsumerSpec): Promise<void> {
    for await (const message of messages) {
      let event: CloudEvent;
      try {
        event = JSON.parse(new TextDecoder().decode(message.data)) as CloudEvent;
        if (typeof event.id !== 'string' || typeof event.type !== 'string') throw new PoisonEventError('sobre inválido');
      } catch {
        message.term('invalid_envelope');
        continue;
      }
      try {
        await spec.handle(event);
        message.ack();
      } catch (error) {
        if (error instanceof PoisonEventError) {
          // Solo el motivo y el id: nunca el contenido del evento.
          this.logger.warn({ event_id: event.id, reason: error.message }, 'Evento descartado');
          message.term(error.message);
        } else {
          const deliveries = message.info.deliveryCount;
          this.logger.warn({ event_id: event.id, err: (error as Error).name, ...retryLogFields(deliveries) }, 'El consumidor falló; se reentrega');
          message.nak(redeliveryDelayMs(deliveries, this.redelivery));
        }
      }
    }
  }

  async stop(): Promise<void> {
    for (const iterator of this.iterators) iterator.stop();
    await Promise.allSettled(this.loops);
    await this.connection?.drain();
  }
}
