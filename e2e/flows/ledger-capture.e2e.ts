import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E1, tramo del ledger, contra pay-ledger REAL y un TigerBeetle REAL (privado). El llamador es un [DOBLE] de pay-payments: manda
 * el MISMO asiento que `recordLedger` de pay-payments (src/temporal/activities.ts): una pata `charge` por el neto y una `fee` por la
 * comisión, ambas desde `connector:mock:clearing`. La versión completa (alta → cobro QR → callback → captured → ledger) es
 * `e2e/pending/e1.e2e.ts`, que espera a P3/P5.
 *
 * Bs 100,00 por QR con la tarifa de la siembra (2,5 % + Bs 0,50): comisión 250 + 50 = 300; neto 9700.
 */
const GROSS = 10_000;
const FEE = 300;
const NET = GROSS - FEE;

describe('E1 (tramo del ledger real) — captured ⇒ 97,00 en pending y 3,00 en platform:fees, débitos = créditos', () => {
  let stack: Stack;
  let n = 0;

  const merchant = () => `mc_e2eledger${String(++n).padStart(3, '0')}`;
  const post = (service: string, merchantId: string, body: unknown, key: string, payMode: 'test' | 'live' | null = 'test') =>
    stack.callAs(service, 'pay-ledger', 'POST', '/transactions', { merchantId, payMode, headers: { 'idempotency-key': key }, json: body });
  /** Una cuenta que nadie nombró todavía no existe (las crea el ledger al primer asiento): su saldo es 0. */
  const balance = async (account: string) => {
    const res = await stack.callAs('pay-payments', 'pay-ledger', 'GET', `/balances?account=${encodeURIComponent(account)}`, { payMode: 'test' });
    if (res.status === 404) return { balance_minor: 0, pending_debits_minor: 0 };
    expect({ account, status: res.status }).toEqual({ account, status: 200 });
    return res.json as { balance_minor: number; nature?: string; pending_debits_minor: number };
  };
  const statement = async (account: string) => {
    const res = await stack.callAs('pay-payments', 'pay-ledger', 'GET', `/statements?account=${encodeURIComponent(account)}&limit=100`, { payMode: 'test' });
    expect({ account, status: res.status }).toEqual({ account, status: 200 });
    return (res.json as { data: { direction: 'debit' | 'credit'; amount_minor: number; business_ref: string }[] }).data;
  };
  const capture = (merchantId: string, intentId: string, amount = { net: NET, fee: FEE }) => ({
    business_ref: `${intentId}:capture`,
    attempt: 1,
    currency: 'BOB',
    legs: [
      { debit_account: 'connector:mock:clearing', credit_account: `merchant:${merchantId}:pending`, amount_minor: amount.net, code: 'charge' },
      { debit_account: 'connector:mock:clearing', credit_account: 'platform:fees', amount_minor: amount.fee, code: 'fee' },
    ],
  });
  const intent = () => `pi_e2eled${Math.random().toString(36).slice(2, 12)}`;

  beforeAll(async () => {
    stack = await startStack({ only: ['pay-ledger'] });
    expect(stack.services['pay-ledger'].healthy).toBe(true);
  });
  afterAll(async () => {
    const report = await stopStack(stack);
    expect(report.leftoverPids).toEqual([]);
  });

  it('CORRECTO: el asiento de la captura deja 97,00 en merchant:X:pending y 3,00 en platform:fees, y los débitos igualan a los créditos', async () => {
    const merchantId = merchant();
    const feesBefore = (await balance('platform:fees')).balance_minor;
    const piId = intent();
    const res = await post('pay-payments', merchantId, capture(merchantId, piId), `${piId}:capture:1`);
    expect({ status: res.status, body: res.json }).toMatchObject({ status: 201, body: { status: 'posted', business_ref: `${piId}:capture` } });

    expect((await balance(`merchant:${merchantId}:pending`)).balance_minor).toBe(NET);
    expect((await balance('platform:fees')).balance_minor - feesBefore).toBe(FEE);

    // Partida doble sobre el extracto de las tres cuentas de ESTE asiento.
    const lines = (await Promise.all([`merchant:${merchantId}:pending`, 'platform:fees', 'connector:mock:clearing'].map(statement))).flat().filter((l) => l.business_ref === `${piId}:capture`);
    const sum = (direction: 'debit' | 'credit') => lines.filter((l) => l.direction === direction).reduce((total, l) => total + l.amount_minor, 0);
    expect({ debits: sum('debit'), credits: sum('credit') }).toEqual({ debits: GROSS, credits: GROSS });
  });

  it('IDEMPOTENTE: repetir el mismo asiento devuelve el mismo resultado (200, exists) y no mueve dinero otra vez', async () => {
    const merchantId = merchant();
    const piId = intent();
    const first = await post('pay-payments', merchantId, capture(merchantId, piId), `${piId}:capture:1`);
    const again = await post('pay-payments', merchantId, capture(merchantId, piId), `${piId}:capture:1`);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((again.json as { result: string; id: string }).result).toBe('exists');
    expect((again.json as { id: string }).id).toBe((first.json as { id: string }).id);
    expect((await balance(`merchant:${merchantId}:pending`)).balance_minor).toBe(NET);
  });

  it('LÍMITE: comisión mínima (1) y el cobro más chico posible se asientan; el pending de otro comercio no se mueve', async () => {
    const merchantId = merchant();
    const other = merchant();
    const piId = intent();
    const res = await post('pay-payments', merchantId, capture(merchantId, piId, { net: 1, fee: 1 }), `${piId}:capture:1`);
    expect(res.status).toBe(201);
    expect((await balance(`merchant:${merchantId}:pending`)).balance_minor).toBe(1);
    await post('pay-payments', other, capture(other, intent()), `${intent()}:capture:1`);
    expect((await balance(`merchant:${merchantId}:pending`)).balance_minor).toBe(1);
  });

  it('LÍMITE: el comercio no puede quedar en negativo (insufficient_funds, definitivo) y el rechazo no mueve nada', async () => {
    const merchantId = merchant();
    const piId = intent();
    expect((await post('pay-payments', merchantId, capture(merchantId, piId), `${piId}:capture:1`)).status).toBe(201);
    const refund = {
      business_ref: `${piId}:refund`,
      attempt: 1,
      currency: 'BOB',
      legs: [{ debit_account: `merchant:${merchantId}:pending`, credit_account: 'connector:mock:clearing', amount_minor: NET + 1, code: 'refund' }],
    };
    const rejected = await post('pay-payments', merchantId, refund, `${piId}:refund:1`);
    expect(rejected.status).toBe(422);
    expect(rejected.json).toMatchObject({ code: 'insufficient_funds' });
    expect((await balance(`merchant:${merchantId}:pending`)).balance_minor).toBe(NET);
  });

  it('INVÁLIDO: sin X-Pay-Mode ⇒ 403 sin efecto; un servicio ajeno ⇒ 403; una cuenta fuera de su matriz ⇒ 403; importe 0 y referencia mal formada no se asientan', async () => {
    const merchantId = merchant();
    const piId = intent();
    expect((await post('pay-payments', merchantId, capture(merchantId, piId), `${piId}:capture:1`, null)).status).toBe(403);
    expect((await post('pay-edge', merchantId, capture(merchantId, piId), `${piId}:capture:2`)).status).toBe(403);
    const payout = { business_ref: `${piId}:payout`, attempt: 1, currency: 'BOB', legs: [{ debit_account: 'connector:mock:clearing', credit_account: 'payout:clearing', amount_minor: 100, code: 'payout' }] };
    expect((await post('pay-payments', merchantId, payout, `${piId}:payout:1`)).status).toBe(403);
    expect([400, 422]).toContain((await post('pay-payments', merchantId, capture(merchantId, piId, { net: 0, fee: FEE }), `${piId}:capture:3`)).status);
    expect([400, 422]).toContain((await post('pay-payments', merchantId, { ...capture(merchantId, piId), business_ref: 'no es una referencia' }, `${piId}:capture:4`)).status);
    expect((await stack.callAs('pay-payments', 'pay-ledger', 'GET', `/transactions/${piId}:capture`, { payMode: 'test' })).status).toBe(404);
  });
});
