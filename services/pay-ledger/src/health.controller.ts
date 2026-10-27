import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';
import { TB_ENGINE, TigerBeetleEngine } from './ledger/tb-engine';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine,
  ) {}

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: la base propia y TigerBeetle responden. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        await this.pool.query('SELECT 1');
        return { database: { status: 'up' } };
      },
      async (): Promise<HealthIndicatorResult> => {
        await this.tb.ping();
        return { tigerbeetle: { status: 'up' } };
      },
    ]);
  }
}
