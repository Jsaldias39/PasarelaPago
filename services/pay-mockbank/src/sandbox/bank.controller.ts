import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { AllowedServices } from '@pay/service-auth';
import type { Response } from 'express';
import { BankService, type CardView, type ChargeView } from '../bank/bank.service';
import { toCamt053, toCsv } from '../bank/statement-format';
import { CLOCK, type Clock } from '../clock';
import { parseCapture, parseCardAuthorization, parseCreateCharge, parseCreateRefund, parseCreateTransfer, parseQr, parseRange } from './dto';
import { ModeGate } from './mode.gate';

const chargeBody = (v: ChargeView) => ({ bank_reference: v.bankReference, status: v.status, ...(v.failureCode ? { failure_code: v.failureCode } : {}), occurred_at: v.occurredAt.toISOString() });
const cardBody = (v: CardView) => ({ bank_reference: v.bankReference, status: v.status, amount_minor: Number(v.amountMinor), captured_minor: Number(v.capturedMinor), ...(v.failureCode ? { failure_code: v.failureCode } : {}) });

/**
 * Lo que expondría «el banco» (FICTICIO, SANDBOX): cobros, QR, reembolsos, transferencias, autorización de tarjeta y extracto. Lo llama
 * `pay-connectors`. Todo es idempotente por la referencia que manda la pasarela. Ningún campo es de un banco real (Q-01, Q-11).
 * Contrato propuesto: `openapi/mockbank-v1.proposal.yaml`.
 */
@Controller('sandbox')
@AllowedServices('pay-connectors')
export class BankController {
  constructor(
    private readonly bank: BankService,
    private readonly mode: ModeGate,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('probe')
  async probe(@Headers('x-pay-mode') payMode?: string | string[]): Promise<{ status: 'ok' }> {
    this.mode.require(payMode);
    await this.bank.ensureUp(); // caído: 503 `bank_unavailable`
    return { status: 'ok' };
  }

  // ── cobros ──
  @Post('charges')
  async createCharge(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    this.mode.require(payMode);
    const input = parseCreateCharge(body);
    const { view, created } = await this.bank.createCharge(input);
    res.status(created ? 201 : 200);
    return chargeBody(view);
  }

  @Get('charges/:reference')
  async getCharge(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string) {
    this.mode.require(payMode);
    return chargeBody(await this.bank.getCharge(reference));
  }

  @Put('charges/:reference/qr')
  async registerQr(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string, @Body() body: unknown) {
    this.mode.require(payMode);
    await this.bank.registerQr(reference, parseQr(body));
    return { reference, qr_registered: true };
  }

  @Post('charges/:reference/cancel')
  @HttpCode(200)
  async cancel(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string) {
    this.mode.require(payMode);
    return { status: await this.bank.cancelCharge(reference) };
  }

  // ── reembolsos ──
  @Post('refunds')
  async refund(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    this.mode.require(payMode);
    const result = await this.bank.refund(parseCreateRefund(body));
    res.status(result.status === 'captured' ? 201 : 200);
    return { bank_reference: result.bankReference, status: result.status, ...(result.failureCode ? { failure_code: result.failureCode } : {}) };
  }

  @Get('refunds/:reference')
  async getRefund(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string) {
    this.mode.require(payMode);
    const found = await this.bank.getRefund(reference);
    return { bank_reference: found.bankReference, status: found.status };
  }

  // ── transferencias salientes ──
  @Post('transfers')
  @HttpCode(200)
  async transfer(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Body() body: unknown) {
    this.mode.require(payMode);
    const result = await this.bank.transfer(parseCreateTransfer(body));
    return { bank_reference: result.bankReference, status: result.status, ...(result.failureCode ? { failure_code: result.failureCode } : {}) };
  }

  @Get('transfers/:reference')
  async getTransfer(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string) {
    this.mode.require(payMode);
    const result = await this.bank.getTransfer(reference);
    return { bank_reference: result.bankReference, status: result.status, ...(result.failureCode ? { failure_code: result.failureCode } : {}) };
  }

  // ── tarjeta: autorización → captura | anulación ──
  @Post('card-authorizations')
  async authorize(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    this.mode.require(payMode);
    const { view, created } = await this.bank.authorizeCard(parseCardAuthorization(body));
    res.status(created ? 201 : 200);
    return cardBody(view);
  }

  @Get('card-authorizations/:reference')
  async getAuthorization(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string) {
    this.mode.require(payMode);
    return cardBody(await this.bank.getCard(reference));
  }

  @Post('card-authorizations/:reference/capture')
  @HttpCode(200)
  async capture(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string, @Body() body: unknown) {
    this.mode.require(payMode);
    return cardBody(await this.bank.captureCard(reference, parseCapture(body)));
  }

  @Post('card-authorizations/:reference/void')
  @HttpCode(200)
  async voidAuthorization(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Param('reference') reference: string) {
    this.mode.require(payMode);
    return cardBody(await this.bank.voidCard(reference));
  }

  // ── extracto: JSON | CSV | camt.053 ──
  @Get('statement')
  async statement(@Headers('x-pay-mode') payMode: string | string[] | undefined, @Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    this.mode.require(payMode);
    const range = parseRange(query);
    const entries = await this.bank.statement(range);
    if (range.format === 'csv') {
      res.status(200).type('text/csv; charset=utf-8').send(toCsv(entries));
    } else if (range.format === 'camt053') {
      res.status(200).type('application/xml; charset=utf-8').send(toCamt053(entries, range, this.clock.now()));
    } else {
      res.status(200).json({
        data: entries.map((e) => ({
          bank_reference: e.bankReference,
          our_reference: e.ourReference,
          direction: e.direction,
          amount_minor: Number(e.amountMinor),
          currency: 'BOB',
          value_date: e.valueDate,
          booked_at: e.bookedAt.toISOString(),
          description: e.description,
        })),
      });
    }
  }
}
