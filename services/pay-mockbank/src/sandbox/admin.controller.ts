import { Body, Controller, HttpCode, Post, Put } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { BankService } from '../bank/bank.service';
import { DeliveryService } from '../bank/delivery.service';
import { parseInject, parsePay } from './dto';
import { PayerService } from './payer.service';

/**
 * Pagador simulado y controles del administrador del simulador. NO son parte de lo que expondría un banco: existen para que una
 * persona o una prueba maneje la capa sandbox. Las llama el CLI `mockbank` (identidad `pay-mockbank`).
 */
@Controller('sandbox')
@AllowedServices('pay-mockbank')
export class AdminController {
  constructor(
    private readonly bank: BankService,
    private readonly delivery: DeliveryService,
    private readonly payer: PayerService,
  ) {}

  /** «Paga» un QR emitido por la pasarela: lo decodifica con pay-qr, comprueba CRC, moneda y monto, y se lo cobra al pagador simulado. */
  @Post('payer/pay')
  @HttpCode(200)
  async pay(@Body() body: unknown) {
    const result = await this.payer.pay(parsePay(body));
    return { charge_reference: result.chargeReference, status: result.status, amount_minor: Number(result.amountMinor), already_paid: result.alreadyPaid };
  }

  @Post('admin/deliver')
  @HttpCode(200)
  async deliver() {
    return this.delivery.deliverDue();
  }

  @Post('admin/reset')
  @HttpCode(200)
  async reset() {
    await this.bank.reset();
    return { reset: true };
  }

  @Put('admin/down')
  async down(@Body() body: unknown) {
    const down = (body as { down?: unknown } | null)?.down;
    if (typeof down !== 'boolean') throw new ProblemError('validation_failed', { errors: [{ field: 'down', code: 'invalid' }] });
    await this.bank.setDown(down);
    return { down };
  }

  @Post('admin/statement-lines')
  async injectLine(@Body() body: unknown) {
    return { bank_reference: await this.bank.injectStatementLine(parseInject(body)) };
  }
}
