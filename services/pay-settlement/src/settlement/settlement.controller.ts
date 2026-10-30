import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PROBLEM_CONTENT_TYPE, ProblemError } from '@pay/problem';
import { AllowedServices, ServiceIdentityGuard } from '@pay/service-auth';
import { BatchService } from './batch.service';
import { batchDto, exceptionDto, payoutDto, publicPayoutDto, runDto } from './dto';
import { AccountingExportService, exportToCsv } from './export.service';
import { NettingService } from './netting.service';
import { PayoutService } from './payout.service';
import { OPERATOR_VERIFIER, type OperatorVerifier } from './ports';
import { ReconciliationService } from './reconciliation.service';
import { requirePayMode } from './mode';
import { merchantId, requireIdempotencyKey } from './schemas';
import { SETTLEMENT_CONFIG, type SettlementConfig } from './settlement.config';

/**
 * Quién llama a qué (decisión de la ola 1, DECISIONES-TOMADAS.md): `pay-schedules` ordena pagos y cobros programados (7.7, 7.8);
 * `pay-payments` registra deudas por contracargo; `pay-backoffice` (nombre fijado por D-31; antes provisorio `pay-console`) es la consola interna de operación (el contrato
 * dice «consola interna, fuera de este plan») y es la única que corre cortes y concilia; `pay-edge` solo lee los pagos de un comercio.
 */
export const PAYOUT_WRITERS = ['pay-schedules', 'pay-backoffice'];
export const PAYOUT_READERS = ['pay-schedules', 'pay-backoffice', 'pay-edge'];
export const OPERATIONS = ['pay-backoffice'];
export const CHARGE_WRITERS = ['pay-schedules', 'pay-payments', 'pay-backoffice'];

interface Stored {
  status: number;
  body: unknown;
  replayed: boolean;
}

/** Respuesta que pasó por la tabla de idempotencia: puede ser un error de negocio guardado (se repite tal cual). */
function send(res: Response, stored: Stored): unknown {
  res.status(stored.status);
  if (stored.status >= 400) res.type(PROBLEM_CONTENT_TYPE);
  if (stored.replayed) res.setHeader('Idempotency-Replayed', 'true');
  return stored.body;
}

const page = <T>(rows: T[], hasMore: boolean, next: string | null, map: (row: T) => unknown) => ({ object: 'list' as const, has_more: hasMore, next_cursor: next, data: rows.map(map) });

/** API interna (`contracts/openapi/internal-settlement-v1.yaml`) y la pública de pagos (`public-v1.yaml` `GET /payouts`, vía `pay-edge`). */
@Controller()
@UseGuards(ServiceIdentityGuard)
export class SettlementController {
  constructor(
    private readonly payouts: PayoutService,
    private readonly batches: BatchService,
    private readonly reconciliation: ReconciliationService,
    private readonly netting: NettingService,
    private readonly exports: AccountingExportService,
    @Inject(OPERATOR_VERIFIER) private readonly operators: OperatorVerifier,
    @Inject(SETTLEMENT_CONFIG) private readonly config: SettlementConfig,
  ) {}

  @Post('payouts')
  @AllowedServices(...PAYOUT_WRITERS)
  async createPayout(
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const mode = requirePayMode(payMode, this.config.payMode);
    return send(res, await this.payouts.create(body, caller, mode, requireIdempotencyKey(key)));
  }

  /**
   * Una sola ruta para dos públicos (los dos contratos definen `GET /payouts`): `pay-edge` recibe lo que ve el comercio, acotado al
   * comercio de `X-Merchant-Id`; los servicios internos reciben el payout completo y pueden filtrar por comercio.
   */
  @Get('payouts')
  @AllowedServices(...PAYOUT_READERS)
  async listPayouts(@Query() query: unknown, @Headers('x-service-id') caller: string, @Headers('x-pay-mode') payMode: string | undefined, @Headers('x-merchant-id') merchant: string | undefined) {
    const mode = requirePayMode(payMode, this.config.payMode);
    if (caller === 'pay-edge') {
      const parsed = merchantId.safeParse(merchant);
      if (!parsed.success) throw new ProblemError('unauthorized');
      // Un comercio no filtra por otro: `merchant_id` en la consulta pública no existe y se rechaza como cualquier campo desconocido.
      const result = await this.payouts.list(query, mode, parsed.data);
      return page(result.rows, result.has_more, result.next_cursor, publicPayoutDto);
    }
    const result = await this.payouts.list(query, mode);
    return page(result.rows, result.has_more, result.next_cursor, payoutDto);
  }

