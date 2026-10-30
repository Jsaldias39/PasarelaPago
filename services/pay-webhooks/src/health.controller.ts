import { Controller, Get, Inject, Optional, Res, ServiceUnavailableException } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { PublicRoute } from '@pay/service-auth';
import { AppendOnlyGuardsProbe } from './append-only-guards';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { PG_POOL } from './database.module';
import { DELIVERY_ENGINE, type DeliveryEngine } from './engine/delivery-engine';
import { SVIX_RECONCILER } from './engine/svix/svix-reconcile.runner';
import type { SvixReconciler } from './engine/svix/svix-reconciler';
import { EventConsumer } from './events/event-consumer';
import { EventIngest } from './events/event-ingest';

@Controller('health')
@PublicRoute()
export class HealthController {
  private readonly guards: AppendOnlyGuardsProbe;

  constructor(
    private readonly health: HealthCheckService,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly consumer: EventConsumer,
    private readonly ingest: EventIngest,
    @Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine,
    @Inject(SERVICE_CONFIG) config: ServiceConfig,
    @Optional() @Inject(SVIX_RECONCILER) private readonly reconciler?: SvixReconciler,
  ) {
    this.guards = new AppendOnlyGuardsProbe(pool, config.payMode);
  }

  /** Liveness: el proceso responde. No toca dependencias. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: la base propia responde y el guardián de solo-agregar de `webhook_delivery_attempts` existe (`checks.append_only_guards`, REVISION-DINERO F-D1).
   * Bajo `PAY_MODE=live`, un guardián ausente ⇒ 503; en sandbox sigue listo pero `ok: false` se ve y se avisa en el log. Los streams de eventos se informan
   * pero NO tumban el estado: con NATS caído se pueden seguir administrando endpoints y entregando lo ya encolado.
   */
  @Get('ready')
  @HealthCheck()
  async ready(@Res({ passthrough: true }) res: Response) {
    const guards = await this.guards.report();
    const checks = { append_only_guards: guards };
    try {
      const result = await this.check(guards);
      return { ...result, checks };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        res.status(503);
        return { ...(error.getResponse() as Record<string, unknown>), checks };
      }
      throw error;
    }
  }

  private check(guards: Awaited<ReturnType<AppendOnlyGuardsProbe['report']>>) {
    return this.health.check([
      async (): Promise<HealthIndicatorResult> => {
        await this.pool.query('SELECT 1');
        return { database: { status: 'up' } };
      },
      // Informativo: con Svix caído se siguen administrando endpoints y leyendo eventos (que se reintentan), así que no tumba el estado.
      async (): Promise<HealthIndicatorResult> => ({ delivery_engine: { status: 'up', kind: this.engine.kind, ...(this.reconciler?.lastSummary ? { last_reconcile: this.reconciler.lastSummary } : {}), ...(this.reconciler ? { orphan_guard: { action: this.reconciler.action, cap_trips: this.reconciler.stats.orphanCapTrips, withheld_total: this.reconciler.stats.orphansWithheldTotal, disabled_total: this.reconciler.disabledStats.disabledTotal, held_disabled: this.reconciler.disabledStats.heldDisabled } } : {}) } }),
      async (): Promise<HealthIndicatorResult> => ({ events: { status: 'up', subscribed_streams: this.consumer.subscribedStreams, max_delivery_count_seen: this.consumer.maxDeliveryCountSeen, ...this.ingest.metrics } }),
      async (): Promise<HealthIndicatorResult> => ({ append_only_guards: { status: this.guards.blocksReadiness(guards) ? 'down' : 'up', ...guards } }),
    ]);
  }
}
