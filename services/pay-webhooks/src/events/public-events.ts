/**
 * Eventos que pay-webhooks entrega a los comercios. Todo lo demás (ledger.*, api_key.*, merchant.*, fee_schedule.*,
 * settlement.batch.closed, reconciliation.*, connector.*) es interno y NUNCA sale de la pasarela.
 */
export const PUBLIC_EVENT_TYPES: readonly string[] = [
  'payment_intent.created',
  'payment_intent.requires_action',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.failed',
  'payment_intent.canceled',
  'payment_intent.expired',
  'refund.created',
  'refund.succeeded',
  'refund.failed',
  'dispute.opened',
  'dispute.won',
  'dispute.lost',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'mandate.created',
  'mandate.canceled',
  'scheduled_payment.executed',
  'scheduled_payment.failed',
  'scheduled_payment.insufficient_funds',
];

export const isPublicEventType = (type: string): boolean => PUBLIC_EVENT_TYPES.includes(type);
