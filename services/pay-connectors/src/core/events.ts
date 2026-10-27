import { newCloudEvent, type CloudEvent } from '@pay/outbox';
import type { ConnectorCode, ProviderStatus } from '../domain/connector';
import { connectorTransactionId } from '../ids';
import { eventConnectorCode, eventFailureCode } from '../domain/status-map';

export type ObservedVia = 'callback' | 'status_inquiry';

export interface StatusChange {
  readonly connector: ConnectorCode;
  readonly kind: 'charge' | 'refund';
  /** `ch_…` o `cr_…`: de él sale el `connector_transaction_id` (`ct_…`). */
  readonly internalId: string;
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
  const transactionId = connectorTransactionId(change.internalId);
  return newCloudEvent({
    source: '/pay-connectors',
    type: 'connector.transaction.status_changed',
    subject: transactionId,
    merchantId: change.merchantId,
    data: {
      connector_transaction_id: transactionId,
      connector: eventConnectorCode(change.connector),
      kind: change.kind,
      payment_intent_id: change.paymentIntentId,
      // El pedido de reembolso todavía no trae el `re_…` de pay-payments (ver PROPUESTAS.md): hasta entonces va nulo.
      refund_id: null,
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
    subject: eventConnectorCode(connector),
    data: { connector: eventConnectorCode(connector), since: since.toISOString(), reason, consecutive_failures: consecutiveFailures },
  });
}

export function healthRecoveredEvent(connector: ConnectorCode, degradedSince: Date, recoveredAt: Date): CloudEvent {
  return newCloudEvent({
    source: '/pay-connectors',
    type: 'connector.health.recovered',
    subject: eventConnectorCode(connector),
    data: { connector: eventConnectorCode(connector), degraded_since: degradedSince.toISOString(), recovered_at: recoveredAt.toISOString() },
  });
}
