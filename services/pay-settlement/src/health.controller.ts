import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PG_POOL } from './database.module';
import { SETTLEMENT_CONFIG, type SettlementConfig } from './settlement/settlement.config';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SETTLEMENT_CONFIG) private readonly settlement: SettlementConfig,
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
      // El modo B es un doble declarado (D-02): el reporte de salud lo dice, para que nadie lo tome por un riel real.
      async (): Promise<HealthIndicatorResult> => ({
        settlement: { status: 'up', mode: this.settlement.mode, payMode: this.settlement.payMode, rail: this.settlement.mode === 'bank' ? 'bank_transfer' : 'acquirer_settlement', simulated: this.settlement.mode === 'acquirer' },
      }),
    ]);
  }
}
