import { Controller, Delete, Get, HttpCode, Param, Post, Query, Req, Res, Body } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { EndpointService } from './endpoint.service';

const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const ENDPOINT_ID = /^we_[a-z0-9]{10,40}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/;

/**
 * Las tres rutas públicas de `webhook_endpoints` (public-v1.yaml). Solo pay-edge puede llamarlas, y el comercio sale de la
 * cabecera `X-Merchant-Id` que pay-edge fija al autenticar (el cliente nunca la controla).
 */
@Controller('webhook_endpoints')
@AllowedServices('pay-edge')
export class EndpointController {
  constructor(private readonly endpoints: EndpointService) {}

  private merchant(req: Request): string {
    const value = req.headers['x-merchant-id'];
    if (typeof value !== 'string' || !MERCHANT_ID.test(value)) throw new ProblemError('unauthorized');
    return value;
  }

  private idempotencyKey(req: Request): string {
    const value = req.headers['idempotency-key'];
    if (value === undefined) throw new ProblemError('idempotency_key_required');
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) throw new ProblemError('validation_failed', { errors: [{ field: 'idempotency-key', code: 'invalid_format' }] });
    return value;
  }

  private endpointId(id: string): string {
    // Un id con formato inválido nunca puede existir: mismo 404 que cualquier otro inexistente.
    if (!ENDPOINT_ID.test(id)) throw new ProblemError('resource_not_found');
    return id;
  }

  @Post()
  async create(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    const merchantId = this.merchant(req);
    const result = await this.endpoints.create(merchantId, this.idempotencyKey(req), body);
    this.send(res, result);
  }

  @Get()
  list(@Req() req: Request, @Query('limit') limit?: string, @Query('starting_after') startingAfter?: string) {
    const merchantId = this.merchant(req);
    const parsed = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new ProblemError('validation_failed', { errors: [{ field: 'limit', code: 'out_of_range' }] });
    return this.endpoints.list(merchantId, parsed, startingAfter);
  }

  @Post(':id/rotate_secret')
  @HttpCode(200)
  async rotate(@Req() req: Request, @Res() res: Response, @Param('id') id: string): Promise<void> {
    const merchantId = this.merchant(req);
    const result = await this.endpoints.rotateSecret(merchantId, this.idempotencyKey(req), this.endpointId(id));
    this.send(res, result);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string): Promise<void> {
    await this.endpoints.remove(this.merchant(req), this.endpointId(id));
  }

  private send(res: Response, result: { status: number; body: unknown; replayed: boolean }): void {
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    res.setHeader('Cache-Control', 'no-store'); // la respuesta lleva un secreto
    if (result.status >= 400) res.type('application/problem+json');
    res.status(result.status).json(result.body);
  }
}
