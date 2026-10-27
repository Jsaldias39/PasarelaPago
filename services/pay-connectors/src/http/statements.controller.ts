import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AllowedServices } from '@pay/service-auth';
import { ModeGate } from '../core/pay-mode';
import { negotiate, StatementsService } from '../core/statements.service';

@Controller('statements')
export class StatementsController {
  constructor(
    private readonly statements: StatementsService,
    private readonly mode: ModeGate,
  ) {}

  @Get()
  @AllowedServices('pay-settlement')
  async get(
    @Headers('x-pay-mode') payMode: string | undefined,
    @Query('connector') connector: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('starting_after') startingAfter: string | undefined,
    @Headers('accept') accept: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.statements.get(
      { ...(connector !== undefined && { connector }), ...(from !== undefined && { from }), ...(to !== undefined && { to }), ...(limit !== undefined && { limit }), ...(startingAfter !== undefined && { startingAfter }) },
      negotiate(accept),
      this.mode.optional(payMode), // el contrato lo declara opcional aquí; si viene, se valida igual y filtra el emparejamiento
    );
    res.status(200).type(result.contentType).send(result.body);
  }
}
