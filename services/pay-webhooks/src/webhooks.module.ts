import { type DynamicModule, Module } from '@nestjs/common';
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
import { WorkerRunner } from './engine/worker.runner';
import { EndpointController } from './endpoints/endpoint.controller';
import { EndpointService, IDEMPOTENCY, SECRET_BOX, TARGET_GUARD } from './endpoints/endpoint.service';
import { EventConsumer } from './events/event-consumer';
import { EventIngest } from './events/event-ingest';
import { HttpsTransport, type DeliveryTransport } from './ssrf/https-transport';
import { DnsResolver, TargetGuard, type Resolver } from './ssrf/target-guard';
import { RESOLVER, TRANSPORT } from './ssrf/tokens';

/**
 * Cableado de pay-webhooks. El motor de entrega es el [DOBLE de Svix] (`InProcessEngine`); cambiarlo por `SvixEngine` es
 * cambiar el proveedor `DELIVERY_ENGINE`. `RESOLVER`, `TRANSPORT` y `CLOCK` se inyectan para poder probar el rebinding, la red
 * y los reintentos sin esperar.
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
        { provide: TRANSPORT, useValue: new HttpsTransport() },
        { provide: 'PAY_MODE', inject: [SERVICE_CONFIG], useFactory: (config: ServiceConfig) => (config.payMode === 'live' ? 'live' : 'test') },
        { provide: SECRET_BOX, inject: [SERVICE_CONFIG], useFactory: (config: ServiceConfig) => new SecretBox(config.secretKek) },
        { provide: TARGET_GUARD, inject: [RESOLVER], useFactory: (resolver: Resolver) => new TargetGuard(resolver) },
        { provide: IDEMPOTENCY, inject: [PG_POOL], useFactory: (pool: Pool) => new IdempotencyStore(pool) },
        {
          provide: DELIVERY_ENGINE,
          inject: [SECRET_BOX, CLOCK, SERVICE_CONFIG],
          useFactory: (box: SecretBox, clock: Clock, config: ServiceConfig) => new InProcessEngine(box, clock, { rotationGraceMs: config.rotationGraceMs }),
        },
        {
          provide: DeliveryWorker,
          inject: [PG_POOL, SERVICE_CONFIG, SECRET_BOX, TARGET_GUARD, TRANSPORT, CLOCK],
          useFactory: (pool: Pool, config: ServiceConfig, box: SecretBox, guard: TargetGuard, transport: DeliveryTransport, clock: Clock) =>
            new DeliveryWorker(pool, config, box, guard, transport, clock),
        },
        WorkerRunner,
        EndpointService,
        EventIngest,
        EventConsumer,
      ],
      exports: [DeliveryWorker, EventConsumer, EventIngest, DELIVERY_ENGINE],
    };
  }
}
