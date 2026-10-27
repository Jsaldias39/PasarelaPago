import { loadContract, type ContractValidator } from '@pay/testing';
import { DisabledWalletAuthorizer } from '../src/clients/wallet-authorizer';
import { PaymentsService } from '../src/payments/payments.service';
import { CONTRACTS } from './doubles/contracts';
import { eventsOf, key, MC, MC2, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';

let stack: Stack;
let publicContract: ContractValidator;
const BANK = { bankName: 'Banco de Prueba (dato sintético)', accountHolder: 'ALOVIDA PRUEBA SRL', accountNumber: '000-0000000-0' };

beforeAll(async () => {
  stack = await startStack({ env: { BANK_TRANSFER_BANK_NAME: BANK.bankName, BANK_TRANSFER_ACCOUNT_HOLDER: BANK.accountHolder, BANK_TRANSFER_ACCOUNT_NUMBER: BANK.accountNumber } });
  publicContract = await loadContract(CONTRACTS.publicV1);
  await seedMerchant(stack, MC);
  await seedMerchant(stack, MC2);
});
afterAll(async () => stack.stop());
afterEach(() => {
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

const finish = async (id: string) => {
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
  await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, `${id} succeeded`);
};

describe('P3.H3.M4 · transferencia bancaria: requires_action con instrucciones, confirmada por el conector', () => {
  it('devuelve las instrucciones con la referencia del conector y la cuenta recaudadora configurada, y termina succeeded', async () => {
    const result = await stack.service.createIntent(MC, key(), { amount_minor: 20000, currency: 'BOB', payment_method: { type: 'bank_transfer' } });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'requires_action', payment_method_type: 'bank_transfer', fee_minor: 200, net_minor: 19800 });
    const action = result.body.next_action as { type: string; bank_transfer: Record<string, string> };
    expect(action.type).toBe('bank_transfer_instructions');
    expect(action.bank_transfer).toMatchObject({ bank_name: BANK.bankName, account_holder: BANK.accountHolder, account_number: BANK.accountNumber });
    expect(action.bank_transfer.reference).toMatch(/^REF[A-Z0-9]+$/);
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: result.body })).toEqual([]);

    const id = result.body.id as string;
    await finish(id);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    const legs = stack.ledger.postedLegs(`${id}:capture`);
    expect(legs.reduce((sum, leg) => sum + leg.amount_minor, 0)).toBe(20000);
    expect((await eventsOf(stack, id)).map((e) => e.type)).toContain('payment_intent.succeeded');
  });
});

describe('P3.H3.M3 · tarjeta: el cobro lleva solo el token y el pagador completa en la página del banco', () => {
  it('devuelve redirect_to_card_form, el conector recibe el token (nunca un número) y termina succeeded', async () => {
    const result = await stack.service.createIntent(MC, key(), { amount_minor: 5000, currency: 'BOB', payment_method: { type: 'card', card_token: 'tok_abcdefghij12' } });
    expect(result.body).toMatchObject({ status: 'requires_action', next_action: { type: 'redirect_to_card_form' } });
    expect(publicContract.validateResponse({ method: 'POST', path: '/payment_intents', status: 201, body: result.body })).toEqual([]);
    const id = result.body.id as string;
    const request = stack.connectors.server.callsTo('POST', /^\/charges$/).find((c) => (c.body as { payment_intent_id: string }).payment_intent_id === id);
    expect((request?.body as { card_token?: string }).card_token).toBe('tok_abcdefghij12');
    await finish(id);
  });
});

