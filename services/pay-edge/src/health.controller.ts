import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';
import { ReplicaConsumer } from './replica/replica.consumer';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly replica: ReplicaConsumer,
  ) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: la base propia responde. La réplica de eventos se informa pero NO tumba el estado: con NATS caído el borde
   * sigue sirviendo con la última réplica conocida (una clave recién revocada podría tardar en dejar de servir: se informa).
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        await this.pool.query('SELECT 1');
        return { database: { status: 'up' } };
      },
      async (): Promise<HealthIndicatorResult> => ({ replica: { status: 'up', subscribed: this.replica.isSubscribed } }),
    ]);
  }
}
