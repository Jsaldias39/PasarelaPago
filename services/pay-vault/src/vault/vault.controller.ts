import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE, ProblemError } from '@pay/problem';
import { AllowedServices, SERVICE_ID_HEADER } from '@pay/service-auth';
import { containsPan } from '../redact';
import { VaultService } from './vault.service';

const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const TOKEN = /^tok_[a-z0-9]{10,60}$/;
const SESSION_ID = /^cs_[a-z0-9]{10,40}$/;

const merchantOf = (header: string | undefined): string => {
  if (!header || !MERCHANT_ID.test(header)) throw new ProblemError('validation_failed', { errors: [{ field: 'X-Merchant-Id', code: 'invalid_value' }] });
  return header;
};
const tokenOf = (value: string): string => {
  if (!TOKEN.test(value)) throw new ProblemError('resource_not_found');
  return value;
};
const keyOf = (header: string | undefined): string => {
  if (!header || header.length < 8 || header.length > 255) throw new ProblemError('idempotency_key_required');
  // La clave se guarda en la tabla de idempotencia: un número de tarjeta ahí sería un PAN en una base.
  if (containsPan(header)) throw new ProblemError('validation_failed', { errors: [{ field: 'Idempotency-Key', code: 'contains_card_number' }] });
  return header;
};

/**
 * `internal-vault-v1.yaml`. Todas las respuestas correctas llevan `Cache-Control: no-store` (los errores también: `ProblemFilter`): nada de lo que sale de la bóveda se cachea.
 * Mínimo privilegio donde el contrato no distingue: abrir y consultar capturas es de `pay-payments`; consultar o borrar un
 * token, de los dos; `reveal`, SOLO de `pay-connectors`.
 */
@Controller()
export class VaultController {
  constructor(@Inject(VaultService) private readonly vault: VaultService) {}

  @Post('capture_sessions')
  @Header('Cache-Control', 'no-store')
  @AllowedServices('pay-payments')
  async createCapture(@Headers(SERVICE_ID_HEADER) caller: string, @Headers('idempotency-key') key: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const result = await this.vault.createCaptureSession(caller, keyOf(key), body);
    res.status(result.status);
    res.setHeader('Idempotency-Replayed', String(result.replayed));
    if (result.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
    return result.body;
  }

  @Get('capture_sessions/:id')
  @Header('Cache-Control', 'no-store')
  @AllowedServices('pay-payments')
  getCapture(@Param('id') id: string): Promise<Record<string, unknown>> {
    if (!SESSION_ID.test(id)) throw new ProblemError('resource_not_found');
    return this.vault.getCaptureSession(id);
  }

  @Get('tokens/:token')
  @Header('Cache-Control', 'no-store')
  @AllowedServices('pay-payments', 'pay-connectors')
  getToken(@Headers('x-merchant-id') merchant: string | undefined, @Param('token') token: string): Promise<Record<string, unknown>> {
    return this.vault.getToken(merchantOf(merchant), tokenOf(token));
  }

  @Delete('tokens/:token')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @AllowedServices('pay-payments', 'pay-connectors')
  async deleteToken(@Headers('x-merchant-id') merchant: string | undefined, @Param('token') token: string): Promise<void> {
    await this.vault.deleteToken(merchantOf(merchant), tokenOf(token));
  }

  @Post('tokens/:token/reveal')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AllowedServices('pay-connectors')
  async reveal(@Headers(SERVICE_ID_HEADER) caller: string, @Headers('x-merchant-id') merchant: string | undefined, @Headers('idempotency-key') key: string | undefined, @Param('token') token: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    const card = await this.vault.reveal(caller, merchantOf(merchant), tokenOf(token), keyOf(key), body);
    return { number: card.number, exp_month: card.expMonth, exp_year: card.expYear, holder_name: card.holderName };
  }
}
