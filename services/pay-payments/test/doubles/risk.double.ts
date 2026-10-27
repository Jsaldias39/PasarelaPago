import { createHash } from 'node:crypto';
import { CONTRACTS } from './contracts';
import { DoubleServer, problem, type DoubleRequest, type DoubleResponse } from './server';

export type RiskMode = 'allow' | 'deny' | 'review' | 'down' | 'hang' | { slowMs: number };

const idOf = (prefix: string, seed: string) => `${prefix}_${createHash('sha1').update(seed).digest('hex').slice(0, 14)}`;

/** [DOBLE] de pay-risk (P5): implementa `internal-risk-v1`. Modo cambiable en caliente para los escenarios. */
export class RiskDouble {
  mode: RiskMode = 'allow';
  readonly server: DoubleServer;
  private readonly seen = new Map<string, unknown>();

  constructor() {
    this.server = new DoubleServer(CONTRACTS.risk, (req) => this.handle(req));
  }

  start = () => this.server.start();
  stop = () => this.server.stop();

  private handle(req: DoubleRequest): DoubleResponse {
    if (req.method !== 'POST' || req.path !== '/assessments') return problem('resource_not_found', 404);
    if (this.mode === 'down') return problem('risk_unavailable', 503);
    if (this.mode === 'hang') return { status: 200, hang: true };
    const key = String(req.headers['idempotency-key'] ?? '');
    const body = req.body as { payment_intent_id: string };
    const delayMs = typeof this.mode === 'object' ? this.mode.slowMs : undefined;
    const decision = this.mode === 'deny' ? 'deny' : this.mode === 'review' ? 'review' : 'allow';
    const assessment = {
      id: idOf('ra', `${body.payment_intent_id}`),
      object: 'risk_assessment',
      payment_intent_id: body.payment_intent_id,
      decision,
      reason_code: decision === 'allow' ? 'no_limits_configured' : decision === 'deny' ? 'amount_over_limit' : 'sanctions_possible_match',
      rule_version: 1,
      screened: false,
      created_at: new Date().toISOString(),
    };
    const replay = this.seen.has(key);
    this.seen.set(key, assessment);
    return { status: replay ? 200 : 201, body: assessment, ...(delayMs ? { delayMs } : {}) };
  }
}
