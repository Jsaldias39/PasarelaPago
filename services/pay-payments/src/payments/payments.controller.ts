import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE, ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import type { IdempotencyResult } from '@pay/idempotency';
import { containsPan } from '../domain/pan';
import { PaymentsService } from './payments.service';

const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const INTENT_ID = /^pi_[a-z0-9]{10,40}$/;
const REFUND_ID = /^re_[a-z0-9]{10,40}$/;

/** `X-Merchant-Id` lo pone pay-edge tras autenticar la clave de API; acá solo se valida la forma (la autoridad es el edge). */
function merchantOf(header: string | undefined): string {
  if (!header || !MERCHANT_ID.test(header)) throw new ProblemError('unauthorized', { detail: 'Falta la identidad del comercio' });
  return header;
}

export function idempotencyKeyOf(header: string | undefined): string {
  if (!header || header.length < 8 || header.length > 255) throw new ProblemError('idempotency_key_required');
  // La clave se guarda en la tabla de idempotencia: un número de tarjeta ahí sería un PAN en una base.
  if (containsPan(header)) throw new ProblemError('validation_failed', { errors: [{ field: 'Idempotency-Key', code: 'contains_card_number' }] });
  return header;
}

/** Un id con mala forma no llega a la base: es un 404, igual que uno ajeno. */
export function idOf(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new ProblemError('resource_not_found');
  return value;
}

export function reply(res: Response, result: IdempotencyResult): unknown {
  res.status(result.status);
  res.setHeader('Idempotency-Replayed', String(result.replayed));
  if (result.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
  return result.body;
}

/** API pública de cobros y reembolsos (`public-v1.yaml`), tal como la reenvía pay-edge: sin prefijo `/v1`. */
@Controller()
@AllowedServices('pay-edge')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Post('payment_intents')
  async create(@Headers('x-merchant-id') merchant: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return reply(res, await this.payments.createIntent(merchantOf(merchant), idempotencyKeyOf(key), body));
  }

  @Get('payment_intents')
  list(@Headers('x-merchant-id') merchant: string | undefined, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.payments.listIntents(merchantOf(merchant), query);
  }

  @Get('payment_intents/:id')
  get(@Headers('x-merchant-id') merchant: string | undefined, @Param('id') id: string): Promise<Record<string, unknown>> {
    return this.payments.getIntent(merchantOf(merchant), idOf(id, INTENT_ID));
  }

  @Post('payment_intents/:id/cancel')
  @HttpCode(200)
  async cancel(@Headers('x-merchant-id') merchant: string | undefined, @Headers('idempotency-key') key: string | undefined, @Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return reply(res, await this.payments.cancelIntent(merchantOf(merchant), idOf(id, INTENT_ID), idempotencyKeyOf(key)));
  }

  @Post('payment_intents/:id/refunds')
  async refund(@Headers('x-merchant-id') merchant: string | undefined, @Headers('idempotency-key') key: string | undefined, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return reply(res, await this.payments.createRefund(merchantOf(merchant), idOf(id, INTENT_ID), idempotencyKeyOf(key), body));
  }
}

export { REFUND_ID };
