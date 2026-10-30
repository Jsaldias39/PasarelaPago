import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import type { Response } from 'express';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { FeesService } from '../fees/fees.service';
import type { ChannelRule } from '../fees/quote';
import { KycService } from '../kyc/kyc.service';
import { LegalService } from '../legal/legal.service';
import { OperatorGuard, type OperatorRequest, RequiredRole } from '../operators/operator-auth';
import { SETTINGS, loadSettings, type Settings } from '../settings';
import { MERCHANT_ID, compile, requireIdempotencyKey } from '../validation';
import { type CreateMerchantInput, type KycKind, MerchantsService, type SuspensionReason } from './merchants.service';

const parseCreate = compile<CreateMerchantInput>({
  type: 'object',
  required: ['display_name', 'legal_name', 'legal_type', 'tax_id'],
  additionalProperties: false,
  properties: {
    display_name: { type: 'string', minLength: 1, maxLength: 200 },
    legal_name: { type: 'string', minLength: 1, maxLength: 300 },
    legal_type: { type: 'string', enum: ['unipersonal', 'srl', 'ltda', 'sa', 'sociedad_colectiva', 'sociedad_comandita_simple', 'sociedad_comandita_acciones', 'sucursal_sociedad_extranjera'] },
    tax_id: { type: 'string', minLength: 5, maxLength: 20, pattern: '^[0-9A-Za-z-]+$' },
    directory_tenant_ref: { type: 'string', maxLength: 100 },
  },
});
const parseSuspend = compile<{ reason: SuspensionReason }>({
  type: 'object', required: ['reason'], additionalProperties: false,
  properties: { reason: { type: 'string', enum: ['kyc_expired', 'risk_review', 'contract_breach', 'manual'] } },
});
const parseReview = compile<{ decision: 'in_review' | 'approved' | 'rejected'; risk_level?: string; note?: string }>({
  type: 'object', required: ['decision'], additionalProperties: false,
  properties: { decision: { type: 'string', enum: ['in_review', 'approved', 'rejected'] }, risk_level: { type: 'string', enum: ['low', 'medium', 'high'] }, note: { type: 'string', maxLength: 500 } },
});
const parseContractVersion = compile<{ version: number; text_sha256: string; effective_from?: string }>({
  type: 'object', required: ['version', 'text_sha256'], additionalProperties: false,
  properties: { version: { type: 'integer', minimum: 1 }, text_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, effective_from: { type: 'string', format: 'date-time' } },
});
const parseAcceptance = compile<{ version: number; accepted_by_ref: string }>({
  type: 'object', required: ['version', 'accepted_by_ref'], additionalProperties: false,
  properties: { version: { type: 'integer', minimum: 1 }, accepted_by_ref: { type: 'string', minLength: 1, maxLength: 100 } },
});
const parseFeeSchedule = compile<{ effective_from?: string; monthly_fee_minor?: number; channels: ChannelRule[] }>({
  type: 'object', required: ['channels'], additionalProperties: false,
  properties: {
    effective_from: { type: 'string', format: 'date-time' },
    monthly_fee_minor: { type: 'integer', minimum: 0 },
    channels: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object', required: ['channel', 'percent'], additionalProperties: false,
        properties: {
          channel: { type: 'string', enum: ['qr', 'card', 'bank_transfer', 'wallet', 'direct'] },
          percent: { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,6})?$' },
          fixed_minor: { type: 'integer', minimum: 0 }, min_minor: { type: 'integer', minimum: 0 }, cap_minor: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
});

const settings = loadSettings();

function mc(id: string): string {
  if (!MERCHANT_ID.test(id)) throw new ProblemError('resource_not_found');
  return id;
}
const sub = (req: OperatorRequest): string => req.operator!.sub;

/**
 * Rutas de back-office (propuesta `internal-merchants-v1.yaml`). Las llama el back-office de ALOVIDA (Q-23), no los
 * comercios. Quién actúa sale SIEMPRE del `sub` de la credencial del operador; el rol exigido va en cada ruta.
 */
@Controller('merchants')
@AllowedServices('pay-backoffice')
@UseGuards(OperatorGuard)
export class BackofficeController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly kyc: KycService,
    private readonly legal: LegalService,
    private readonly fees: FeesService,
    private readonly keys: ApiKeysService,
    @Inject(SETTINGS) private readonly cfg: Settings,
  ) {}

  @Post()
  @RequiredRole('merchant_operator')
  async create(@Headers('idempotency-key') idem: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const key = requireIdempotencyKey(idem);
    const input = parseCreate(body);
    const result = await this.merchants.create(key, hashRequest({ method: 'POST', path: '/merchants', body: input }), input);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Get(':id')
  @RequiredRole('merchant_operator')
  get(@Param('id') id: string) {
    return this.merchants.view(this.merchants['pool'], mc(id));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequiredRole('merchant_operator')
  activate(@Param('id') id: string) {
    return this.merchants.activate(mc(id));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequiredRole('merchant_operator')
  suspend(@Param('id') id: string, @Body() body: unknown) {
    return this.merchants.suspend(mc(id), parseSuspend(body).reason);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequiredRole('merchant_operator')
  close(@Param('id') id: string) {
    return this.merchants.close(mc(id));
  }

  @Post(':id/kyc/documents')
  @RequiredRole('kyc_reviewer')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: settings.kycMaxBytes + 1, files: 1, fields: 4 } }))
  async uploadDocument(@Req() req: OperatorRequest, @Param('id') id: string, @Body() body: { kind?: string }, @UploadedFile() file: Express.Multer.File | undefined) {
    const merchantId = mc(id);
    if (!file) throw new ProblemError('validation_failed', { errors: [{ field: 'file', code: 'required' }] });
    return this.kyc.uploadDocument(merchantId, body.kind as KycKind, file.buffer, sub(req));
  }

  @Put(':id/kyc/review')
  @RequiredRole('kyc_reviewer')
  review(@Req() req: OperatorRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parseReview(body);
    return this.kyc.review(mc(id), input.decision, input.risk_level, input.note, sub(req));
  }

  @Post(':id/contract_acceptances')
  @RequiredRole('merchant_operator')
  accept(@Req() req: OperatorRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.legal.accept(mc(id), parseAcceptance(body), sub(req));
  }

  @Post(':id/fee_schedules')
  @RequiredRole('pricing_admin')
  publishFees(@Req() req: OperatorRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.fees.publish(mc(id), parseFeeSchedule(body), sub(req));
  }

  @Get(':id/fee_schedules/current')
  @RequiredRole('merchant_operator')
  async currentFees(@Param('id') id: string) {
    const merchantId = mc(id);
    const exists = await this.merchants['pool'].query('SELECT 1 FROM merchants WHERE id = $1', [merchantId]);
    const schedule = exists.rows.length === 0 ? null : await this.fees.current(this.merchants['pool'], merchantId);
    if (!schedule) throw new ProblemError('resource_not_found');
    return schedule;
  }

  @Get(':id/fee_quote')
  @RequiredRole('merchant_operator')
  quote(@Param('id') id: string, @Query('channel') channel: string | undefined, @Query('amount_minor') amount: string | undefined) {
    if (!channel || !['qr', 'card', 'bank_transfer', 'wallet', 'direct'].includes(channel)) throw new ProblemError('validation_failed', { errors: [{ field: 'channel', code: 'enum' }] });
    if (!amount || !/^[1-9]\d{0,15}$/.test(amount) || !Number.isSafeInteger(Number(amount))) throw new ProblemError('validation_failed', { errors: [{ field: 'amount_minor', code: 'invalid' }] });
    return this.fees.quote(mc(id), channel, BigInt(amount));
  }

  @Post(':id/api_keys/:keyId/revoke')
  @HttpCode(204)
  @RequiredRole('security_operator')
  async revokeCompromised(@Param('id') id: string, @Param('keyId') keyId: string): Promise<void> {
    if (!/^key_[a-z0-9]{10,40}$/.test(keyId)) throw new ProblemError('resource_not_found');
    await this.keys.revoke(mc(id), keyId, 'compromised');
  }
}

/** Publicación de versiones del contrato legal (no cuelga de un comercio). */
@Controller('contract_versions')
@AllowedServices('pay-backoffice')
@UseGuards(OperatorGuard)
export class ContractVersionsController {
  constructor(private readonly legal: LegalService) {}

  @Post()
  @RequiredRole('legal_admin')
  publish(@Req() req: OperatorRequest, @Body() body: unknown) {
    return this.legal.publishVersion(parseContractVersion(body), sub(req));
  }
}
