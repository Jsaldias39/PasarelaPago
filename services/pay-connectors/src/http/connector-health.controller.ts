import { Controller, Get } from '@nestjs/common';
import { AllowedServices } from '@pay/service-auth';
import { HealthService } from '../core/health.service';

@Controller('connectors')
export class ConnectorHealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  @AllowedServices('pay-payments', 'pay-settlement')
  async list(): Promise<{ data: Array<Record<string, unknown>> }> {
    return { data: await this.health.list() };
  }
}
