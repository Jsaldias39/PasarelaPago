import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { AllowedServices } from '@pay/service-auth';
import { OperatorGuard, RequiredRole, type OperatorRequest } from '../operators/operator-auth';
import { compile } from '../validation';
import { RuleSetsService, type RuleSetInput } from './rule-sets.service';

const MAX = 9007199254740991;
const velocity = { type: 'object', required: ['max', 'window_seconds'], additionalProperties: false, properties: { max: { type: 'integer', minimum: 1, maximum: 1000000 }, window_seconds: { type: 'integer', minimum: 1, maximum: 31536000 } } };

const parseRuleSet = compile<RuleSetInput>({
  type: 'object',
  additionalProperties: false,
  properties: {
    effective_from: { type: 'string', format: 'date-time' },
    max_amount_minor: { type: 'integer', minimum: 1, maximum: MAX },
    merchant_daily_amount_minor: { type: 'integer', minimum: 1, maximum: MAX },
    payer_daily_amount_minor: { type: 'integer', minimum: 1, maximum: MAX },
    payer_velocity: velocity,
    merchant_velocity: velocity,
    hours: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: { type: 'integer', minimum: 0, maximum: 23 }, to: { type: 'integer', minimum: 1, maximum: 24 } } },
  },
});

/** Carga de límites (D-23): los valores los pone el negocio o el banco, nunca el código. PROPUESTA de contrato, ver PROPUESTAS.md. */
@Controller('rule_sets')
@AllowedServices('pay-backoffice')
@UseGuards(OperatorGuard)
export class RuleSetsController {
  constructor(private readonly ruleSets: RuleSetsService) {}

  @Post()
  @RequiredRole('risk_admin')
  publish(@Req() req: OperatorRequest, @Body() body: unknown) {
    const input = parseRuleSet(body);
    if (input.hours && input.hours.from >= input.hours.to) {
      throw new ProblemError('validation_failed', { errors: [{ field: 'hours', code: 'from_not_before_to' }] });
    }
    return this.ruleSets.publish(input, req.operator?.sub ?? 'desconocido');
  }

  @Get('current')
  @RequiredRole('risk_admin')
  current() {
    return this.ruleSets.currentView();
  }
}
