import { Inject, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ExecutorService } from './executor/executor.service';
import { HttpLedgerClient, LEDGER_CLIENT } from './ledger/ledger.client';
import { MandatesController } from './mandates/mandates.controller';
import { CLOCK, MandatesService } from './mandates/mandates.service';
import { MerchantReplicaConsumer } from './replica/replica.consumer';
import { SCHEDULE_SETTINGS, loadScheduleSettings, type ScheduleSettings } from './settings';

/**
 * Cableado del dominio de pagos programados. La política de reintentos y la URL del libro mayor no tienen valor por defecto:
 * si faltan, `loadScheduleSettings` lanza y el servicio no arranca (regla 90.3.4).
 */
@Module({
  controllers: [MandatesController],
  providers: [
    { provide: SCHEDULE_SETTINGS, useFactory: () => loadScheduleSettings() },
    { provide: CLOCK, useValue: () => new Date() },
    { provide: LEDGER_CLIENT, useClass: HttpLedgerClient },
    MandatesService,
    ExecutorService,
    MerchantReplicaConsumer,
  ],
  exports: [ExecutorService],
})
export class SchedulesModule implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly executor: ExecutorService,
    @Inject(SCHEDULE_SETTINGS) private readonly settings: ScheduleSettings,
  ) {}

  onModuleInit(): void {
    if (!this.settings.backgroundJobsEnabled) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.executor.runOnce().catch(() => undefined).finally(() => {
        this.running = false;
      });
    }, this.settings.runIntervalSeconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
