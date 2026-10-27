import { randomBytes, randomUUID } from 'node:crypto';

/** CloudEvent con la forma de contracts/asyncapi/payments.yaml (datos SINTÉTICOS). */
export function cloudEvent(type: string, merchantId: string, data: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const base = type.startsWith('payment_intent.')
    ? { payment_intent_id: `pi_${randomBytes(6).toString('hex')}`, merchant_id: merchantId, amount_minor: 10000, currency: 'BOB', status: 'succeeded', fee_minor: 300, net_minor: 9700 }
    : { merchant_id: merchantId, amount_minor: 10000, currency: 'BOB', status: 'paid' };
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: type.startsWith('payout.') ? '/pay-settlement' : '/pay-payments',
    type,
    time: '2026-10-27T11:59:00.000Z',
    datacontenttype: 'application/json',
    merchantid: merchantId,
    data: { ...base, ...data },
    ...overrides,
  };
}
