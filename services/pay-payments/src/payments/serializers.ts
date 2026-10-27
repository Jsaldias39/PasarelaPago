import type { IntentRow } from '../persistence/intents.repo';
import type { RefundRow } from '../persistence/refunds.repo';

/** Mensajes estables por código: el error crudo de un tercero nunca llega al comercio (regla 95.2.3). */
const FAILURE_MESSAGES: Record<string, string> = {
  insufficient_funds: 'El pagador no tiene saldo suficiente.',
  risk_unavailable: 'No se pudo evaluar el riesgo del cobro; intentá de nuevo.',
  connector_unavailable: 'El proveedor de pago no respondió; intentá de nuevo.',
  ledger_unavailable: 'No se pudo registrar el cobro; el dinero no se movió.',
  merchant_suspended: 'El comercio está suspendido.',
  validation_failed: 'El cobro fue rechazado por las reglas de la pasarela.',
};
const messageFor = (code: string): string => FAILURE_MESSAGES[code] ?? 'El cobro no se pudo completar.';

export function toPublicIntent(row: IntentRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'payment_intent',
    amount_minor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    payment_method_type: row.method,
    fee_minor: row.feeMinor,
    net_minor: row.netMinor,
    ...(row.description ? { description: row.description } : {}),
    ...(row.nextAction ? { next_action: row.nextAction } : {}),
    last_error: row.failureCode ? { code: row.failureCode, message: messageFor(row.failureCode) } : null,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    succeeded_at: row.succeededAt ? row.succeededAt.toISOString() : null,
  };
}

export function toPublicRefund(row: RefundRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'refund',
    payment_intent: row.paymentIntentId,
    amount_minor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    ...(row.reason ? { reason: row.reason } : {}),
    failure_code: row.failureCode,
    created_at: row.createdAt.toISOString(),
  };
}

export function toInternalIntent(row: IntentRow): Record<string, unknown> {
  return {
    id: row.id,
    object: 'payment_intent',
    source: row.source,
    kind: row.kind,
    payer_merchant_id: row.merchantId,
    beneficiary_merchant_id: row.beneficiaryMerchantId,
    amount_minor: row.amountMinor,
    fee_minor: row.feeMinor,
    currency: row.currency,
    status: row.status,
    failure_code: row.failureCode,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
