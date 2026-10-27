import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PublicRoute } from '@pay/service-auth';
import { PG_POOL } from './database.module';
import { EventConsumer } from './events/event-consumer';
import { EventIngest } from './events/event-ingest';

@Controller('health')
@PublicRoute()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly consumer: EventConsumer,
    private readonly ingest: EventIngest,
  ) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: la base propia responde. Los streams de eventos se informan pero NO tumban el estado: con NATS caído se pueden
   * seguir administrando endpoints y entregando lo ya encolado.
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        await this.pool.query('SELECT 1');
        return { database: { status: 'up' } };
      },
      async (): Promise<HealthIndicatorResult> => ({ events: { status: 'up', subscribed_streams: this.consumer.subscribedStreams, ...this.ingest.metrics } }),
    ]);
  }
}
