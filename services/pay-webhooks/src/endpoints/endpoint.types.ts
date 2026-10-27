export type SignatureScheme = 'v1' | 'v1a';
export type DisabledReason = 'gone_410' | 'too_many_failures' | 'manual';

/** Un endpoint tal como lo guarda pay-webhooks (sin secretos). */
export interface EndpointRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly description: string | null;
  readonly enabledEvents: readonly string[];
  readonly signatureScheme: SignatureScheme;
  readonly status: 'enabled' | 'disabled';
  readonly disabledReason: DisabledReason | null;
  readonly createdAt: Date;
}

/** Cuerpo de `WebhookEndpoint` de public-v1.yaml. */
export interface EndpointView {
  readonly id: string;
  readonly object: 'webhook_endpoint';
  readonly url: string;
  readonly enabled_events: readonly string[];
  readonly status: 'enabled' | 'disabled';
  readonly disabled_reason: DisabledReason | null;
  readonly created_at: string;
}

export function toView(record: EndpointRecord): EndpointView {
  return {
    id: record.id,
    object: 'webhook_endpoint',
    url: record.url,
    enabled_events: record.enabledEvents,
    status: record.status,
    disabled_reason: record.disabledReason,
    created_at: record.createdAt.toISOString(),
  };
}