describe('P3.H3.M4 · saldo AloVida: solo con `wallet_authorization` válida (un uso, atada a comercio, importe y moneda)', () => {
  const wallet = (token: string, amount = 4000) => ({ amount_minor: amount, currency: 'BOB', payment_method: { type: 'wallet', wallet_authorization: token } });
  const balance = () => stack.ledger.balance('user:usr_dora:wallet');

  it('sin token, con token inventado, reutilizado, de otro comercio, de otro importe o vencido: nada se debita', async () => {
    stack.ledger.setBalance('user:usr_dora:wallet', 50000);
    const valid = stack.wallet.issue({ userId: 'usr_dora', merchantId: MC, amountMinor: 4000 });
    const otherMerchant = stack.wallet.issue({ userId: 'usr_dora', merchantId: MC2, amountMinor: 4000 });
    const otherAmount = stack.wallet.issue({ userId: 'usr_dora', merchantId: MC, amountMinor: 4001 });
    const expired = stack.wallet.issue({ userId: 'usr_dora', merchantId: MC, amountMinor: 4000, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 20));

    // Sin token: el servidor exige el campo (el comercio no puede indicar de qué usuario cobrar).
    const missing = await stack.service.createIntent(MC, key(), { amount_minor: 4000, currency: 'BOB', payment_method: { type: 'wallet' } }).catch((e: { status: number }) => ({ status: e.status }));
    expect(missing.status).toBe(422);
    for (const token of ['inventado', otherMerchant, otherAmount, expired]) {
      const result = await stack.service.createIntent(MC, key(), wallet(token));
      expect({ token: token.slice(0, 6), status: result.status, code: (result.body as { code?: string }).code }).toMatchObject({ status: 403, code: 'forbidden' });
    }
    expect(balance()).toBe(50000);

    // El válido funciona una vez…
    const ok = await stack.service.createIntent(MC, key(), wallet(valid));
    expect(ok.status).toBe(201);
    await waitFor(async () => ((await statusOf(stack, ok.body.id as string)) === 'succeeded' ? true : undefined), 20_000, 'saldo AloVida succeeded');
    expect(balance()).toBe(46000);
    // …y reutilizarlo es 403 y no debita otra vez.
    const reuse = await stack.service.createIntent(MC, key(), wallet(valid));
    expect(reuse.status).toBe(403);
    expect(balance()).toBe(46000);
    // Ni siquiera el reintento con la MISMA Idempotency-Key lo repite (la respuesta guardada no vuelve a debitar).
    const k = key();
    const token2 = stack.wallet.issue({ userId: 'usr_dora', merchantId: MC, amountMinor: 1000 });
    const a = await stack.service.createIntent(MC, k, wallet(token2, 1000));
    const b = await stack.service.createIntent(MC, k, wallet(token2, 1000));
    expect(b.body).toEqual(a.body);
    await waitFor(async () => (balance() === 45000 ? true : undefined), 20_000, 'un solo débito');
  });

  it('el usuario sale del TOKEN, no de la petición: otro usuario con el mismo comercio y monto no se toca', async () => {
    stack.ledger.setBalance('user:usr_eva:wallet', 9000);
    stack.ledger.setBalance('user:usr_fer:wallet', 9000);
    const token = stack.wallet.issue({ userId: 'usr_eva', merchantId: MC, amountMinor: 2000 });
    const result = await stack.service.createIntent(MC, key(), { ...wallet(token, 2000), payment_method: { type: 'wallet', wallet_authorization: token, user_id: 'usr_fer' } }).catch((e: { status: number }) => ({ status: e.status }));
    expect(result.status).toBe(422); // user_id no es un campo del contrato (mass assignment)
    expect(stack.ledger.balance('user:usr_fer:wallet')).toBe(9000);
    expect(stack.ledger.balance('user:usr_eva:wallet')).toBe(9000);
  });

  it('en producción mientras Q-20 siga abierta el saldo AloVida está DESHABILITADO: todo token es 403', async () => {
    const disabled = new PaymentsService({ ...stack.deps, wallet: new DisabledWalletAuthorizer() }, stack.orchestrator);
    const token = stack.wallet.issue({ userId: 'usr_gina', merchantId: MC, amountMinor: 1500 });
    const result = await disabled.createIntent(MC, key(), wallet(token, 1500));
    expect(result.status).toBe(403);
    expect(stack.ledger.balance('user:usr_gina:wallet')).toBe(0);
  });
});
