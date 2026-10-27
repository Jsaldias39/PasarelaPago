import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { RefundsService } from '../core/refunds.service';

/** Consulta de un reembolso por su id `cr_…`. La hace `pay-payments` para resolver un reembolso `pending` cuyo aviso no llegó. */
@Controller('refunds')
@AllowedServices('pay-payments')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get(':id')
  async get(@Param('id') id: string, @Query('refresh') refresh?: string): Promise<unknown> {
    if (refresh !== undefined && refresh !== 'true' && refresh !== 'false') {
      throw new ProblemError('validation_failed', { errors: [{ field: 'refresh', code: 'invalid' }] });
    }
    return this.refunds.status(id, refresh === 'true');
  }
}
