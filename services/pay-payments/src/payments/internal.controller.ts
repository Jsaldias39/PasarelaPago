import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AllowedServices } from '@pay/service-auth';
import { idempotencyKeyOf, idOf, reply } from './payments.controller';
import { PaymentsService } from './payments.service';

/** `internal-payments-v1.yaml`: cobros que inician otros servicios. Solo `pay-schedules` (mandatos, procesos 7.7 y 7.8). */
@Controller('intents')
@AllowedServices('pay-schedules')
export class InternalPaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post()
  async create(@Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return reply(res, await this.payments.createInternalIntent(idempotencyKeyOf(key), body));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.payments.getInternalIntent(idOf(id, /^pi_[a-z0-9]{10,40}$/));
  }
}
