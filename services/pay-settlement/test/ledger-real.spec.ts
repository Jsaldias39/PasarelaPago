import { HttpLedgerClient } from '../src/settlement/http-clients';
import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { type RealLedger, startRealLedger } from './helpers/real-ledger';
import { unique } from './helpers/app';

/**
 * pay-settlement contra el pay-ledger REAL (proceso aparte, TigerBeetle real). Cierra el hueco de los dobles: acá el ledger no es
 * una simulación. Lo que sigue verificado SOLO contra el doble está en el REPORTE (el corte con ventana de tiempo, porque el ledger real
 * pone `posted_at` con su propio reloj y no se puede retroceder).
 */
let ledger: RealLedger;
let ctx: SettlementTestContext;
beforeAll(async () => {
  ledger = await startRealLedger();
}, 60_000);
afterAll(async () => ledger.stop());
beforeEach(async () => {
  ctx = await createSettlementContext({ ledgerPort: new HttpLedgerClient(ledger.url, 5000) });
});
afterEach(async () => ctx.close());

const businessRef = () => `pi_${unique()}x7q2:capture`;
/** Acredita `amount` en `merchant:{m}:available` por el camino real (pay-payments → pay-ledger). */
async function fund(m: string, amount: number): Promise<void> {
  const res = await ledger.post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [{ debit_account: 'connector:mock:clearing', credit_account: `merchant:${m}:available`, amount_minor: amount, code: 'charge' }] });
  expect(res.status).toBe(201);
}
const balance = async (account: string) => {
  const res = await fetch(`${ledger.url}/balances?account=${encodeURIComponent(account)}`, { headers: { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test' } });
  return res.status === 404 ? 0 : ((await res.json()) as { balance_minor: number }).balance_minor;
};
const pay = (m: string, amount: number, idem = key()) => ctx.as('pay-schedules').post('/payouts', { merchant_id: m, amount_minor: amount, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', idem);

describe('payouts contra el ledger real', () => {
  it('retiene, ordena el pago y confirma: el dinero del comercio baja y payout:clearing sube exactamente el monto', async () => {
    const m = merchantId();
    await fund(m, 50_000);
    const before = await balance('payout:clearing');
    const res = checked(ctx, 'POST', '/payouts', await pay(m, 30_000));
    expect(res.body).toMatchObject({ status: 'paid', amount_minor: 30_000 });
    expect(await balance(`merchant:${m}:available`)).toBe(20_000);
    expect((await balance('payout:clearing')) - before).toBe(30_000);
    const hold = (await fetch(`${ledger.url}/holds/${res.body.hold_id}`, { headers: { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test' } }).then((r) => r.json())) as { status: string; posted_amount_minor?: number };
    expect(hold).toMatchObject({ status: 'posted', posted_amount_minor: 30_000 });
  });

  it('un monto mayor al disponible lo rechaza el ledger real: 422 insufficient_funds, sin efecto', async () => {
    const m = merchantId();
    await fund(m, 5_000);
    const res = checked(ctx, 'POST', '/payouts', await pay(m, 5_001));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('insufficient_funds');
    expect(await balance(`merchant:${m}:available`)).toBe(5_000);
    expect(ctx.connectors.orders).toHaveLength(0);
  });

  it('kill-test del lane: 20 pagos simultáneos que juntos superan lo disponible ⇒ exactamente los que caben, saldo nunca negativo', async () => {
    const m = merchantId();
    await fund(m, 10_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => pay(m, 1_500)));
    const paid = results.filter((r) => r.body.status === 'paid').length;
    expect(paid).toBe(6);
    expect(results.filter((r) => r.status === 422)).toHaveLength(14);
    expect(await balance(`merchant:${m}:available`)).toBe(1_000);
    expect(ctx.connectors.executedCount).toBe(6);
  });

  it('diez pedidos con la misma clave: un solo pago en el ledger real', async () => {
    const m = merchantId();
    await fund(m, 10_000);
    const idem = key();
    const before = await balance('payout:clearing');
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(m, 3_000, idem)));
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await balance(`merchant:${m}:available`)).toBe(7_000);
    expect((await balance('payout:clearing')) - before).toBe(3_000);
  });

  it('el riel falla sin efecto: el ledger real anula la retención y el saldo vuelve entero', async () => {
    const m = merchantId();
    await fund(m, 9_000);
    ctx.connectors.scenario = 'unavailable';
    const res = await pay(m, 9_000);
    expect(res.body).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });
    expect(await balance(`merchant:${m}:available`)).toBe(9_000);
    const hold = (await fetch(`${ledger.url}/holds/${res.body.hold_id}`, { headers: { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test' } }).then((r) => r.json())) as { status: string; posted_amount_minor?: number };
    expect(hold.status).toBe('voided');
  });

  it('ambiguo: la retención real sigue viva (el dinero reservado) y la consulta «pagado» la confirma en el ledger real', async () => {
    const m = merchantId();
    await fund(m, 9_000);
    ctx.connectors.scenario = 'ambiguous_executed';
    const res = await pay(m, 9_000);
    expect(res.body.status).toBe('in_transit');
    expect(await balance(`merchant:${m}:available`)).toBe(0);
    await ctx.payouts.recover();
    const hold = (await fetch(`${ledger.url}/holds/${res.body.hold_id}`, { headers: { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'test' } }).then((r) => r.json())) as { status: string; posted_amount_minor?: number };
    expect(hold.status).toBe('posted');
  });
});

describe('el modo contra el ledger real (D-28)', () => {
  const liveBalance = async (account: string, mode: 'test' | 'live') => {
    const res = await fetch(`${ledger.url}/balances?account=${encodeURIComponent(account)}`, { headers: { 'x-service-id': 'pay-settlement', 'x-pay-mode': mode } });
    return res.status === 404 ? 0 : ((await res.json()) as { balance_minor: number }).balance_minor;
  };

  it('el dinero cargado en test no se puede pagar en live: el ledger real rechaza por saldo y no mueve nada; en test el mismo pago sale', async () => {
    const m = merchantId();
    await fund(m, 20_000); // `fund` carga en modo test
    const denied = checked(ctx, 'POST', '/payouts', await ctx.as('pay-schedules', 'live').post('/payouts', { merchant_id: m, amount_minor: 1_000, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key()));
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('insufficient_funds');
    expect(ctx.connectors.orders).toHaveLength(0);
    expect(await liveBalance(`merchant:${m}:available`, 'test')).toBe(20_000);
    expect(await liveBalance(`merchant:${m}:available`, 'live')).toBe(0);
    const ok = checked(ctx, 'POST', '/payouts', await pay(m, 1_000));
    expect(ok.body).toMatchObject({ status: 'paid' });
    expect(ctx.connectors.orders.map((o) => o.order.mode)).toEqual(['test']);
    // la retención vive solo en el modo en que se creó
    const asLive = await fetch(`${ledger.url}/holds/${ok.body.hold_id}`, { headers: { 'x-service-id': 'pay-settlement', 'x-pay-mode': 'live' } });
    expect(asLive.status).toBe(404);
  });

  it('el mismo comercio con dinero en los dos modos: cada pago sale de SU saldo en el ledger real', async () => {
    const m = merchantId();
    for (const mode of ['test', 'live'] as const) {
      const res = await ledger.post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [{ debit_account: 'connector:mock:clearing', credit_account: `merchant:${m}:available`, amount_minor: mode === 'test' ? 9_000 : 4_000, code: 'charge' }] }, undefined, mode);
      expect(res.status).toBe(201);
    }
    const [t, l] = [
      checked(ctx, 'POST', '/payouts', await ctx.as('pay-schedules', 'test').post('/payouts', { merchant_id: m, amount_minor: 3_000, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key())),
      checked(ctx, 'POST', '/payouts', await ctx.as('pay-schedules', 'live').post('/payouts', { merchant_id: m, amount_minor: 3_000, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key())),
    ];
    expect([t.body.status, l.body.status]).toEqual(['paid', 'paid']);
    expect(await liveBalance(`merchant:${m}:available`, 'test')).toBe(6_000);
    expect(await liveBalance(`merchant:${m}:available`, 'live')).toBe(1_000);
    // y un pago de live que no cabe en SU saldo (aunque test tenga de sobra) se rechaza
    const tooMuch = await ctx.as('pay-schedules', 'live').post('/payouts', { merchant_id: m, amount_minor: 2_000, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key());
    expect(tooMuch.status).toBe(422);
    expect(await liveBalance(`merchant:${m}:available`, 'live')).toBe(1_000);
  });
});

describe('cobros netos y conciliación contra el ledger real', () => {
  it('comisión programada: el ledger real acredita platform:fees y debita al comercio; sin saldo queda deuda y el ledger no se pasa de negativo', async () => {
    const m = merchantId();
    await fund(m, 700);
    const before = await balance('platform:fees');
    const res = await ctx.as('pay-schedules').post('/charges', { merchant_id: m, kind: 'provider_commission', reference: `sp_${unique()}ab:2026-10`, amount_minor: 1_200, currency: 'BOB' }).set('idempotency-key', key());
    expect(res.body).toMatchObject({ collected_minor: 700, debt_minor: 500, status: 'open' });
    expect(await balance(`merchant:${m}:available`)).toBe(0);
    expect((await balance('platform:fees')) - before).toBe(700);
    await fund(m, 600);
    await ctx.netting.collectOpenFor('test', m);
    expect(await balance(`merchant:${m}:available`)).toBe(100);
    expect((await balance('platform:fees')) - before).toBe(1_200);
  });

  it('conciliación: el extracto del banco contra el extracto REAL de la cuenta de compensación; la diferencia queda como excepción y el ledger no cambia', async () => {
    const m = merchantId();
    const ok = businessRef();
    const bad = businessRef();
    for (const [ref, net, fee] of [[ok, 9_700, 300], [bad, 4_850, 150]] as const) {
      const res = await ledger.post('/transactions', {
        business_ref: ref,
        attempt: 1,
        currency: 'BOB',
        legs: [
          { debit_account: 'connector:mock:clearing', credit_account: `merchant:${m}:pending`, amount_minor: net, code: 'charge' },
          { debit_account: 'connector:mock:clearing', credit_account: 'platform:fees', amount_minor: fee, code: 'fee' },
        ],
      });
      expect(res.status).toBe(201);
    }
    const now = new Date();
    const clearingBefore = await balance('connector:mock:clearing');
    const feesBefore = await balance('platform:fees');
    ctx.connectors.statements.set('mock', {
      format: 'json',
      lines: [
        { provider_reference: 'B1', our_reference: ok, direction: 'credit', amount_minor: 10_000, value_date: now.toISOString().slice(0, 10), booked_at: now.toISOString() },
        { provider_reference: 'B2', our_reference: bad, direction: 'credit', amount_minor: 4_900, value_date: now.toISOString().slice(0, 10), booked_at: now.toISOString() },
      ],
    });
    const started = await ctx.as('pay-console').post('/reconciliation_runs', { connector: 'mock', period_from: new Date(now.getTime() - 3_600_000).toISOString(), period_to: new Date(now.getTime() + 3_600_000).toISOString() }).set('idempotency-key', key());
    expect(started.status).toBe(202);
    await ctx.reconciliation.idle();
    const mine = (await ctx.as('pay-console').get('/reconciliation_exceptions')).body.data.filter((e: { business_ref: string }) => [ok, bad].includes(e.business_ref));
    expect(mine).toEqual([expect.objectContaining({ kind: 'amount_mismatch', business_ref: bad, statement_amount_minor: 4_900, ledger_amount_minor: 5_000 })]);
    expect(await balance('connector:mock:clearing')).toBe(clearingBefore);
    expect(await balance('platform:fees')).toBe(feesBefore);
    expect(await balance(`merchant:${m}:pending`)).toBe(9_700 + 4_850);
  });

  it('el saldo y el extracto de una cuenta que el ledger real nunca vio son «sin movimientos», no un error', async () => {
    const client = new HttpLedgerClient(ledger.url, 5000);
    expect(await client.getBalance('test', `merchant:${merchantId()}:available`)).toBeUndefined();
    expect(await client.listStatement('test', `merchant:${merchantId()}:pending`, {})).toEqual([]);
  });
});
