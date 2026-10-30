import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AckPolicy, connect, DeliverPolicy, type ConsumerMessages, type JsMsg, type NatsConnection } from 'nats';
import { EngineMisconfiguredError } from '../engine/delivery-engine';
import { SERVICE_CONFIG, type EventSource, type ServiceConfig } from '../config';
import { EventIngest } from './event-ingest';
import { PUBLIC_EVENT_TYPES } from './public-events';

const RETRY_MS = 2_000;
const NAK_DELAY_MS = 2_000;
/** Con las credenciales de Svix rechazadas (401/403) cada evento fallaría igual: se detiene el lote y se espera antes de volver a leer. */
const MISCONFIGURED_NAK_DELAY_MS = 60_000;
const MISCONFIGURED_PAUSE_MS = 30_000;

/**
 * Lee los eventos públicos de los streams de P2, P3 y P5 (consumidor durable por stream, entrega al menos una vez).
 * Si NATS o un stream todavía no existen, reintenta en segundo plano; `/health/ready` informa cuántos están leyendo.
 * Confía en el bus: quien pueda publicar en estos temas puede hacer que se notifique un pago. Requiere credenciales NATS por
 * servicio con permisos de publicación acotados (ola 3); ver docs/trabajo/ola-1/P1/PROPUESTAS.md.
 */
@Injectable()
export class EventConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventConsumer.name);
  private connection: NatsConnection | undefined;
  private readonly streams = new Map<string, ConsumerMessages>();
  private readonly active = new Set<string>();
  private stopped = false;
  private resolveReady!: () => void;
  /** Se resuelve cuando todos los streams configurados ya se están leyendo (las pruebas esperan esto antes de publicar). */
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    private readonly ingest: EventIngest,
  ) {}

  get subscribedStreams(): number {
    return this.active.size;
  }

  onModuleInit(): void {
    if (!this.config.natsUrl) {
      this.logger.warn('Sin NATS_URL: pay-webhooks no recibe eventos');
      return;
    }
    for (const source of this.config.eventSources) void this.run(source);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    for (const messages of this.streams.values()) messages.stop();
    await this.connection?.drain().catch(() => undefined);
  }

  private async run(source: EventSource): Promise<void> {
    while (!this.stopped) {
      try {
        await this.consume(source);
      } catch (error) {
        this.active.delete(source.stream);
        this.logger.warn({ stream: source.stream, err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo leer el stream; se reintenta');
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }

  private async consume({ stream, subjectPrefix }: EventSource): Promise<void> {
    this.connection ??= await connect({ servers: this.config.natsUrl!, name: 'pay-webhooks' });
    const durable = `pay-webhooks-${stream.toLowerCase()}`;
    const manager = await this.connection.jetstreamManager();
    try {
      await manager.consumers.info(stream, durable);
    } catch {
      await manager.consumers.add(stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subjects: PUBLIC_EVENT_TYPES.map((type) => `${subjectPrefix}.${type}`),
        max_deliver: 20,
      });
    }
    const consumer = await this.connection.jetstream().consumers.get(stream, durable);
    const messages = await consumer.consume({ max_messages: 50 });
    this.streams.set(stream, messages);
    this.active.add(stream);
    if (this.active.size === this.config.eventSources.length) this.resolveReady();
    for await (const message of messages) {
      if ((await this.handle(message)) === 'halt') {
        // Fail-closed: no se sigue consumiendo el lote contra un motor que rechaza las credenciales. Lo ya leído queda sin confirmar (NATS lo reentrega).
        messages.stop();
        this.active.delete(stream);
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, MISCONFIGURED_PAUSE_MS));
        return;
      }
    }
    this.active.delete(stream);
  }

  /** `halt` solo ante un error de configuración del motor (401/403): hay que detener el lote. */
  private async handle(message: JsMsg): Promise<'continue' | 'halt'> {
    let raw: unknown;
    try {
      raw = JSON.parse(message.string());
    } catch {
      this.logger.warn({ subject: message.subject }, 'Evento descartado: no es JSON');
      message.term('no es JSON');
      return 'continue';
    }
    try {
      const outcome = await this.ingest.ingest(raw);
      if (outcome.kind === 'rejected') message.term(outcome.reason);
      else message.ack();
    } catch (error) {
      if (error instanceof EngineMisconfiguredError) {
        this.logger.error({ subject: message.subject, status: error.status, alert: true }, 'El motor de entrega rechazó las credenciales: se detiene el lote y el evento queda pendiente');
        message.nak(MISCONFIGURED_NAK_DELAY_MS);
        return 'halt';
      }
      this.logger.error({ subject: message.subject, err: error instanceof Error ? error.name : 'desconocido', code: (error as { code?: string }).code }, 'No se pudo procesar el evento; se reintenta');
      message.nak(NAK_DELAY_MS);
    }
    return 'continue';
  }
}
