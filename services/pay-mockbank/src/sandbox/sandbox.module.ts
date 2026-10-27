import { Module } from '@nestjs/common';
import { BankService } from '../bank/bank.service';
import { DeliveryService } from '../bank/delivery.service';
import { CLOCK, systemClock } from '../clock';
import { AdminController } from './admin.controller';
import { BankController } from './bank.controller';
import { ModeGate } from './mode.gate';
import { PayerService } from './payer.service';

@Module({
  controllers: [BankController, AdminController],
  providers: [{ provide: CLOCK, useValue: systemClock }, BankService, DeliveryService, PayerService, ModeGate],
  exports: [BankService, DeliveryService],
})
export class SandboxModule {}
