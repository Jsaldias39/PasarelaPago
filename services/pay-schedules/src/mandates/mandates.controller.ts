import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import type { Response } from 'express';
import { compile, requireIdempotencyKey } from '../validation';
import { MandatesService, type Mode, type MandateInput } from './mandates.service';

const parseMandate = compile<MandateInput>({
  type: 'object',
  required: ['kind', 'beneficiary_merchant_id', 'amount_minor', 'currency', 'schedule'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['pay_obligation', 'pay_commission'] },
    beneficiary_merchant_id: { type: 'string', pattern: '^mc_[a-z0-9]{10,40}$' },
    amount_minor: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
    currency: { type: 'string', enum: ['BOB'] },
    schedule: {
      type: 'object',
      required: ['frequency', 'day_of_month', 'start_date'],
      additionalProperties: false,
      properties: {
        frequency: { type: 'string', const: 'monthly' },
        day_of_month: { type: 'integer', minimum: 1, maximum: 28 },
        start_date: { type: 'string', format: 'date' },
        end_date: { type: ['string', 'null'], format: 'date' },
      },
    },
    description: { type: 'string', maxLength: 200 },
  },
});

const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const MANDATE_ID = /^md_[a-z0-9]{10,40}$/;

/** El comercio autenticado lo fija pay-edge en `X-Merchant-Id`. Sin él (o mal formado) no hay a quién servir: 403. */
function merchantOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !MERCHANT_ID.test(value)) throw new ForbiddenException();
  return value;
}

/** D-28: el modo lo fija pay-edge desde el registro de la clave y lo reenvía en `X-Pay-Mode`. Nunca sale del cuerpo ni del token. */
function modeOf(header: string | string[] | undefined): Mode {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== 'test' && value !== 'live') throw new ForbiddenException();
  return value;
}

/** `POST/GET /mandates` y `DELETE /mandates/{id}` de `public-v1.yaml`, tal como las reenvía pay-edge. */
@Controller('mandates')
@AllowedServices('pay-edge')
export class MandatesController {
  constructor(private readonly mandates: MandatesService) {}

  @Post()
  async create(
    @Headers('x-merchant-id') merchant: string | undefined,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') idem: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const merchantId = merchantOf(merchant);
    const mode = modeOf(payMode);
    const key = requireIdempotencyKey(idem);
    const input = parseMandate(body);
    const result = await this.mandates.create(merchantId, mode, key, hashRequest({ method: 'POST', path: '/mandates', body: input }), input);
    res.status(result.status);
    if (result.status === 200) res.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Get()
  list(
    @Headers('x-merchant-id') merchant: string | undefined,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('starting_after') startingAfter: string | undefined,
  ) {
    const merchantId = merchantOf(merchant);
    const mode = modeOf(payMode);
    let limit = 20;
    if (limitRaw !== undefined) {
      if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) throw new ProblemError('validation_failed', { errors: [{ field: 'limit', code: 'range' }] });
      limit = Number(limitRaw);
    }
    if (startingAfter !== undefined && (startingAfter.length === 0 || startingAfter.length > 200)) throw new ProblemError('validation_failed', { errors: [{ field: 'starting_after', code: 'invalid' }] });
    return this.mandates.list(merchantId, mode, limit, startingAfter);
  }

  @Delete(':id')
  @HttpCode(204)
  async cancel(@Headers('x-merchant-id') merchant: string | undefined, @Headers('x-pay-mode') payMode: string | undefined, @Param('id') id: string): Promise<void> {
    const merchantId = merchantOf(merchant);
    const mode = modeOf(payMode);
    // Un id mal formado se trata igual que uno ajeno: 404, sin distinguir.
    if (!MANDATE_ID.test(id)) throw new ProblemError('resource_not_found');
    await this.mandates.cancel(merchantId, mode, id);
  }
}
