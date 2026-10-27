import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { ModeGate } from '../core/pay-mode';
import { RefundsService } from '../core/refunds.service';

/** Consulta de un reembolso por su id `cr_…`. La hace `pay-payments` para resolver un reembolso `pending` cuyo aviso no llegó. */
@Controller('refunds')
@AllowedServices('pay-payments')
export class RefundsController {
  constructor(
    private readonly refunds: RefundsService,
    private readonly mode: ModeGate,
  ) {}

  @Get(':id')
  async get(@Headers('x-pay-mode') payMode: string | undefined, @Param('id') id: string, @Query('refresh') refresh?: string): Promise<unknown> {
    const mode = this.mode.require(payMode);
    if (refresh !== undefined && refresh !== 'true' && refresh !== 'false') {
      throw new ProblemError('validation_failed', { errors: [{ field: 'refresh', code: 'invalid' }] });
    }
    return this.refunds.status(id, refresh === 'true', mode);
  }
}
