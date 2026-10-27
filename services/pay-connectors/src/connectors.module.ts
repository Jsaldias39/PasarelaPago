import { Inject, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { IdempotencyStore } from '@pay/idempotency';
import { Pool } from 'pg';
import { BankTransferConnector, DbTransferReferenceStore } from './connectors/bank-transfer/bank-transfer.connector';
import { MockConnector, type QrPort } from './connectors/mock/mock.connector';
import { SimulatedBank } from './connectors/mock/simulated-bank';
import { HttpQrClient } from './connectors/qr-http.client';
import { CallbacksService } from './core/callbacks.service';
import { ChargesService } from './core/charges.service';
import { HealthService } from './core/health.service';
import { MockPumpService, SIMULATED_BANK } from './core/mock-pump.service';
import { PollerService } from './core/poller.service';
import { ProviderGateway } from './core/provider-gateway';
import { RefundsService } from './core/refunds.service';
import { RoutingService } from './core/routing.service';
import { StatementsService } from './core/statements.service';
import { CLOCK, LOCK_POOL, QR_PORT, REGISTRY, SECRETS, systemClock } from './core/tokens';
import { SERVICE_CONFIG, type ServiceConfig } from './config';
import { PG_POOL } from './database.module';
import { ConnectorRegistry } from './domain/registry';
import { EnvSecretProvider, type SecretProvider } from './domain/secrets';
import { ChargesController } from './http/charges.controller';
import { CallbacksController } from './http/callbacks.controller';
import { ConnectorHealthController } from './http/connector-health.controller';
import { StatementsController } from './http/statements.controller';
import { TransfersController } from './http/transfers.controller';
import { TransfersService } from './core/transfers.service';

export const TRANSFER_BANK = Symbol('TRANSFER_BANK');

/** Falla de forma explícita si se pide un QR sin pay-qr configurado: nunca se inventa un payload. */
const unconfiguredQr: QrPort = {
  async issue() {
    throw new Error('PAY_QR_URL no está configurada: no hay de dónde obtener el QR');
  },
};

@Module({
  controllers: [ChargesController, TransfersController, StatementsController, CallbacksController, ConnectorHealthController],
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: LOCK_POOL,
      inject: [SERVICE_CONFIG],
      useFactory: (config: ServiceConfig) =>
        new Pool({
          host: config.db.host,
          port: config.db.port,
          user: config.db.user,
          password: config.db.password,
          database: config.db.name,
          max: config.lockPool.max,
          connectionTimeoutMillis: config.lockPool.waitMs,
          application_name: 'pay-connectors-locks',
        }),
    },
    { provide: SECRETS, useFactory: (): SecretProvider => new EnvSecretProvider() },
    { provide: QR_PORT, inject: [SERVICE_CONFIG], useFactory: (config: ServiceConfig): QrPort => (config.qrUrl ? new HttpQrClient(config.qrUrl) : unconfiguredQr) },
    // [DOBLE] Bancos simulados: solo existen en sandbox y los carga la guardia de modo del registro.
    { provide: SIMULATED_BANK, useFactory: () => new SimulatedBank({ seed: 1 }) },
    { provide: TRANSFER_BANK, useFactory: () => new SimulatedBank({ seed: 2 }) },
    {
      provide: REGISTRY,
      inject: [SERVICE_CONFIG, PG_POOL, SECRETS, QR_PORT, SIMULATED_BANK, TRANSFER_BANK],
      useFactory: (config: ServiceConfig, pool: Pool, secrets: SecretProvider, qr: QrPort, bank: SimulatedBank, transferBank: SimulatedBank): ConnectorRegistry => {
        const registry = new ConnectorRegistry(config.mode);
        // Los adaptadores del Banco Mercantil (mercantil_qr, mercantil_card) NO existen: el banco no publica su documentación
        // (docs/spikes/banco-mercantil.md). En `live` el servicio arranca sin conectores de QR ni tarjeta y lo dice en /connectors/health.
        if (config.mode === 'sandbox') {
          registry.register(new MockConnector({ bank, secrets, qr }));
          registry.register(
            new BankTransferConnector('sandbox', new DbTransferReferenceStore(pool), {
              fetch: async (range) => transferBank.statement(range),
              probe: async () => (transferBank.isDown() ? { ok: false, latencyMs: 1, reason: 'unreachable' } : { ok: true, latencyMs: 1 }),
            }),
          );
        }
        return registry;
      },
    },
    { provide: IdempotencyStore, inject: [PG_POOL], useFactory: (pool: Pool) => new IdempotencyStore(pool) },
    HealthService,
    RoutingService,
    ProviderGateway,
    ChargesService,
    RefundsService,
    TransfersService,
    CallbacksService,
    PollerService,
    StatementsService,
    MockPumpService,
  ],
  exports: [REGISTRY, SIMULATED_BANK, TRANSFER_BANK, CLOCK, HealthService, PollerService, StatementsService, MockPumpService],
})
export class ConnectorsModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ConnectorsModule.name);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    private readonly poller: PollerService,
    private readonly health: HealthService,
    private readonly statements: StatementsService,
    private readonly pump: MockPumpService,
    @Inject(LOCK_POOL) private readonly lockPool: Pool,
  ) {}

  /** Temporizadores del servicio. Con intervalo 0 no corre ninguno (las pruebas disparan cada tarea a mano). */
  onModuleInit(): void {
    const every = (ms: number, name: string, task: () => Promise<unknown>) => {
      if (ms <= 0) return;
      const timer = setInterval(() => {
        task().catch((error: Error) => this.logger.error({ err: error.name, task: name }, 'Falló una tarea periódica'));
      }, ms);
      timer.unref();
      this.timers.push(timer);
    };
    every(this.config.poller.intervalMs, 'poller', () => this.poller.tick());
    every(this.config.health.intervalMs, 'health', () => this.health.probeAll());
    every(this.config.reconcile.intervalMs, 'reconcile', () => this.statements.reconcileAll());
    if (this.config.mode === 'sandbox') every(this.config.mockPumpIntervalMs, 'mock-pump', () => this.pump.tick());
  }

  async onApplicationShutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    await this.lockPool.end();
  }
}
