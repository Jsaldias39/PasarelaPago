import { Controller, Get, Inject, Res, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { AppendOnlyGuardsProbe } from './append-only-guards';
import { PG_POOL } from './database.module';
import { SETTLEMENT_CONFIG, type SettlementConfig } from './settlement/settlement.config';

@Controller('health')
export class HealthController {
  private readonly guards: AppendOnlyGuardsProbe;

  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SETTLEMENT_CONFIG) private readonly settlement: SettlementConfig,
  ) {
    this.guards = new AppendOnlyGuardsProbe(pool, settlement.payMode);
  }

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: la base propia responde y el guardián de solo-agregar de `settlement_audit` existe (`checks.append_only_guards`, REVISION-DINERO F-D1).
   * Bajo `PAY_MODE=live`, un guardián ausente ⇒ 503; en sandbox sigue listo pero `ok: false` se ve y se avisa en el log.
   */
  @Get('ready')
  @HealthCheck()
  async ready(@Res({ passthrough: true }) res: Response) {
    const guards = await this.guards.report();
    const checks = { append_only_guards: guards };
    try {
      const result = await this.health.check([
        async (): Promise<HealthIndicatorResult> => {
          await this.pool.query('SELECT 1');
          return { database: { status: 'up' } };
        },
        // El modo B es un doble declarado (D-02): el reporte de salud lo dice, para que nadie lo tome por un riel real.
        async (): Promise<HealthIndicatorResult> => ({
          settlement: { status: 'up', mode: this.settlement.mode, payMode: this.settlement.payMode, rail: this.settlement.mode === 'bank' ? 'bank_transfer' : 'acquirer_settlement', simulated: this.settlement.mode === 'acquirer' },
        }),
        async (): Promise<HealthIndicatorResult> => ({ append_only_guards: { status: this.guards.blocksReadiness(guards) ? 'down' : 'up', ...guards } }),
      ]);
      return { ...result, checks };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        res.status(503);
        return { ...(error.getResponse() as Record<string, unknown>), checks };
      }
      throw error;
    }
  }
}
