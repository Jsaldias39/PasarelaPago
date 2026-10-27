import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { hashRequest } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import type { Response } from 'express';
import { compile, requireIdempotencyKey } from '../validation';
import { AssessmentsService, type AssessmentInput } from './assessments.service';

const parseAssessment = compile<AssessmentInput>({
  type: 'object',
  required: ['merchant_id', 'payment_intent_id', 'amount_minor', 'currency', 'method'],
  additionalProperties: false,
  properties: {
    merchant_id: { type: 'string', pattern: '^mc_[a-z0-9]{10,40}$' },
    payment_intent_id: { type: 'string', pattern: '^pi_[a-z0-9]{10,40}$' },
    amount_minor: { type: 'integer', minimum: 1, maximum: 9007199254740991 },
    currency: { type: 'string', enum: ['BOB'] },
    method: { type: 'string', enum: ['qr', 'card', 'bank_transfer', 'wallet'] },
    payer_fingerprint: { type: 'string', minLength: 1, maxLength: 128 },
    screening: {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } },
    },
  },
});

const ASSESSMENT_ID = /^ra_[a-z0-9]{10,40}$/;

/** `POST /assessments` y `GET /assessments/{id}` de `internal-risk-v1.yaml`. Solo las llama `pay-payments`. */
@Controller('assessments')
@AllowedServices('pay-payments')
export class AssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Post()
  async create(
    @Headers('x-service-id') service: string,
    @Headers('idempotency-key') idem: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = requireIdempotencyKey(idem);
    const input = parseAssessment(body);
    // El nombre no entra en el hash de la petición: se sustituye por su huella para que el almacén de idempotencia no lo conserve.
    const hashable = { ...input, ...(input.screening && { screening: { name_digest: this.assessments.digest('screening', input.screening.name.trim()) } }) };
    const result = await this.assessments.create(service, key, hashRequest({ method: 'POST', path: '/assessments', body: hashable }), input);
    res.status(result.status);
    if (result.status === 200) res.setHeader('Idempotency-Replayed', 'true');
    return result.body;
  }

  @Get(':id')
  get(@Headers('x-service-id') service: string, @Param('id') id: string) {
    // Un id mal formado se trata como uno inexistente.
    if (!ASSESSMENT_ID.test(id)) throw new ProblemError('resource_not_found');
    return this.assessments.get(service, id);
  }
}
