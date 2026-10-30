import { intentsRepo } from '../src/persistence/intents.repo';
import { key, MC, seedMerchant, startStack, waitFor, type Stack } from './helpers/stack';

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
  await seedMerchant(stack, MC);
});
afterAll(async () => stack.stop());

it('humo: un cobro QR de Bs 100,00 llega a requires_action con QR, y al confirmarse deja 97,00 / 3,00 en el ledger', async () => {
  const created = await stack.service.createIntent(MC, 'test', key(), { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({ status: 'requires_action', fee_minor: 300, net_minor: 9700, next_action: { type: 'display_qr' } });
  const id = created.body.id as string;

  const charge = stack.connectors.chargeFor(id);
  expect(charge).toBeDefined();
  await stack.orchestrator.signalCharge(id, { status: 'captured' });

  const done = await waitFor(async () => {
    const row = await intentsRepo.byId(stack.deps.pool, id);
    return row?.status === 'succeeded' ? row : undefined;
  });
  expect(done.ledgerTransferId).toBeTruthy();
  expect(stack.ledger.balance('merchant:' + MC + ':pending')).toBe(9700);
  expect(stack.ledger.balance('platform:fees')).toBe(300);
  expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});
