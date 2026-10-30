import { readFileSync } from 'node:fs';
import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Pool } from 'pg';
import { IdempotencyStore } from '@pay/idempotency';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { SecretBox } from './crypto/secret-box';
import { PG_POOL } from './database.module';
import { DeliveryWorker } from './engine/delivery.worker';
import { CLOCK, DELIVERY_ENGINE, systemClock, type Clock } from './engine/delivery-engine';
import { InProcessEngine } from './engine/in-process.engine';
import { SVIX_CLIENT, SvixClient } from './engine/svix/svix-client';
import { SvixEngine } from './engine/svix/svix-engine';
import { SVIX_RECONCILER, SvixReconcileRunner } from './engine/svix/svix-reconcile.runner';
import { SvixReconciler } from './engine/svix/svix-reconciler';
import { WorkerRunner } from './engine/worker.runner';
import { EndpointController } from './endpoints/endpoint.controller';
import { EndpointService, IDEMPOTENCY, SECRET_BOX, TARGET_GUARD } from './endpoints/endpoint.service';
import { EventConsumer } from './events/event-consumer';
import { EventIngest } from './events/event-ingest';
import { HttpsTransport, type DeliveryTransport } from './ssrf/https-transport';
import { DnsResolver, TargetGuard, type Resolver } from './ssrf/target-guard';
import { RESOLVER, TRANSPORT } from './ssrf/tokens';

/**
 * Cableado de pay-webhooks. El motor de entrega lo elige `WEBHOOKS_ENGINE` (ver `config.ts`): `svix` ⇒ `SvixEngine` (el servidor real, más su
 * reconciliador); `inprocess` ⇒ el [DOBLE de Svix] (`InProcessEngine` + `DeliveryWorker`), que bajo `live` no arranca. `RESOLVER`, `TRANSPORT` y
 * `CLOCK` se inyectan para poder probar el rebinding, la red y los reintentos del motor en proceso sin esperar.
 */
@Module({})
export class WebhooksModule {
  static forRoot(): DynamicModule {
    return {
      module: WebhooksModule,
      controllers: [EndpointController],
      providers: [
        { provide: APP_GUARD, useClass: ServiceIdentityGuard },
        { provide: CLOCK, useValue: systemClock },
        { provide: RESOLVER, useClass: DnsResolver },
        {
          provide: TRANSPORT,
          inject: [SERVICE_CONFIG],
          useFactory: (config: ServiceConfig) => new HttpsTransport(config.sandboxCaFile ? { ca: readFileSync(config.sandboxCaFile, 'utf8') } : {}),
        },
        { provide: 'PAY_MODE', inject: [SERVICE_CONFIG], useFactory: (config: ServiceConfig) => (config.payMode === 'live' ? 'live' : 'test') },
        { provide: SECRET_BOX, inject: [SERVICE_CONFIG], useFactory: (config: ServiceConfig) => new SecretBox(config.secretKek) },
        {
          provide: TARGET_GUARD,
          inject: [RESOLVER, SERVICE_CONFIG],
          useFactory: (resolver: Resolver, config: ServiceConfig) => {
            if (config.sandboxTargets.length > 0) new Logger('WebhooksModule').warn({ targets: config.sandboxTargets }, 'SANDBOX: se permiten entregas a estos destinos locales exactos');
            return new TargetGuard(resolver, { allowTargets: new Set(config.sandboxTargets) });
          },
        },
        { provide: IDEMPOTENCY, inject: [PG_POOL], useFactory: (pool: Pool) => new IdempotencyStore(pool) },
        {
          provide: SVIX_CLIENT,
          inject: [SERVICE_CONFIG],
          useFactory: (config: ServiceConfig) =>
            config.svix ? new SvixClient({ baseUrl: config.svix.url, authToken: config.svix.authToken, timeoutMs: config.svix.timeoutMs, maxAttempts: config.svix.maxAttempts }) : undefined,
        },
        {
          provide: DELIVERY_ENGINE,
          inject: [SECRET_BOX, CLOCK, SERVICE_CONFIG, SVIX_CLIENT],
          useFactory: (box: SecretBox, clock: Clock, config: ServiceConfig, svix: SvixClient | undefined) =>
            config.engine === 'svix' && svix
              ? new SvixEngine(svix, { rotationGraceSeconds: Math.round(config.rotationGraceMs / 1000), ...(config.svix ? { namespace: config.svix.namespace } : {}) })
              : new InProcessEngine(box, clock, { rotationGraceMs: config.rotationGraceMs }),
        },
        {
          provide: SVIX_RECONCILER,
          inject: [PG_POOL, SERVICE_CONFIG, SVIX_CLIENT],
          useFactory: (pool: Pool, config: ServiceConfig, svix: SvixClient | undefined) =>
            config.svix && svix ? new SvixReconciler(pool, svix, { orphanGraceMs: config.svix.orphanGraceMs, clockMarginMs: config.svix.clockMarginMs, namespace: config.svix.namespace, maxOrphanDeletesPerPass: config.svix.maxOrphanDeletesPerPass, orphanAction: config.svix.orphanAction, concurrency: 4 }) : undefined,
        },
        {
          provide: DeliveryWorker,
          inject: [PG_POOL, SERVICE_CONFIG, SECRET_BOX, TARGET_GUARD, TRANSPORT, CLOCK],
          useFactory: (pool: Pool, config: ServiceConfig, box: SecretBox, guard: TargetGuard, transport: DeliveryTransport, clock: Clock) =>
            new DeliveryWorker(pool, config, box, guard, transport, clock),
        },
        WorkerRunner,
        SvixReconcileRunner,
        EndpointService,
        EventIngest,
        EventConsumer,
      ],
      exports: [DeliveryWorker, EventConsumer, EventIngest, DELIVERY_ENGINE, SVIX_RECONCILER],
    };
  }
}
