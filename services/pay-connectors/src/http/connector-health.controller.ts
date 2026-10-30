import { Controller, Get, Headers } from '@nestjs/common';
import { AllowedServices } from '@pay/service-auth';
import { HealthService } from '../core/health.service';
import { ModeGate } from '../core/pay-mode';

@Controller('connectors')
export class ConnectorHealthController {
  constructor(
    private readonly health: HealthService,
    private readonly mode: ModeGate,
  ) {}

  @Get('health')
  @AllowedServices('pay-payments', 'pay-settlement')
  async list(@Headers('x-pay-mode') payMode?: string): Promise<{ data: Array<Record<string, unknown>> }> {
    this.mode.optional(payMode); // la salud es del conector, no de un modo: opcional, pero si viene se valida
    return { data: await this.health.list() };
  }
}
