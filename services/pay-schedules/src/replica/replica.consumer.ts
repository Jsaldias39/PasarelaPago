import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AckPolicy, connect, DeliverPolicy, type ConsumerMessages, type JsMsg, type NatsConnection } from 'nats';
import { processOnce } from '@pay/outbox';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { SCHEDULE_SETTINGS, type ScheduleSettings } from '../settings';
import { DEFAULT_REDELIVERY, ensureUnlimitedDurable, redeliveryDelayMs, retryLogFields, type RedeliveryPolicy } from './consumer-redelivery';
import { applyMerchantEvent, parseMerchantEvent } from './merchant-replica';

const RETRY_MS = 2_000;

/** Mensaje del servidor NATS (nombres de stream/consumidor y la causa, nunca datos de personas), recortado para el registro. */
function describeNatsError(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message.slice(0, 200) : 'sin mensaje';
}

/**
 * Consumidor durable de JetStream de `merchant.activated|suspended|closed`. Entrega al menos una vez; `processOnce` (inbox) hace
 * que cada evento tenga un solo efecto. Un evento mal formado se descarta con `term`; un fallo de base hace `nak` con demora creciente y acotada.
 * Entrega SIN tope (`max_deliver: -1`, RE-REVISION-DINERO F-B2): un `merchant.suspended` que no se pudo aplicar (base caída) no se abandona a las N
 * entregas —el comercio seguiría con cronogramas activos—. Ver consumer-redelivery.ts.
 * Probado contra un NATS real con eventos del AsyncAPI vigente (test/nats-replica.spec.ts).
 */
@Injectable()
export class MerchantReplicaConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MerchantReplicaConsumer.name);
  private connection: NatsConnection | undefined;
  private messages: ConsumerMessages | undefined;
  private stopped = false;
  /** Espera tras cada fallo: `base · 2^(entregas-1)` con tope. Pública para que las pruebas la acorten. */
  redelivery: RedeliveryPolicy = DEFAULT_REDELIVERY;
  private resolveReady!: () => void;
  /** Se resuelve cuando el consumidor ya está leyendo del stream (las pruebas esperan esto antes de publicar). */
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(SCHEDULE_SETTINGS) private readonly settings: ScheduleSettings,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  onModuleInit(): void {
    if (!this.config.natsUrl) {
      this.logger.warn('Sin NATS_URL: la réplica de comercios no se actualiza');
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
        this.logger.warn({ err: (error as { name?: string } | null)?.name ?? 'desconocido', detail: describeNatsError(error) }, 'La réplica de comercios no pudo consumir; se reintenta');
      }
      if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }

  private async consume(): Promise<void> {
    const { merchantsStream: stream, merchantsDurable: durable } = this.settings;
    this.connection ??= await connect({ servers: this.config.natsUrl!, name: 'pay-schedules' });
    const manager = await this.connection.jetstreamManager();
    const filters = ['merchant.activated', 'merchant.suspended', 'merchant.closed'].map((t) => `${this.settings.merchantsSubjectPrefix}.${t}`);
    await ensureUnlimitedDurable(manager, stream, { durable_name: durable, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subjects: filters }, (fields, text) => this.logger.warn(fields, text));
    const consumer = await this.connection.jetstream().consumers.get(stream, durable);
    this.messages = await consumer.consume({ max_messages: 50 });
    this.resolveReady();
    for await (const message of this.messages) await this.handle(message);
  }

  private async handle(message: JsMsg): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(message.string());
    } catch {
      message.term('no es JSON');
      return;
    }
    const event = parseMerchantEvent(raw);
    if (!event) {
      this.logger.warn({ subject: message.subject }, 'Evento descartado: no cumple el contrato');
      message.term('no cumple el contrato');
      return;
    }
    try {
      await processOnce(this.pool, 'pay-schedules.merchant-replica', event.eventId, (client) => applyMerchantEvent(client, event));
      message.ack();
    } catch (error) {
      const deliveries = message.info.deliveryCount;
      this.logger.error({ err: (error as { name?: string } | null)?.name ?? 'desconocido', event_id: event.eventId, ...retryLogFields(deliveries) }, 'No se pudo aplicar el evento; se reintenta');
      message.nak(redeliveryDelayMs(deliveries, this.redelivery));
    }
  }
}
