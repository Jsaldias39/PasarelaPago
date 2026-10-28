import { seedMerchant, waitForEdgeToKnow } from './lib/seed.ts';
import { startStack, stopStack } from './stack.ts';

const stack = await startStack({ mockbank: true, tolerateFailures: false });
try {
  const merchant = await seedMerchant(stack, { label: 'SCRATCH CARD' });
  await waitForEdgeToKnow(stack, merchant);
  const res = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { authorization: `Bearer ${merchant.token}`, 'idempotency-key': 'scratch-card-0001' }, json: { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'card', card_token: 'tok_0123456789abcdef0123' } } });
  console.log('CARD', res.status, res.text);
  const open = await stack.callAs('pay-payments', 'pay-vault', 'POST', '/capture_sessions', { headers: { 'idempotency-key': 'scratch-cap-0001' }, json: { merchant_id: merchant.merchantId, payment_intent_id: JSON.parse(res.text).id, save_card: false } });
  console.log('CAPTURE', open.status, open.text);
} finally {
  console.log(JSON.stringify(await stopStack(stack, { keepLogs: true })));
}
