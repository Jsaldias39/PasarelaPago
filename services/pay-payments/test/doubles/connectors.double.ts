import { createHash } from 'node:crypto';
import { CONTRACTS } from './contracts';
import { DoubleServer, problem, type DoubleRequest, type DoubleResponse } from './server';

/**
 * `down` / `refund_down` = `502 connector_unavailable` con el cuerpo exacto del contrato: DEFINITIVO, no se envió nada.
 * `charge_ambiguous` / `refund_ambiguous` = un 500 genérico: AMBIGUO, no prueba que no se ejecutó.
 */
export type ConnectorScenario = 'ok' | 'decline' | 'down' | 'charge_ambiguous' | 'refund_fails' | 'refund_pending' | 'refund_down' | 'refund_ambiguous';

interface ChargeRecord {
  id: string;
  payment_intent_id: string;
  method: 'qr' | 'card' | 'bank_transfer';
  amount_minor: number;
  status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'expired' | 'canceled';
  expires_at: string;
  card_token?: string;
}

const idOf = (prefix: string, seed: string) => `${prefix}_${createHash('sha1').update(seed).digest('hex').slice(0, 14)}`;

/**
 * [DOBLE] de pay-connectors (P4): implementa `internal-connectors-v1`. Es idempotente por `payment_intent_id` (como el real
 * debe serlo) y deja que la prueba decida cuándo el pagador «pagó» (`setChargeStatus`), que es lo que en producción llega
 * por el callback del banco.
 */
export class ConnectorsDouble {
  scenario: ConnectorScenario = 'ok';
  readonly charges = new Map<string, ChargeRecord>();
  readonly refunds = new Map<string, { id: string; charge_id: string; amount_minor: number; status: 'pending' | 'succeeded' | 'failed' }>();
  /** Cuántos cargos DISTINTOS se crearon por intento (debe ser 1 aunque la llamada se repita). */
  readonly chargeCreations = new Map<string, number>();
  readonly server: DoubleServer;

  constructor() {
    this.server = new DoubleServer(CONTRACTS.connectors, (req) => this.handle(req));
  }

  start = () => this.server.start();
  stop = () => this.server.stop();

  setChargeStatus(chargeId: string, status: ChargeRecord['status']): void {
    const charge = this.charges.get(chargeId);
    if (!charge) throw new Error(`cargo desconocido ${chargeId}`);
    charge.status = status;
  }

  chargeFor(paymentIntentId: string): ChargeRecord | undefined {
    return [...this.charges.values()].find((c) => c.payment_intent_id === paymentIntentId);
  }

  private view(charge: ChargeRecord) {
    const nextAction =
      charge.status !== 'requires_action'
        ? undefined
        : charge.method === 'qr'
          ? { type: 'display_qr', payload: `00020101021226[doble]${charge.id}6304ABCD`, expires_at: charge.expires_at }
          : charge.method === 'bank_transfer'
            ? { type: 'bank_transfer_instructions', reference: `REF${charge.id.slice(3, 13).toUpperCase()}` }
            : { type: 'redirect_to_card_form', url: `https://pagos.example.test/card/${charge.id}` };
    return {
      id: charge.id,
      object: 'charge',
      payment_intent_id: charge.payment_intent_id,
      connector: 'mock',
      mode: 'sandbox',
      method: charge.method,
      amount_minor: charge.amount_minor,
      currency: 'BOB',
      status: charge.status,
      ...(nextAction ? { next_action: nextAction } : {}),
      provider_reference: null,
      failure_code: null,
      created_at: new Date().toISOString(),
      expires_at: charge.expires_at,
    };
  }

  private handle(req: DoubleRequest): DoubleResponse {
    const { method, path } = req;
    if (method === 'POST' && path === '/charges') {
      if (this.scenario === 'down') return problem('connector_unavailable', 502);
      if (this.scenario === 'charge_ambiguous') return problem('internal_error', 500);
      if (this.scenario === 'decline') return problem('validation_failed', 422);
      const body = req.body as { payment_intent_id: string; method: ChargeRecord['method']; amount_minor: number; expires_at: string; card_token?: string };
      const existing = this.chargeFor(body.payment_intent_id);
      if (existing) return { status: 200, body: this.view(existing) };
      const charge: ChargeRecord = {
        id: idOf('ch', body.payment_intent_id),
        payment_intent_id: body.payment_intent_id,
        method: body.method,
        amount_minor: body.amount_minor,
        status: 'requires_action',
        expires_at: body.expires_at,
        ...(body.card_token ? { card_token: body.card_token } : {}),
      };
      this.charges.set(charge.id, charge);
      this.chargeCreations.set(body.payment_intent_id, (this.chargeCreations.get(body.payment_intent_id) ?? 0) + 1);
      return { status: 201, body: this.view(charge) };
    }
    const status = /^\/charges\/(ch_[a-z0-9]+)\/status$/.exec(path);
    if (method === 'GET' && status) {
      const charge = this.charges.get(status[1]);
      if (!charge) return problem('resource_not_found', 404);
      return { status: 200, body: { charge_id: charge.id, status: charge.status, connector: 'mock', mode: 'sandbox', failure_code: null, checked_at: new Date().toISOString() } };
    }
    const cancel = /^\/charges\/(ch_[a-z0-9]+)\/cancel$/.exec(path);
    if (method === 'POST' && cancel) {
      const charge = this.charges.get(cancel[1]);
      if (!charge) return problem('resource_not_found', 404);
      if (charge.status === 'succeeded') return problem('invalid_state_transition', 409);
      if (charge.status !== 'canceled') charge.status = 'canceled';
      return { status: 200, body: this.view(charge) };
    }
    const refund = /^\/charges\/(ch_[a-z0-9]+)\/refunds$/.exec(path);
    if (method === 'POST' && refund) {
      const charge = this.charges.get(refund[1]);
      if (!charge) return problem('resource_not_found', 404);
      if (charge.status !== 'succeeded') return problem('invalid_state_transition', 409);
      if (this.scenario === 'refund_down') return problem('connector_unavailable', 502);
      if (this.scenario === 'refund_ambiguous') return problem('internal_error', 500);
      if (this.scenario === 'refund_fails') return problem('validation_failed', 422);
      const key = String(req.headers['idempotency-key']);
      const id = idOf('cr', key);
      const body = req.body as { amount_minor: number };
      const status = this.scenario === 'refund_pending' ? 'pending' : 'succeeded';
      const record = this.refunds.get(id) ?? { id, charge_id: charge.id, amount_minor: body.amount_minor, status: status as 'pending' | 'succeeded' };
      this.refunds.set(id, record);
      return { status: 201, body: { id, object: 'connector_refund', charge_id: charge.id, amount_minor: record.amount_minor, currency: 'BOB', status: record.status, failure_code: null, created_at: new Date().toISOString() } };
    }
    return problem('resource_not_found', 404);
  }
}
