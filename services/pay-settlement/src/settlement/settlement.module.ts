import { Inject, Injectable, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ServiceIdentityGuard } from '@pay/service-auth';
import { BatchService } from './batch.service';
import { SettlementConsumers } from './consumers';
import { AccountingExportService } from './export.service';
import { HttpConnectorsClient, HttpLedgerClient } from './http-clients';
import { NettingService } from './netting.service';
import { JwtOperatorVerifier } from './operator-token';
import { PayoutService, type RailMap } from './payout.service';
import { CONNECTORS_PORT, type ConnectorsPort, LEDGER_PORT, OPERATOR_VERIFIER, PAYOUT_RAILS } from './ports';
import { AcquirerSettlementRail, BankTransferRail } from './rails';
import { setEventsCarryMode } from './event-mode';
import { ReconciliationService } from './reconciliation.service';
import { SETTLEMENT_CONFIG, type SettlementConfig, loadSettlementConfig } from './settlement.config';
import { SettlementController } from './settlement.controller';

/** Arranque y barrido periódico: retoma lo que quedó a medias (pagos, cortes, corridas) y avisa en claro si el riel es un doble. */
@Injectable()
class SettlementLifecycle implements OnModuleInit, OnApplicationShutdown {
  private sweep: NodeJS.Timeout | undefined;

  constructor(
    @Inject(SETTLEMENT_CONFIG) private readonly config: SettlementConfig,
    private readonly payouts: PayoutService,
    private readonly batches: BatchService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async onModuleInit(): Promise<void> {
    setEventsCarryMode(this.config.eventsCarryMode);
    if (this.config.mode === 'acquirer') {
      new Logger('SettlementMode').warn('settlement.mode=acquirer: el riel acquirer_settlement es un DOBLE declarado (D-02); los pagos salen marcados simulated=true y NO mueven dinero');
    }
    if (this.config.sweepIntervalMs <= 0) return;
    this.sweep = setInterval(() => void this.once().catch(() => undefined), this.config.sweepIntervalMs);
    this.sweep.unref();
  }

  private async once(): Promise<void> {
    await this.payouts.recover();
    await this.batches.resumeRunning();
    await this.reconciliation.resumeRunning();
  }

  onApplicationShutdown(): void {
    if (this.sweep) clearInterval(this.sweep);
  }
}

@Module({
  controllers: [SettlementController],
  providers: [
    { provide: SETTLEMENT_CONFIG, useFactory: () => loadSettlementConfig() },
    { provide: LEDGER_PORT, inject: [SETTLEMENT_CONFIG], useFactory: (c: SettlementConfig) => new HttpLedgerClient(c.ledgerUrl, c.httpTimeoutMs) },
    { provide: CONNECTORS_PORT, inject: [SETTLEMENT_CONFIG], useFactory: (c: SettlementConfig) => new HttpConnectorsClient(c.connectorsUrl, c.httpTimeoutMs, c.transferConnector) },
    {
      provide: PAYOUT_RAILS,
      inject: [CONNECTORS_PORT],
      useFactory: (connectors: ConnectorsPort): RailMap => ({ bank_transfer: new BankTransferRail(connectors), acquirer_settlement: new AcquirerSettlementRail() }),
    },
    {
      provide: OPERATOR_VERIFIER,
      inject: [SETTLEMENT_CONFIG],
      useFactory: (c: SettlementConfig) => new JwtOperatorVerifier(c.operator.publicKeyPem, c.operator.issuer, c.operator.audience),
    },
    ServiceIdentityGuard,
    SettlementConsumers,
    PayoutService,
    NettingService,
    BatchService,
    ReconciliationService,
    AccountingExportService,
    SettlementLifecycle,
  ],
  exports: [SETTLEMENT_CONFIG, SettlementConsumers, PayoutService],
})
export class SettlementModule {}
