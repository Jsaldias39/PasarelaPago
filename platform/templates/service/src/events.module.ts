import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { connect, type NatsConnection } from 'nats';
import { NatsEventPublisher, OutboxRelay, ensureStream } from '@pay/outbox';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { PG_POOL } from './database.module';

/**
 * Conecta a NATS JetStream (si hay `NATS_URL`) y arranca el relé del outbox de este servicio.
 * Cada servicio publica en su propio stream: `PAY_<NOMBRE>` con los temas `<nombre>.>`.
 */
@Module({})
export class EventsModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventsModule.name);
  private connection: NatsConnection | undefined;
  private relay: OutboxRelay | undefined;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.natsUrl) {
      this.logger.warn('Sin NATS_URL: el relé del outbox no publica');
      return;
    }
    this.connection = await connect({ servers: this.config.natsUrl, name: '__NAME__' });
    const stream = '__NAME__'.toUpperCase().replace(/-/g, '_');
    await ensureStream(await this.connection.jetstreamManager(), stream, [`__NAME__.>`]);
    this.relay = new OutboxRelay(this.pool, new NatsEventPublisher(this.connection), {
      // Solo nombre y SQLSTATE: el mensaje de un error de base puede traer valores (regla 90.2.1).
      onError: (error, eventId) =>
        this.logger.error({ err: error.name, code: (error as { code?: string }).code, event_id: eventId || undefined }, 'El relé del outbox falló'),
    });
    this.relay.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // stop() espera el ciclo en curso: no se cierra la conexión con una publicación a medias.
    await this.relay?.stop();
    await this.connection?.drain();
  }
}
