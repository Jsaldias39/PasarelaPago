import { startStack, stopStack } from './stack.ts';
import { seedMerchant, waitForEdgeToKnow } from './lib/seed.ts';
const stack = await startStack();
try {
  const m = await seedMerchant(stack);
  console.log('known', await waitForEdgeToKnow(stack, m));
  const auth = { authorization: `Bearer ${m.token}` };
  const created = await stack.call('pay-edge', 'POST', '/v1/payment_intents', { headers: { ...auth, 'idempotency-key': 'scratch-key-000001' }, json: { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } } });
  console.log('create', created.status, created.text.slice(0, 700), created.headers.get('x-pay-mode'));
  const id = (created.json as { id?: string })?.id;
  if (id) {
    await new Promise((r) => setTimeout(r, 1500));
    const got = await stack.call('pay-edge', 'GET', `/v1/payment_intents/${id}`, { headers: auth });
    console.log('get', got.status, got.text.slice(0, 500));
  }
  const bal = await stack.call('pay-edge', 'GET', '/v1/balance', { headers: auth });
  console.log('balance', bal.status, bal.text.slice(0, 300));
} finally {
  console.log(JSON.stringify(await stopStack(stack)));
}
