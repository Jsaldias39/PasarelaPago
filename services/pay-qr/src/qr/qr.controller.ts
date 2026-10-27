import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { hashRequest, IdempotencyStore, type HandlerResult } from '@pay/idempotency';
import { PROBLEM_CONTENT_TYPE, ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { renderQr } from './qr-image';
import { parseCreateQr } from './qr.dto';
import { QrService } from './qr.service';

const QR_ID = /^qr_[a-z0-9]{10,40}$/;
const REFERENCE = /^[A-Za-z0-9]{1,25}$/;

/** Rutas internas de pay-qr. Las llama pay-connectors (el contrato propuesto está en docs/trabajo/ola-1/P4/propuesta/). */
@Controller()
@AllowedServices('pay-connectors')
export class QrController {
  constructor(
    private readonly qr: QrService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  private id(raw: string): string {
    if (!QR_ID.test(raw)) throw new ProblemError('resource_not_found'); // no se distingue «mal formado» de «no existe»
    return raw;
  }

  @Post('qr')
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-service-id') caller: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    if (!key) throw new ProblemError('idempotency_key_required');
    const input = parseCreateQr(body);
    const result = await this.idempotency.execute({ scope: caller, key, requestHash: hashRequest({ method: 'POST', path: '/qr', body }) }, async (): Promise<HandlerResult> => {
      const { qr, created } = await this.qr.create(input);
      return { status: created ? 201 : 200, body: this.qr.toView(qr) };
    });
    return send(res, result);
  }

  @Post('qr/decode')
  @HttpCode(200)
  decode(@Body() body: { payload?: unknown }) {
    if (typeof body?.payload !== 'string') throw new ProblemError('validation_failed', { errors: [{ field: 'payload', code: 'invalid' }] });
    const parsed = this.qr.decode(body.payload);
    return {
      crc_valid: parsed.crcValid,
      point_of_initiation: parsed.pointOfInitiation,
      amount: parsed.amount,
      currency_numeric: parsed.currencyNumeric,
      country: parsed.country,
      merchant_name: parsed.merchantName,
      merchant_city: parsed.merchantCity,
      reference_label: parsed.referenceLabel,
    };
  }

  @Get('qr-references/:reference')
  async byReference(@Param('reference') reference: string) {
    if (!REFERENCE.test(reference)) throw new ProblemError('resource_not_found');
    return this.qr.toView(await this.qr.getByReference(reference));
  }

  @Get('qr/:id')
  async get(@Param('id') id: string) {
    return this.qr.toView(await this.qr.get(this.id(id)));
  }

  @Get('qr/:id/image')
  async image(@Param('id') id: string, @Query('format') format: string | undefined, @Res() res: Response): Promise<void> {
    const kind = format ?? 'svg';
    if (kind !== 'svg' && kind !== 'png') throw new ProblemError('validation_failed', { errors: [{ field: 'format', code: 'invalid' }] });
    const row = await this.qr.get(this.id(id));
    const image = await renderQr(row.payload, kind);
    res.status(200).type(kind === 'svg' ? 'image/svg+xml' : 'image/png').set('Cache-Control', 'no-store').send(image);
  }

  @Post('qr/:id/cancel')
  @HttpCode(200)
  async cancel(@Param('id') id: string) {
    return this.qr.toView(await this.qr.cancel(this.id(id)));
  }
}

function send(res: Response, result: { status: number; body: unknown; replayed: boolean }): unknown {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  if (result.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
  return result.body;
}
