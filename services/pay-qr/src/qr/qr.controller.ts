import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { hashRequest, IdempotencyStore, type HandlerResult } from '@pay/idempotency';
import { PROBLEM_CONTENT_TYPE, ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { ModeGate } from './pay-mode';
import { renderQr } from './qr-image';
import { parseCreateQr } from './qr.dto';
import { QrService } from './qr.service';

const QR_ID = /^qr_[a-z0-9]{10,40}$/;
const REFERENCE = /^[A-Za-z0-9]{1,25}$/;

/** Rutas internas de pay-qr. Las llama pay-connectors (contrato: contracts/openapi/internal-qr-v1.yaml). */
@Controller()
@AllowedServices('pay-connectors')
export class QrController {
  constructor(
    private readonly qr: QrService,
    private readonly idempotency: IdempotencyStore,
    private readonly mode: ModeGate,
  ) {}

  private id(raw: string): string {
    if (!QR_ID.test(raw)) throw new ProblemError('resource_not_found'); // no se distingue «mal formado» de «no existe»
    return raw;
  }

  @Post('qr')
  async create(
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-service-id') caller: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const mode = this.mode.require(payMode); // primero el modo: sin modo válido no hay efecto alguno
    if (!key) throw new ProblemError('idempotency_key_required');
    const input = parseCreateQr(body);
    const result = await this.idempotency.execute({ scope: `${caller}|${mode}`, key, requestHash: hashRequest({ method: 'POST', path: '/qr', body }) }, async (): Promise<HandlerResult> => {
      const { qr, created } = await this.qr.create(input, mode);
      return { status: created ? 201 : 200, body: this.qr.toView(qr) };
    });
    return send(res, result);
  }

  @Post('qr/decode')
  @HttpCode(200)
  decode(@Headers('x-pay-mode') payMode: string | undefined, @Body() body: { payload?: unknown }) {
    this.mode.require(payMode); // utilidad sin estado, pero igual exige el modo: toda ruta interna de qr lo pide
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
  async byReference(@Headers('x-pay-mode') payMode: string | undefined, @Param('reference') reference: string) {
    const mode = this.mode.require(payMode);
    if (!REFERENCE.test(reference)) throw new ProblemError('resource_not_found');
    return this.qr.toView(await this.qr.getByReference(reference, mode));
  }

  @Get('qr/:id')
  async get(@Headers('x-pay-mode') payMode: string | undefined, @Param('id') id: string) {
    const mode = this.mode.require(payMode);
    return this.qr.toView(await this.qr.get(this.id(id), mode));
  }

  @Get('qr/:id/image')
  async image(@Headers('x-pay-mode') payMode: string | undefined, @Param('id') id: string, @Query('format') format: string | undefined, @Res() res: Response): Promise<void> {
    const mode = this.mode.require(payMode);
    const kind = format ?? 'svg';
    if (kind !== 'svg' && kind !== 'png') throw new ProblemError('validation_failed', { errors: [{ field: 'format', code: 'invalid' }] });
    const row = await this.qr.get(this.id(id), mode);
    const image = await renderQr(row.payload, kind);
    res.status(200).type(kind === 'svg' ? 'image/svg+xml' : 'image/png').set('Cache-Control', 'no-store').send(image);
  }

  @Post('qr/:id/cancel')
  @HttpCode(200)
  async cancel(@Headers('x-pay-mode') payMode: string | undefined, @Param('id') id: string) {
    const mode = this.mode.require(payMode);
    return this.qr.toView(await this.qr.cancel(this.id(id), mode));
  }
}

function send(res: Response, result: { status: number; body: unknown; replayed: boolean }): unknown {
  res.status(result.status);
  if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
  if (result.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
  return result.body;
}
