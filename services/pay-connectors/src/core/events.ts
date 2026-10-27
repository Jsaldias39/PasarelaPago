import { newCloudEvent, type CloudEvent } from '@pay/outbox';
import type { ConnectorCode, ProviderStatus } from '../domain/connector';
import { eventFailureCode, transferFailureCode } from '../domain/status-map';

export type ObservedVia = 'callback' | 'status_inquiry';

export interface StatusChange {
  readonly connector: ConnectorCode;
  readonly kind: 'charge' | 'refund';
  /** `ch_…` (cobro) o `cr_…` (reembolso): el id de `internal-connectors-v1`, tal cual es el `connector_transaction_id` y el `subject`. */
  readonly internalId: string;
  /** `re_…` de pay-payments, si el pedido de reembolso lo trajo. */
  readonly refundId?: string | null;
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly status: ProviderStatus;
  readonly amountMinor: bigint;
  readonly providerEventId: string;
  readonly occurredAt: Date;
  readonly observedVia: ObservedVia;
  readonly failureCode: string | null;
}

/** `connector.transaction.status_changed` (AsyncAPI `connectors.yaml`). `data` lleva solo ids, estados e importes (x-pii: none). */
export function statusChangedEvent(change: StatusChange): CloudEvent {
  const transactionId = change.internalId;
  return newCloudEvent({
    source: '/pay-connectors',
    type: 'connector.transaction.status_changed',
    subject: transactionId,
    merchantId: change.merchantId,
    data: {
      connector_transaction_id: transactionId,
      connector: change.connector,
      kind: change.kind,
      payment_intent_id: change.paymentIntentId,
      refund_id: change.kind === 'refund' ? (change.refundId ?? null) : null,
      merchant_id: change.merchantId,
      status: change.status,
      amount_minor: Number(change.amountMinor),
      currency: 'BOB',
      provider_event_id: change.providerEventId,
      provider_occurred_at: change.occurredAt.toISOString(),
      observed_via: change.observedVia,
      failure_code: eventFailureCode(change.failureCode),
    },
  });
}

export function healthDegradedEvent(connector: ConnectorCode, since: Date, reason: string, consecutiveFailures: number): CloudEvent {
  return newCloudEvent({
    source: '/pay-connectors',
    type: 'connector.health.degraded',
    subject: connector,
    data: { connector, since: since.toISOString(), reason, consecutive_failures: consecutiveFailures },
  });
}

export function healthRecoveredEvent(connector: ConnectorCode, degradedSince: Date, recoveredAt: Date): CloudEvent {
  return newCloudEvent({
    source: '/pay-connectors',
    type: 'connector.health.recovered',
    subject: connector,
    data: { connector, degraded_since: degradedSince.toISOString(), recovered_at: recoveredAt.toISOString() },
  });
}

export interface TransferChange {
  /** `tr_…` */
  readonly transferId: string;
  /** `business_ref:attempt`, la clave de `GET /transfers/{reference}`. */
  readonly reference: string;
  readonly connector: ConnectorCode;
  readonly status: 'pending' | 'in_transit' | 'paid' | 'failed';
  readonly amountMinor: bigint;
  readonly occurredAt: Date;
  readonly observedVia: ObservedVia;
  readonly failureCode: string | null;
}

/**
 * `connector.transfer.status_changed`: SEÑAL para `pay-settlement`; la fuente autoritativa sigue siendo `GET /transfers/{reference}`.
 * Sin `merchantid`. `failed` siempre trae `failure_code` (prueba de que NO se pagó).
 */
export function transferStatusChangedEvent(change: TransferChange): CloudEvent {
  return newCloudEvent({
    source: '/pay-connectors',
    type: 'connector.transfer.status_changed',
    subject: change.transferId,
    data: {
      transfer_id: change.transferId,
      reference: change.reference,
      connector: change.connector,
      status: change.status,
      amount_minor: Number(change.amountMinor),
      currency: 'BOB',
      failure_code: change.status === 'failed' ? transferFailureCode(change.failureCode) : null,
      provider_occurred_at: change.occurredAt.toISOString(),
      observed_via: change.observedVia,
    },
  });
}
