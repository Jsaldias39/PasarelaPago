import { Body, Controller, Get, Headers, Param, Post, Query, Res, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { ChargesService } from '../core/charges.service';
import { chargeView } from '../core/rows';
import { RefundsService } from '../core/refunds.service';
import { send } from './send';

/** Cobros y reembolsos. Los pide `pay-payments`; `pay-settlement` solo lee. */
@Controller('charges')
export class ChargesController {
  constructor(
    private readonly charges: ChargesService,
    private readonly refunds: RefundsService,
  ) {}

  private requireKey(key: string | undefined): string {
    if (!key) throw new ProblemError('idempotency_key_required');
    return key;
  }

  @Post()
  @AllowedServices('pay-payments')
  async create(@Headers('idempotency-key') key: string | undefined, @Headers('x-service-id') caller: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return send(res, await this.charges.create(caller, this.requireKey(key), body));
  }

  @Get(':id')
  @AllowedServices('pay-payments', 'pay-settlement')
  async get(@Param('id') id: string): Promise<unknown> {
    return chargeView(await this.charges.byId(id));
  }

  @Get(':id/status')
  @AllowedServices('pay-payments', 'pay-settlement')
  async status(@Param('id') id: string, @Query('refresh') refresh?: string): Promise<unknown> {
    if (refresh !== undefined && refresh !== 'true' && refresh !== 'false') {
      throw new ProblemError('validation_failed', { errors: [{ field: 'refresh', code: 'invalid' }] });
    }
    return this.charges.status(id, refresh === 'true');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @AllowedServices('pay-payments')
  async cancel(@Headers('idempotency-key') key: string | undefined, @Headers('x-service-id') caller: string, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return send(res, await this.charges.cancel(caller, this.requireKey(key), id));
  }

  @Post(':id/refunds')
  @AllowedServices('pay-payments')
  async refund(@Headers('idempotency-key') key: string | undefined, @Headers('x-service-id') caller: string, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return send(res, await this.refunds.create(caller, this.requireKey(key), id, body));
  }
}
