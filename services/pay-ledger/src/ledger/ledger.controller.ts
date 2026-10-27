import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AllowedServices, ServiceIdentityGuard } from '@pay/service-auth';
import { PROBLEM_CONTENT_TYPE } from '@pay/problem';
import { LEDGER_CALLERS } from './accounts';
import { HoldService } from './hold.service';
import { LedgerService } from './ledger.service';
import { requireIdempotencyKey } from './schemas';

/** API interna (`contracts/openapi/internal-ledger-v1.yaml`). Solo llaman los servicios de la política de cuentas. */
@Controller()
@UseGuards(ServiceIdentityGuard)
@AllowedServices(...LEDGER_CALLERS)
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly holds: HoldService,
  ) {}

  @Post('transactions')
  async createTransaction(
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireIdempotencyKey(key);
    const result = await this.ledger.createTransaction(body, caller);
    res.status(result.created ? 201 : 200);
    return result.body;
  }

  @Get('transactions/:businessRef')
  getTransaction(@Param('businessRef') businessRef: string) {
    return this.ledger.getTransaction(businessRef);
  }

  @Post('holds')
  async createHold(
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireIdempotencyKey(key);
    const result = await this.holds.createHold(body, caller);
    res.status(result.created ? 201 : 200);
    return result.body;
  }

  @Get('holds/:id')
  getHold(@Param('id') id: string) {
    return this.holds.getHold(id);
  }

  @Post('holds/:id/post')
  @HttpCode(200)
  async postHold(@Param('id') id: string, @Body() body: unknown, @Headers('x-service-id') caller: string, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.sendStored(res, await this.holds.postHold(id, body, caller, requireIdempotencyKey(key)));
  }

  @Post('holds/:id/void')
  @HttpCode(200)
  async voidHold(@Param('id') id: string, @Headers('x-service-id') caller: string, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: Response) {
    return this.sendStored(res, await this.holds.voidHold(id, caller, requireIdempotencyKey(key)));
  }

  @Get('balances')
  getBalance(@Query() query: unknown) {
    return this.ledger.getBalance(query);
  }

  @Get('statements')
  listStatement(@Query() query: unknown) {
    return this.ledger.listStatement(query);
  }

  /** Respuesta que pasó por la tabla de idempotencia: puede ser un error de negocio guardado (se repite tal cual). */
  private sendStored(res: Response, stored: { status: number; body: unknown; replayed: boolean }) {
    res.status(stored.status);
    if (stored.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
    if (stored.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return stored.body;
  }
}

/** API pública (`public-v1.yaml`): la autentica `pay-edge`, que manda el comercio en `X-Merchant-Id`. */
@Controller()
@UseGuards(ServiceIdentityGuard)
@AllowedServices('pay-edge')
export class PublicLedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('balance')
  getMerchantBalance(@Headers('x-merchant-id') merchantId: string | undefined) {
    return this.ledger.getMerchantBalance(merchantId);
  }
}
