import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { ModeGate } from '../core/pay-mode';
import { TransfersService } from '../core/transfers.service';
import { send } from './send';

/** Transferencias salientes (pagos a comercios). Solo `pay-settlement`. */
@Controller('transfers')
@AllowedServices('pay-settlement')
export class TransfersController {
  constructor(
    private readonly transfers: TransfersService,
    private readonly mode: ModeGate,
  ) {}

  @Post()
  async create(@Headers('x-pay-mode') payMode: string | undefined, @Headers('idempotency-key') key: string | undefined, @Headers('x-service-id') caller: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const mode = this.mode.require(payMode); // primero el modo: sin modo válido no hay efecto alguno
    if (!key) throw new ProblemError('idempotency_key_required');
    return send(res, await this.transfers.create(caller, mode, key, body));
  }

  @Get(':reference')
  async get(@Headers('x-pay-mode') payMode: string | undefined, @Param('reference') reference: string): Promise<unknown> {
    return this.transfers.get(reference, this.mode.require(payMode));
  }
}
