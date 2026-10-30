import { Inject, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { DisabledWalletAuthorizer } from '../clients/wallet-authorizer';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { assertNoDoublesInLive } from '../live-guard';
import { PG_POOL } from '../database.module';
import { createDeps, type Deps } from '../deps';
import { EventHandlers } from '../events/handlers';
import { NatsConsumers } from '../events/nats-consumers';
import { startPaymentsWorker, type PaymentsWorker } from '../temporal/worker';
import { InternalPaymentsController } from './internal.controller';
import { TemporalOrchestrator, type PaymentOrchestrator } from './orchestrator';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

export const DEPS = Symbol('DEPS');
export const ORCHESTRATOR = Symbol('ORCHESTRATOR');

@Module({
  controllers: [PaymentsController, InternalPaymentsController],
  providers: [
    // El saldo AloVida queda deshabilitado en producción mientras Q-20 siga abierta (DisabledWalletAuthorizer niega todo).
    { provide: DEPS, inject: [PG_POOL, SERVICE_CONFIG], useFactory: (pool: Pool, config: ServiceConfig) => createDeps(pool, config, { wallet: new DisabledWalletAuthorizer() }) },
    {
      provide: ORCHESTRATOR,
      inject: [SERVICE_CONFIG],
      useFactory: (config: ServiceConfig) => TemporalOrchestrator.lazy({ address: config.temporal.address, namespace: config.temporal.namespace, taskQueue: config.temporal.taskQueue }),
    },
    { provide: PaymentsService, inject: [DEPS, ORCHESTRATOR], useFactory: (deps: Deps, orchestrator: PaymentOrchestrator) => new PaymentsService(deps, orchestrator) },
  ],
})
export class PaymentsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentsModule.name);
  private worker: PaymentsWorker | undefined;
  private consumers: NatsConsumers | undefined;

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(DEPS) private readonly deps: Deps,
    @Inject(ORCHESTRATOR) private readonly orchestrator: PaymentOrchestrator,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Antes de abrir worker o consumidores: en `live` no se arranca sobre un simulador.
    await assertNoDoublesInLive(this.config.payMode, this.deps.clients.connectors);
    if (this.config.temporal.runWorker) this.worker = await startPaymentsWorker(this.deps);
    if (!this.config.natsUrl || !this.config.consumeEvents) {
      this.logger.warn('Sin NATS_URL (o CONSUME_EVENTS=false): no se consumen eventos (réplicas y estado de los conectores)');
      return;
    }
    const handlers = new EventHandlers(this.deps, this.orchestrator);
    this.consumers = new NatsConsumers();
    await this.consumers.start(this.config.natsUrl, NatsConsumers.specs(handlers, this.config.subjects));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumers?.stop();
    await this.worker?.shutdown();
    await (this.orchestrator as TemporalOrchestrator).close?.();
  }
}
