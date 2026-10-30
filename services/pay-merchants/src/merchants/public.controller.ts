import { Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { ApiKeyMode } from '@pay/api-key';
import { hashRequest } from '@pay/idempotency';
import { AllowedServices } from '@pay/service-auth';
import type { Response } from 'express';
import type { Pool } from 'pg';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { PG_POOL } from '../database.module';
import { FeesService } from '../fees/fees.service';
import { ProblemError } from '@pay/problem';
import { MERCHANT_ID, compile, requireIdempotencyKey } from '../validation';

const KEY_ID = /^key_[a-z0-9]{10,40}$/;

const parseCreateKey = compile<{ mode: 'test' | 'live'; label?: string }>({
  type: 'object',
  required: ['mode'],
  additionalProperties: false,
  properties: { mode: { type: 'string', enum: ['test', 'live'] }, label: { type: 'string', maxLength: 80 } },
});

/** El comercio autenticado lo fija pay-edge en `X-Merchant-Id`. Sin él (o mal formado) no hay a quién servir: 403. */
function merchantOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !MERCHANT_ID.test(value)) throw new ForbiddenException();
  return value;
}

/**
 * D-28: el modo del llamador lo fija pay-edge desde el registro de la clave y lo reenvía en `X-Pay-Mode`. Nunca sale del
 * cuerpo ni del token. Sin la cabecera, o con un valor que no sea `test`/`live`, no hay a quién servir: 403.
 */
function modeOf(header: string | string[] | undefined): ApiKeyMode {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== 'test' && value !== 'live') throw new ForbiddenException();
  return value;
}

function keyIdOf(value: string): string {
  // Un id mal formado se trata igual que uno ajeno: 404, sin distinguir.
  if (!KEY_ID.test(value)) throw new ProblemError('resource_not_found');
  return value;
}

/** Rutas públicas (`public-v1.yaml`) que ve el comercio a través de pay-edge. Todo se filtra por `X-Merchant-Id`. */
@Controller()
@AllowedServices('pay-edge')
export class PublicController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly fees: FeesService,
    private readonly keys: ApiKeysService,
  ) {}

  @Get('merchants/me')
  async me(@Headers('x-merchant-id') header: string | undefined, @Headers('x-pay-mode') payMode: string | undefined) {
    const id = merchantOf(header);
    modeOf(payMode);
    const { rows } = await this.pool.query('SELECT id, status, display_name FROM merchants WHERE id = $1', [id]);
    if (rows.length === 0) throw new ProblemError('resource_not_found');
    const schedule = await this.fees.current(this.pool, id);
    return {
      id: rows[0].id as string,
      object: 'merchant',
      status: rows[0].status as string,
      display_name: rows[0].display_name as string,
      // version 0 = todavía no hay un tarifario en vigencia (el contrato exige el objeto)
      fee_schedule: { version: schedule?.version ?? 0, channels: schedule?.channels ?? [] },
    };
  }

  @Post('api_keys')
  async create(@Headers('x-merchant-id') merchant: string | undefined, @Headers('x-pay-mode') payMode: string | undefined, @Headers('idempotency-key') idem: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const merchantId = merchantOf(merchant);
    const callerMode = modeOf(payMode);
    const key = requireIdempotencyKey(idem);
    const input = parseCreateKey(body);
    // Una clave de un modo no crea claves del otro (D-28): 403 antes de tocar nada.
    if (input.mode !== callerMode) throw new ForbiddenException();
    const result = await this.keys.create(merchantId, key, hashRequest({ method: 'POST', path: '/api_keys', body: input }), input);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Get('api_keys')
  list(@Headers('x-merchant-id') merchant: string | undefined, @Headers('x-pay-mode') payMode: string | undefined) {
    return this.keys.list(merchantOf(merchant), modeOf(payMode));
  }

  @Post('api_keys/:id/rotate')
  async rotate(@Headers('x-merchant-id') merchant: string | undefined, @Headers('x-pay-mode') payMode: string | undefined, @Headers('idempotency-key') idem: string | undefined, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const merchantId = merchantOf(merchant);
    const callerMode = modeOf(payMode);
    const key = requireIdempotencyKey(idem);
    const keyId = keyIdOf(id);
    const result = await this.keys.rotate(merchantId, keyId, key, hashRequest({ method: 'POST', path: `/api_keys/${keyId}/rotate`, body: { mode: callerMode } }), callerMode);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Delete('api_keys/:id')
  @HttpCode(204)
  async revoke(@Headers('x-merchant-id') merchant: string | undefined, @Headers('x-pay-mode') payMode: string | undefined, @Param('id') id: string): Promise<void> {
    await this.keys.revoke(merchantOf(merchant), keyIdOf(id), 'revoked_by_merchant', new Date(), modeOf(payMode));
  }
}
