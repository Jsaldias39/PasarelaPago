import { enqueue, newCloudEvent } from '@pay/outbox';
import type { Db } from '../persistence/db';
import type { IntentRow } from '../persistence/intents.repo';
import { transferIdForEvent } from '../domain/ids';

/** Forma de cada evento: `contracts/asyncapi/payments.yaml`. `data` lleva SOLO ids, estados e importes (x-pii: none). */

const INTENT_FAILURE_CODES = new Set(['insufficient_funds', 'connector_unavailable', 'risk_unavailable', 'ledger_unavailable', 'merchant_suspended', 'validation_failed', 'internal_error']);
const REFUND_FAILURE_CODES = new Set(['insufficient_funds', 'connector_unavailable', 'ledger_unavailable', 'invalid_state_transition', 'internal_error']);
const iso = (d: Date | null | undefined) => (d ?? new Date()).toISOString();

/** El enum del contrato es cerrado: cualquier otro motivo se publica como `internal_error` (y queda en el log con su causa). */
export const intentFailureCode = (code: string | null | undefined): string => (code && INTENT_FAILURE_CODES.has(code) ? code : 'internal_error');
export const refundFailureCode = (code: string | null | undefined): string => (code && REFUND_FAILURE_CODES.has(code) ? code : 'internal_error');

const CONNECTOR_CODE: Record<string, string> = { mock: 'simulator', mercantil_qr: 'mercantil_qr', mercantil_card: 'mercantil_card', bank_transfer: 'bank_transfer' }; // PROP-3

async function publish(db: Db, type: string, subject: string, aggregateType: string, merchantId: string, data: Record<string, unknown>): Promise<void> {
  const event = newCloudEvent({ source: '/pay-payments', type, subject, merchantId, data });
  await enqueue(db, event, { aggregateType, aggregateId: subject });
}

export type IntentEventType =
  | 'payment_intent.created'
  | 'payment_intent.requires_action'
  | 'payment_intent.processing'
  | 'payment_intent.succeeded'
  | 'payment_intent.failed'
  | 'payment_intent.canceled'
  | 'payment_intent.expired';

/** Publica el evento del intento EN LA MISMA TRANSACCIÓN del cambio de estado (outbox): sin commit no hay evento. */
export async function emitIntentEvent(db: Db, type: IntentEventType, intent: IntentRow): Promise<void> {
  const base = { payment_intent_id: intent.id, merchant_id: intent.merchantId };
  const data: Record<string, unknown> = (() => {
    switch (type) {
      case 'payment_intent.created':
        return { ...base, amount_minor: intent.amountMinor, currency: intent.currency, payment_method_type: intent.method, status: intent.status, fee_minor: intent.feeMinor, net_minor: intent.netMinor, expires_at: iso(intent.expiresAt) };
      case 'payment_intent.requires_action':
        return { ...base, status: 'requires_action', next_action_type: String((intent.nextAction as { type?: string } | null)?.type ?? 'display_qr'), expires_at: iso(intent.expiresAt) };
      case 'payment_intent.processing':
        return { ...base, status: 'processing', ...(intent.connector ? { connector: CONNECTOR_CODE[intent.connector] ?? intent.connector } : {}) };
      case 'payment_intent.succeeded':
        return { ...base, amount_minor: intent.amountMinor, currency: intent.currency, status: 'succeeded', payment_method_type: intent.method, fee_minor: intent.feeMinor, net_minor: intent.netMinor, ledger_transfer_id: transferIdForEvent(intent.ledgerTransferId ?? 'tx_unknown00000'), succeeded_at: iso(intent.succeededAt) };
      case 'payment_intent.failed':
        return { ...base, status: 'failed', failure_code: intentFailureCode(intent.failureCode), failed_at: iso(intent.completedAt) };
      case 'payment_intent.canceled':
        return { ...base, status: 'canceled', canceled_at: iso(intent.completedAt) };
      case 'payment_intent.expired':
        return { ...base, status: 'expired', expired_at: iso(intent.completedAt) };
    }
  })();
  await publish(db, type, intent.id, 'payment_intent', intent.merchantId, data);
}

export interface RefundEventInput {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason?: string | null;
  readonly failureCode?: string | null;
  readonly ledgerTransferId?: string | null;
}

export async function emitRefundEvent(db: Db, type: 'refund.created' | 'refund.succeeded' | 'refund.failed', refund: RefundEventInput): Promise<void> {
  const base = { refund_id: refund.id, payment_intent_id: refund.paymentIntentId, merchant_id: refund.merchantId, amount_minor: refund.amountMinor, currency: refund.currency };
  const data =
    type === 'refund.created'
      ? { ...base, status: 'pending', ...(refund.reason ? { reason: refund.reason } : {}) }
      : type === 'refund.succeeded'
        ? { ...base, status: 'succeeded', ledger_transfer_id: transferIdForEvent(refund.ledgerTransferId ?? 'tx_unknown00000') }
        : { ...base, status: 'failed', failure_code: refundFailureCode(refund.failureCode) };
  await publish(db, type, refund.id, 'refund', refund.merchantId, data);
}

export interface DisputeEventInput {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly openedAt?: Date;
  readonly resolvedAt?: Date;
  readonly ledgerTransferId?: string | null;
}

export async function emitDisputeEvent(db: Db, type: 'dispute.opened' | 'dispute.won' | 'dispute.lost', dispute: DisputeEventInput): Promise<void> {
  const base = { dispute_id: dispute.id, payment_intent_id: dispute.paymentIntentId, merchant_id: dispute.merchantId, amount_minor: dispute.amountMinor, currency: dispute.currency };
  const data =
    type === 'dispute.opened'
      ? { ...base, status: 'open', opened_at: iso(dispute.openedAt) }
      : type === 'dispute.won'
        ? { ...base, status: 'won', resolved_at: iso(dispute.resolvedAt) }
        : { ...base, status: 'lost', resolved_at: iso(dispute.resolvedAt), ledger_transfer_id: transferIdForEvent(dispute.ledgerTransferId ?? 'tx_unknown00000') };
  await publish(db, type, dispute.id, 'dispute', dispute.merchantId, data);
}
