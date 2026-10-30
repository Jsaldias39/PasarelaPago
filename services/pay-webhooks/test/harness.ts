import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { createIsolatedDatabase, loadContract, type ContractValidator, type IsolatedDatabase } from '@pay/testing';
import { AppModule } from '../src/app.module';
import { loadConfig, type ServiceConfig } from '../src/config';
import { configureApp } from '../src/configure-app';
import { DeliveryWorker } from '../src/engine/delivery.worker';
import { CLOCK, type Clock } from '../src/engine/delivery-engine';
import { TARGET_GUARD } from '../src/endpoints/endpoint.service';
import { EventConsumer } from '../src/events/event-consumer';
import { EventIngest } from '../src/events/event-ingest';
import { TargetGuard } from '../src/ssrf/target-guard';
import { RESOLVER, TRANSPORT } from '../src/ssrf/tokens';
import { FakeResolver } from './doubles/fake-resolver';
import { LoopbackTransport } from './doubles/loopback-transport';

/** El esquema es el del MODELO, vendorizado (D-18): `sql/ddl.sql` ya trae las tablas técnicas (idempotencia, inbox) y los guardianes de solo-agregar. */
export const SQL_FILES = [join(process.cwd(), 'sql/ddl.sql')];
export const PUBLIC_CONTRACT = join(process.cwd(), '../../contracts/openapi/public-v1.yaml');

/** Reloj controlable: las pruebas de reintentos avanzan horas sin esperar. */
export class TestClock implements Clock {
  constructor(private current = new Date('2026-10-27T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface WebhooksHarness {
  readonly app: NestExpressApplication;
  /** Cliente HTTP crudo (sin identidad de servicio) contra el servicio ya escuchando. */
  http(): supertest.Agent;
  readonly config: ServiceConfig;
  readonly db: IsolatedDatabase;
  readonly contract: ContractValidator;
  readonly clock: TestClock;
  readonly resolver: FakeResolver;
  readonly transport: LoopbackTransport;
  readonly worker: DeliveryWorker;
  readonly ingest: EventIngest;
  readonly consumer: EventConsumer;
  /** Petición como la haría pay-edge para ese comercio (identidad de servicio + comercio autenticado). */
  as(merchantId: string): { get(path: string): supertest.Test; post(path: string): supertest.Test; delete(path: string): supertest.Test };
  stop(): Promise<void>;
}

export const newMerchantId = () => `mc_${randomBytes(6).toString('hex')}`;
export const newKey = () => `clave-${randomBytes(8).toString('hex')}`;

export interface StartOptions {
  readonly env?: Record<string, string>;
  readonly resolverTable?: Record<string, readonly string[]>;
  /**
   * Puertos de destino permitidos por el guard de SSRF además del 443. Es el MISMO arreglo (no una copia): la prueba le agrega el puerto de cada
   * receptor que levanta. Solo lo usan las pruebas contra Svix real, cuyos receptores escuchan en puertos efímeros.
   */
  readonly allowedPorts?: number[];
}

/** Levanta el servicio COMPLETO con Postgres real y un esquema propio; solo DNS y el último salto de red son dobles. */
export async function startWebhooks(options: StartOptions = {}): Promise<WebhooksHarness> {
  const db = await createIsolatedDatabase(SQL_FILES);
  const contract = await loadContract(PUBLIC_CONTRACT);
  const clock = new TestClock();
  const resolver = new FakeResolver({ 'hooks.comercio.example': ['93.184.216.34'], ...options.resolverTable });
  const transport = new LoopbackTransport();
  const config = loadConfig({
    ...process.env,
    DB_SCHEMA: db.schema,
    LOG_LEVEL: 'silent',
    WEBHOOKS_RETRY_SCHEDULE_MS: '0,1000,60000,3600000',
    WEBHOOKS_RETRY_JITTER_PERCENT: '0',
    ...options.env,
  });
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(RESOLVER)
    .useValue(resolver)
    .overrideProvider(TRANSPORT)
    .useValue(transport);
  if (options.allowedPorts) builder = builder.overrideProvider(TARGET_GUARD).useValue(new TargetGuard(resolver, { allowedPorts: options.allowedPorts }));
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();

  const http = () => supertest(baseUrl);
  return {
    app,
    http,
    config,
    db,
    contract,
    clock,
    resolver,
    transport,
    worker: app.get(DeliveryWorker),
    ingest: app.get(EventIngest),
    consumer: app.get(EventConsumer),
    as: (merchantId) => {
      const withIdentity = (req: supertest.Test) => req.set('X-Service-Id', 'pay-edge').set('X-Merchant-Id', merchantId);
      return {
        get: (path) => withIdentity(http().get(path)),
        post: (path) => withIdentity(http().post(path)),
        delete: (path) => withIdentity(http().delete(path)),
      };
    },
    async stop() {
      await app.close();
      await db.drop();
    },
  };
}
