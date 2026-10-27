import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AckPolicy, connect, DeliverPolicy, type ConsumerMessages, type NatsConnection } from 'nats';
import { NatsEventPublisher, OutboxRelay, ensureStream } from '@pay/outbox';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { PG_POOL } from './database.module';
import { CONSUMER_CONTRADICTION, CONSUMER_FEES, CONSUMER_LEDGER, SettlementConsumers } from './settlement/consumers';
import { SettlementModule } from './settlement/settlement.module';

/** Suscripciones durables que pay-settlement necesita (contratos: ledger-settlement.yaml y merchants-schedules.yaml). */
const SUBSCRIPTIONS = [
  { stream: 'PAY_LEDGER', subjects: ['pay-ledger.>'], subject: 'pay-ledger.ledger.transfer.posted', durable: CONSUMER_LEDGER },
  { stream: 'PAY_MERCHANTS', subjects: ['pay-merchants.>'], subject: 'pay-merchants.fee_schedule.published', durable: CONSUMER_FEES },
  { stream: 'PAY_PAYMENTS', subjects: ['pay-payments.>'], subject: 'pay-payments.payment_intent.contradiction_detected', durable: CONSUMER_CONTRADICTION },
] as const;

/**
 * Conecta a NATS JetStream (si hay `NATS_URL`) y arranca el relé del outbox de este servicio.
 * Cada servicio publica en su propio stream: `PAY_<NOMBRE>` con los temas `<nombre>.>`.
 */
@Module({ imports: [SettlementModule] })
export class EventsModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventsModule.name);
  private connection: NatsConnection | undefined;
  private relay: OutboxRelay | undefined;
  private readonly streams: ConsumerMessages[] = [];

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly consumers: SettlementConsumers,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.natsUrl) {
      this.logger.warn('Sin NATS_URL: el relé del outbox no publica');
      return;
    }
    this.connection = await connect({ servers: this.config.natsUrl, name: 'pay-settlement' });
    const stream = 'pay-settlement'.toUpperCase().replace(/-/g, '_');
    await ensureStream(await this.connection.jetstreamManager(), stream, [`pay-settlement.>`]);
    this.relay = new OutboxRelay(this.pool, new NatsEventPublisher(this.connection), {
      // Solo nombre y SQLSTATE: el mensaje de un error de base puede traer valores (regla 90.2.1).
      onError: (error, eventId) =>
        this.logger.error({ err: error.name, code: (error as { code?: string }).code, event_id: eventId || undefined }, 'El relé del outbox falló'),
    });
    this.relay.start();
    await this.subscribe(this.connection);
  }

  /**
   * Un consumidor durable por tema. Se reconoce (`ack`) lo procesado, lo duplicado y lo que nunca se podrá procesar (`term`, sin
   * contenido en el log); un fallo transitorio se devuelve (`nak`) para que JetStream lo reintente.
   */
  private async subscribe(connection: NatsConnection): Promise<void> {
    const manager = await connection.jetstreamManager();
    for (const sub of SUBSCRIPTIONS) {
      await ensureStream(manager, sub.stream, [...sub.subjects]);
      try {
        await manager.consumers.info(sub.stream, sub.durable.replace(/\./g, '_'));
      } catch {
        await manager.consumers.add(sub.stream, { durable_name: sub.durable.replace(/\./g, '_'), ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, filter_subject: sub.subject, max_deliver: 20 });
      }
      const consumer = await connection.jetstream().consumers.get(sub.stream, sub.durable.replace(/\./g, '_'));
      const messages = await consumer.consume({ max_messages: 50 });
      this.streams.push(messages);
      void (async () => {
        for await (const message of messages) {
          let payload: unknown;
          try {
            payload = JSON.parse(message.string());
          } catch {
            message.term('JSON ilegible');
            continue;
          }
          try {
            const outcome = await this.consumers.handle(payload);
            if (outcome === 'invalid') message.term('evento inválido');
            else message.ack();
          } catch (error) {
            this.logger.warn({ consumer: sub.durable, err: error instanceof Error ? error.name : 'desconocido' }, 'No se pudo procesar el evento; se reintenta');
            message.nak(5000);
          }
        }
      })();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.relay?.stop();
    for (const messages of this.streams) messages.stop();
    await this.connection?.drain();
  }
}
