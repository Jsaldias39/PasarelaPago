import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AckPolicy, connect, DeliverPolicy, type ConsumerMessages, type JsMsg, type NatsConnection } from 'nats';
import { processOnce } from '@pay/outbox';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { parseReplicaEvent } from './replica.events';
import { applyReplicaEvent } from './replica.repository';

const CONSUMER_NAME = 'pay-edge.replica';
const RETRY_MS = 2_000;
const NAK_DELAY_MS = 2_000;

/**
 * Mantiene la réplica de claves y estado de comercios a partir de los eventos de pay-merchants.
 *
 * - Consumidor durable de JetStream, entrega al menos una vez; `processOnce` (inbox) hace que cada evento tenga un solo efecto.
 * - Si NATS o el stream todavía no existen, reintenta en segundo plano: el borde arranca igual y `/health/ready` lo informa.
 * - Un evento mal formado se descarta con `term` (reintentarlo no lo arregla); un fallo de base hace `nak` con demora.
 * - Confía en el bus: quien pueda publicar en estos temas puede crear o revocar claves. Requiere credenciales NATS por
 *   servicio con permisos de publicación acotados (ola 3); ver docs/trabajo/ola-1/P1/PROPUESTAS.md.
 */
@Injectable()
export class ReplicaConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ReplicaConsumer.name);
  private connection: NatsConnection | undefined;
  private messages: ConsumerMessages | undefined;
  private stopped = false;
  private subscribed = false;
  private resolveReady!: () => void;
  /** Se resuelve cuando el consumidor ya está leyendo del stream (las pruebas esperan esto antes de publicar). */
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  onModuleInit(): void {
    if (!this.config.natsUrl) {
      this.logger.warn('Sin NATS_URL: la réplica de claves no se actualiza');
      return;
    }
    void this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.messages?.stop();
    await this.connection?.drain().catch(() => undefined);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.consume();
      } catch (error) {
        this.subscribed = false;
        this.logger.warn({ err: error instanceof Error ? error.name : 'desconocido' }, 'La réplica no pudo consumir; se reintenta');
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }

  private async consume(): Promise<void> {
    const { stream, subjectPrefix, durable } = this.config.replica;
    this.connection ??= await connect({ servers: this.config.natsUrl!, name: 'pay-edge' });
    const manager = await this.connection.jetstreamManager();
    const filters = ['api_key.created', 'api_key.revoked', 'merchant.activated', 'merchant.suspended', 'merchant.closed'].map((t) => `${subjectPrefix}.${t}`);
    try {
      await manager.consumers.info(stream, durable);
    } catch {
      await manager.consumers.add(stream, { durable_name: durable, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subjects: filters, max_deliver: 20 });
    }
    const consumer = await this.connection.jetstream().consumers.get(stream, durable);
    this.messages = await consumer.consume({ max_messages: 50 });
    this.subscribed = true;
    this.resolveReady();
    for await (const message of this.messages) await this.handle(message);
    this.subscribed = false;
  }

  private async handle(message: JsMsg): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(message.string());
    } catch {
      this.logger.warn({ subject: message.subject }, 'Evento descartado: no es JSON');
      message.term('no es JSON');
      return;
    }
    const event = parseReplicaEvent(raw);
    if (!event) {
      this.logger.warn({ subject: message.subject }, 'Evento descartado: no cumple el contrato');
      message.term('no cumple el contrato');
      return;
    }
    try {
      await processOnce(this.pool, CONSUMER_NAME, event.eventId, (client) => applyReplicaEvent(client, event));
      message.ack();
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.name : 'desconocido', code: (error as { code?: string }).code, event_id: event.eventId }, 'No se pudo aplicar el evento; se reintenta');
      message.nak(NAK_DELAY_MS);
    }
  }
}
