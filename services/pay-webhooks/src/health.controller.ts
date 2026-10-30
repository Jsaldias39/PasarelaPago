import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { HealthCheck, HealthCheckService, type HealthIndicatorResult } from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PublicRoute } from '@pay/service-auth';
import { PG_POOL } from './database.module';
import { DELIVERY_ENGINE, type DeliveryEngine } from './engine/delivery-engine';
import { SVIX_RECONCILER } from './engine/svix/svix-reconcile.runner';
import type { SvixReconciler } from './engine/svix/svix-reconciler';
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
    @Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine,
    @Optional() @Inject(SVIX_RECONCILER) private readonly reconciler?: SvixReconciler,
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
      // Informativo: con Svix caído se siguen administrando endpoints y leyendo eventos (que se reintentan), así que no tumba el estado.
      async (): Promise<HealthIndicatorResult> => ({ delivery_engine: { status: 'up', kind: this.engine.kind, ...(this.reconciler?.lastSummary ? { last_reconcile: this.reconciler.lastSummary } : {}), ...(this.reconciler ? { orphan_guard: { cap_trips: this.reconciler.stats.orphanCapTrips, withheld_total: this.reconciler.stats.orphansWithheldTotal } } : {}) } }),
      async (): Promise<HealthIndicatorResult> => ({ events: { status: 'up', subscribed_streams: this.consumer.subscribedStreams, ...this.ingest.metrics } }),
    ]);
  }
}
