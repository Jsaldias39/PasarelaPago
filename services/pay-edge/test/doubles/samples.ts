/** Respuestas de muestra que cumplen `contracts/openapi/public-v1.yaml`, una por operación (las usa el doble de los servicios dueños). */
export const MERCHANT = 'mc_abcdefghij12';
export const intent = {
  id: 'pi_abcdefghij12',
  object: 'payment_intent',
  amount_minor: 10000,
  currency: 'BOB',
  status: 'requires_action',
  payment_method_type: 'qr',
  fee_minor: 300,
  net_minor: 9700,
  created_at: '2026-10-27T15:00:00Z',
  expires_at: '2026-10-27T16:00:00Z',
};
const list = (data: unknown[]) => ({ object: 'list', has_more: false, next_cursor: null, data });
const apiKey = { id: 'key_abcdefghij12', object: 'api_key', mode: 'test', last4: 'abcd', created_at: '2026-10-27T15:00:00Z' };
const endpoint = { id: 'we_abcdefghij12', object: 'webhook_endpoint', url: 'https://comercio.example/hooks', enabled_events: ['payment_intent.succeeded'], status: 'enabled', created_at: '2026-10-27T15:00:00Z' };
const mandate = {
  id: 'md_abcdefghij12',
  object: 'mandate',
  status: 'active',
  created_at: '2026-10-27T15:00:00Z',
  kind: 'pay_obligation',
  beneficiary_merchant_id: 'mc_beneficiario12',
  amount_minor: 50000,
  currency: 'BOB',
  schedule: { frequency: 'monthly', day_of_month: 5, start_date: '2026-11-05' },
};

export interface Sample {
  readonly status: number;
  readonly body?: unknown;
}

/** `METHOD plantilla` → respuesta de muestra. */
export const SAMPLES: Readonly<Record<string, Sample>> = {
  'POST /payment_intents': { status: 201, body: intent },
  'GET /payment_intents': { status: 200, body: list([intent]) },
  'GET /payment_intents/{id}': { status: 200, body: intent },
  'POST /payment_intents/{id}/cancel': { status: 200, body: { ...intent, status: 'canceled' } },
  'POST /payment_intents/{id}/refunds': { status: 201, body: { id: 're_abcdefghij12', object: 'refund', payment_intent: 'pi_abcdefghij12', amount_minor: 1000, currency: 'BOB', status: 'pending', created_at: '2026-10-27T15:00:00Z' } },
  'GET /merchants/me': { status: 200, body: { id: MERCHANT, object: 'merchant', status: 'active', display_name: 'Comercio de prueba (sintético)', fee_schedule: { version: 1, channels: [{ channel: 'qr', percent: '2.5' }] } } },
  'POST /api_keys': { status: 201, body: { ...apiKey, secret: 'sk_test_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz234567' } },
  'GET /api_keys': { status: 200, body: list([apiKey]) },
  'POST /api_keys/{id}/rotate': { status: 201, body: { ...apiKey, secret: 'sk_test_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz234567' } },
  'DELETE /api_keys/{id}': { status: 204 },
  'POST /webhook_endpoints': { status: 201, body: { ...endpoint, secret: 'whsec_dGVzdC1zZWNyZXQtZGUtMzItYnl0ZXMtLS0tLS0tLS0=' } },
  'GET /webhook_endpoints': { status: 200, body: list([endpoint]) },
  'POST /webhook_endpoints/{id}/rotate_secret': { status: 200, body: { ...endpoint, secret: 'whsec_dGVzdC1zZWNyZXQtZGUtMzItYnl0ZXMtLS0tLS0tLS0=' } },
  'DELETE /webhook_endpoints/{id}': { status: 204 },
  'GET /balance': { status: 200, body: { object: 'balance', currency: 'BOB', pending_minor: 9700, available_minor: 0 } },
  'GET /payouts': { status: 200, body: list([{ id: 'po_abcdefghij12', object: 'payout', amount_minor: 9700, currency: 'BOB', status: 'pending', period_from: '2026-10-19T00:00:00Z', period_to: '2026-10-26T00:00:00Z', created_at: '2026-10-27T15:00:00Z' }]) },
  'POST /mandates': { status: 201, body: mandate },
  'GET /mandates': { status: 200, body: list([mandate]) },
  'DELETE /mandates/{id}': { status: 204 },
};
