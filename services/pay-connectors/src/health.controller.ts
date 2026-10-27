import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import { PublicRoute } from '@pay/service-auth';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';

@PublicRoute()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: la base propia responde. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        await this.pool.query('SELECT 1');
        return { database: { status: 'up' } };
      },
    ]);
  }
}