  @Get('payouts/:id')
  @AllowedServices('pay-schedules', 'pay-backoffice')
  async getPayout(@Param('id') id: string, @Headers('x-pay-mode') payMode: string | undefined) {
    return payoutDto(await this.payouts.get(id, requirePayMode(payMode, this.config.payMode)));
  }

  @Post('batches')
  @AllowedServices(...OPERATIONS)
  async runBatch(
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const mode = requirePayMode(payMode, this.config.payMode);
    return send(res, await this.batches.run(body, caller, mode, requireIdempotencyKey(key)));
  }

  @Get('batches')
  @AllowedServices(...OPERATIONS)
  async listBatches(@Query() query: unknown, @Headers('x-pay-mode') payMode: string | undefined) {
    const result = await this.batches.list(query, requirePayMode(payMode, this.config.payMode));
    return page(result.rows, result.has_more, result.next_cursor, batchDto);
  }

  @Post('reconciliation_runs')
  @AllowedServices(...OPERATIONS)
  async createRun(
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const mode = requirePayMode(payMode, this.config.payMode);
    return send(res, await this.reconciliation.createRun(body, caller, mode, requireIdempotencyKey(key)));
  }

  @Get('reconciliation_runs/:id')
  @AllowedServices(...OPERATIONS)
  async getRun(@Param('id') id: string, @Headers('x-pay-mode') payMode: string | undefined) {
    return runDto(await this.reconciliation.getRun(id, requirePayMode(payMode, this.config.payMode)));
  }

  @Get('reconciliation_exceptions')
  @AllowedServices(...OPERATIONS)
  async listExceptions(@Query() query: unknown, @Headers('x-pay-mode') payMode: string | undefined) {
    const result = await this.reconciliation.listExceptions(query, requirePayMode(payMode, this.config.payMode));
    return page(result.rows, result.has_more, result.next_cursor, exceptionDto);
  }

  /**
   * Quién decide sale de la credencial del operador, nunca del cuerpo. Una credencial ausente, vencida o que no verifica es `401` (y no dice
   * por qué); una credencial válida sin el rol que la decisión exige es `403` (CONTRATOS.md §3, fila 17). La credencial se revisa primero.
   */
  @Post('reconciliation_exceptions/:id/resolve')
  @HttpCode(200)
  @AllowedServices(...OPERATIONS)
  async resolveException(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const operator = await this.operators.verify(authorization);
    if (!operator) throw new ProblemError('unauthorized');
    const mode = requirePayMode(payMode, this.config.payMode);
    return send(res, await this.reconciliation.resolve(id, body, operator, caller, mode, requireIdempotencyKey(key)));
  }

  /** Cobro a un comercio que se netea contra su saldo (7.8, contracargos); ya declarado en el contrato (ola 2). */
  @Post('charges')
  @AllowedServices(...CHARGE_WRITERS)
  async createCharge(
    @Body() body: unknown,
    @Headers('x-service-id') caller: string,
    @Headers('x-pay-mode') payMode: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const mode = requirePayMode(payMode, this.config.payMode);
    return send(res, await this.netting.register(body, caller, mode, requireIdempotencyKey(key)));
  }

  /** Exportación de asientos de un periodo cerrado para M16; ya declarada en el contrato (ola 2). */
  @Get('exports/accounting')
  @AllowedServices(...OPERATIONS)
  async exportAccounting(@Query() query: unknown, @Headers('x-pay-mode') payMode: string | undefined, @Res({ passthrough: true }) res: Response) {
    const doc = await this.exports.build(query, requirePayMode(payMode, this.config.payMode));
    if ((query as { format?: string }).format === 'csv') {
      res.type('text/csv');
      return exportToCsv(doc);
    }
    return doc;
  }
}
