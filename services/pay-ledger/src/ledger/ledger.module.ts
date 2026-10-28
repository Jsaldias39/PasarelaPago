import { Inject, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { AccountRegistry } from './account-registry';
import { HoldService } from './hold.service';
import { InvariantService } from './invariant.service';
import { LEDGER_CONFIG, type LedgerConfig, loadLedgerConfig } from './ledger.config';
import { LedgerController, PublicLedgerController } from './ledger.controller';
import { assertDeploymentSafe } from './deployment';
import { setEventsCarryMode } from './event-mode';
import { useIdNamespace } from './ids';
import { LedgerService } from './ledger.service';
import { ReconcilerService } from './reconciler.service';
import { TB_ENGINE, TigerBeetleEngine } from './tb-engine';

/** Arranca los jobs periódicos (si están configurados) y cierra el cliente de TigerBeetle al apagar. */
class LedgerLifecycle implements OnModuleInit, OnApplicationShutdown {
  private sweep: NodeJS.Timeout | undefined;

  constructor(
    @Inject(LEDGER_CONFIG) private readonly config: LedgerConfig,
    @Inject(TB_ENGINE) private readonly tb: TigerBeetleEngine,
    private readonly invariant: InvariantService,
    private readonly holds: HoldService,
    private readonly reconciler: ReconcilerService,
  ) {}

  onModuleInit(): void {
    // Antes de la primera petición. Con PAY_MODE=live no se acepta ningún doble.
    assertDeploymentSafe(this.config, { 'motor de TigerBeetle': this.tb });
    // Ningún id se calcula hasta que el servicio escucha.
    if (this.config.idNamespace) useIdNamespace(this.config.idNamespace);
    setEventsCarryMode(this.config.eventsCarryMode);
    this.invariant.start(this.config.invariantIntervalMs);
    // Busca lo que TigerBeetle aplicó y Postgres no registró (solo lee y avisa; ver reconciler.service.ts).
    this.reconciler.start(this.config.reconcileIntervalMs, this.config.reconcileOnStart);
    if (this.config.holdSweepIntervalMs > 0) {
      this.sweep = setInterval(() => void this.holds.sweepExpired(this.config.holdExpirySkewMs).catch(() => undefined), this.config.holdSweepIntervalMs);
      this.sweep.unref();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.invariant.stop();
    await this.reconciler.stop();
    if (this.sweep) clearInterval(this.sweep);
    this.tb.destroy();
  }
}

@Module({
  controllers: [LedgerController, PublicLedgerController],
  providers: [
    { provide: LEDGER_CONFIG, useFactory: () => loadLedgerConfig() },
    { provide: TB_ENGINE, inject: [LEDGER_CONFIG], useFactory: (config: LedgerConfig) => new TigerBeetleEngine(config.tb) },
    ServiceIdentityGuard,
    AccountRegistry,
    LedgerService,
    HoldService,
    InvariantService,
    ReconcilerService,
    LedgerLifecycle,
  ],
  exports: [LedgerService, HoldService, InvariantService, ReconcilerService, TB_ENGINE],
})
export class LedgerModule {}
