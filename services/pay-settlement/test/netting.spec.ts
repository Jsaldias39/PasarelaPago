import { LedgerUnavailableError } from '../src/settlement/errors';
import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { loadEventValidators } from './helpers/events-contract';
import { BATCH_BODY, feeSchedule, ref, registerMerchant } from './helpers/scenarios';

const CUT_OCT_19 = '2026-10-19';
const CUT_OCT_26 = '2026-10-26';
const BEFORE_CUT_1 = new Date('2026-10-05T15:00:00Z');
const BEFORE_CUT_2 = new Date('2026-10-14T15:00:00Z');

let ctx: SettlementTestContext;
let merchantValidators: Awaited<ReturnType<typeof loadEventValidators>>;
beforeAll(async () => {
  merchantValidators = await loadEventValidators('merchants-schedules.yaml');
});
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

const runBatch = (cutoff: string) => ctx.as('pay-console').post('/batches', BATCH_BODY(cutoff)).set('idempotency-key', key());
const fees = () => ctx.ledger.balanceOf('platform:fees');
const available = (m: string) => ctx.ledger.balanceOf(`merchant:${m}:available`);
const plan = async (m: string, version: number, fee: number | undefined, over?: Parameters<typeof feeSchedule>[3]) => {
  const event = feeSchedule(m, version, fee, over);
  expect(merchantValidators.get('fee_schedule.published')?.(event)).toEqual([]); // el evento de la prueba cumple el contrato
  return ctx.consumers.handle(event);
};
const charges = async () => (await ctx.db.pool.query('SELECT kind, period_key, amount_minor, collected_minor, status FROM settlement_charges ORDER BY created_at')).rows;

describe('abono mensual (P2.H2.M9, D-07)', () => {
  it('el corte cobra el abono contra el saldo ANTES de pagar: payout = liberado − abono; una sola vez por mes', async () => {
    const m = merchantId();
    expect(await plan(m, 1, 2000)).toBe('processed');
    ctx.ledger.seedCharge({ merchant: m, net: 10000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    ctx.ledger.seedCharge({ merchant: m, net: 5000, fee: 0, at: BEFORE_CUT_2, ref: ref() });
    await runBatch(CUT_OCT_19);
    expect(fees()).toBe(2000);
    expect(await charges()).toEqual([{ kind: 'monthly_fee', period_key: '2026-10', amount_minor: '2000', collected_minor: '2000', status: 'collected' }]);
    expect((await ctx.db.pool.query('SELECT amount_minor FROM settlement_payouts')).rows).toEqual([{ amount_minor: '8000' }]);
    // segundo corte del MISMO mes: no cobra otra vez
    await runBatch(CUT_OCT_26);
    expect(fees()).toBe(2000);
    expect(await charges()).toHaveLength(1);
    expect((await ctx.db.pool.query('SELECT amount_minor FROM settlement_payouts ORDER BY created_at')).rows).toEqual([{ amount_minor: '8000' }, { amount_minor: '5000' }]);
  });

  it('el mes siguiente sí se cobra otro abono (cortes del 28/9 y del 5/10)', async () => {
    const m = merchantId();
    await plan(m, 1, 2000);
    ctx.ledger.seedCharge({ merchant: m, net: 10000, fee: 0, at: new Date('2026-09-10T15:00:00Z'), ref: ref() });
    ctx.ledger.seedCharge({ merchant: m, net: 6000, fee: 0, at: new Date('2026-09-25T15:00:00Z'), ref: ref() });
    await runBatch('2026-09-28');
    expect(fees()).toBe(2000);
    await runBatch('2026-10-05');
    expect(fees()).toBe(4000);
    expect((await charges()).map((c: { period_key: string }) => c.period_key)).toEqual(['2026-09', '2026-10']);
    expect((await ctx.db.pool.query('SELECT amount_minor FROM settlement_payouts ORDER BY created_at')).rows).toEqual([{ amount_minor: '8000' }, { amount_minor: '4000' }]);
  });

  it('repetir el corte del mismo lunes no vuelve a cobrar el abono', async () => {
    const m = merchantId();
    await plan(m, 1, 500);
    ctx.ledger.seedCharge({ merchant: m, net: 3000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    await runBatch(CUT_OCT_19);
    await runBatch(CUT_OCT_19);
    expect(fees()).toBe(500);
    expect(ctx.ledger.entries.filter((e) => e.account === 'platform:fees')).toHaveLength(1);
  });

  it('si el saldo no alcanza, cobra lo que hay, deja la DEUDA abierta y no paga nada; el corte siguiente la netea primero', async () => {
    const m = merchantId();
    await plan(m, 1, 2000);
    ctx.ledger.seedCharge({ merchant: m, net: 1500, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    await runBatch(CUT_OCT_19);
    expect(fees()).toBe(1500);
    expect(await charges()).toEqual([{ kind: 'monthly_fee', period_key: '2026-10', amount_minor: '2000', collected_minor: '1500', status: 'open' }]);
    expect(await ctx.db.pool.query('SELECT 1 FROM settlement_payouts').then((r) => r.rowCount)).toBe(0);
    expect(available(m)).toBe(0); // nunca queda negativo

    ctx.ledger.seedCharge({ merchant: m, net: 3000, fee: 0, at: BEFORE_CUT_2, ref: ref() });
    await runBatch(CUT_OCT_26);
    expect(fees()).toBe(2000);
    expect((await charges())[0]).toMatchObject({ collected_minor: '2000', status: 'collected' });
    expect((await ctx.db.pool.query('SELECT amount_minor FROM settlement_payouts')).rows).toEqual([{ amount_minor: '2500' }]);
    // cada cobro parcial quedó con su propio asiento (referencias distintas) y todos posteados
    expect((await ctx.db.pool.query("SELECT seq, amount_minor, status FROM settlement_charge_collections ORDER BY seq")).rows).toEqual([
      { seq: 1, amount_minor: '1500', status: 'posted' },
      { seq: 2, amount_minor: '500', status: 'posted' },
    ]);
  });

  it('un comercio con abono y sin ventas queda debiendo el abono (no se inventa saldo) y entra al corte por el tarifario', async () => {
    const m = merchantId();
    await plan(m, 1, 900);
    const res = await runBatch(CUT_OCT_19);
    expect(res.body).toMatchObject({ status: 'completed', merchants_count: 1, payouts_count: 0 });
    expect(await charges()).toEqual([{ kind: 'monthly_fee', period_key: '2026-10', amount_minor: '900', collected_minor: '0', status: 'open' }]);
    expect(fees()).toBe(0);
  });

  describe('tarifario (fee_schedule.published): versión, vigencia y duplicados', () => {
    it('una versión vieja que llega tarde no pisa a la nueva; la misma versión repetida y un evento duplicado no cambian nada', async () => {
      const m = merchantId();
      const v2 = feeSchedule(m, 2, 800);
      expect(await ctx.consumers.handle(v2)).toBe('processed');
      expect(await ctx.consumers.handle(v2)).toBe('duplicate');
      expect(await plan(m, 1, 5000)).toBe('processed'); // llegó tarde: se registra en el inbox pero no pisa
      const row = (await ctx.db.pool.query('SELECT version, monthly_fee_minor FROM settlement_fee_plans WHERE merchant_id = $1', [m])).rows[0];
      expect(row).toEqual({ version: 2, monthly_fee_minor: '800' });
      expect(await plan(m, 3, 0)).toBe('processed'); // sin abono desde la v3
      expect((await ctx.db.pool.query('SELECT monthly_fee_minor FROM settlement_fee_plans WHERE merchant_id = $1', [m])).rows[0].monthly_fee_minor).toBe('0');
    });

    it('sin monthly_fee_minor no hay abono; con la vigencia vencida o futura tampoco', async () => {
      const [none, expired, future] = [merchantId(), merchantId(), merchantId()];
      await plan(none, 1, undefined);
      await plan(expired, 1, 700, { effectiveTo: '2026-09-30T00:00:00.000Z' });
      await plan(future, 1, 700, { effectiveFrom: '2026-12-01T00:00:00.000Z' });
      for (const m of [none, expired, future]) ctx.ledger.seedCharge({ merchant: m, net: 1000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
      await runBatch(CUT_OCT_19);
      expect(await charges()).toEqual([]);
      expect(fees()).toBe(0);
    });

    it.each([
      ['sin merchant_id', (e: ReturnType<typeof feeSchedule>) => ({ ...e, data: { ...e.data, merchant_id: undefined } })],
      ['versión 0', (e: ReturnType<typeof feeSchedule>) => ({ ...e, data: { ...e.data, version: 0 } })],
      ['abono negativo', (e: ReturnType<typeof feeSchedule>) => ({ ...e, data: { ...e.data, monthly_fee_minor: -1 } })],
      ['moneda distinta', (e: ReturnType<typeof feeSchedule>) => ({ ...e, data: { ...e.data, currency: 'USD' } })],
      ['fecha ilegible', (e: ReturnType<typeof feeSchedule>) => ({ ...e, data: { ...e.data, effective_from: 'ayer' } })],
    ])('un evento inválido (%s) se descarta sin tocar nada', async (_n, mutate) => {
      const m = merchantId();
      expect(await ctx.consumers.handle(mutate(feeSchedule(m, 1, 100)))).toBe('invalid');
      expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_fee_plans')).rows[0].n).toBe(0);
    });

    it('el sobre inválido, un evento de otro origen y un tipo que no es nuestro se descartan o ignoran', async () => {
      expect(await ctx.consumers.handle({ nada: true })).toBe('invalid');
      expect(await ctx.consumers.handle(null)).toBe('invalid');
      expect(await ctx.consumers.handle({ ...feeSchedule(merchantId(), 1, 100), source: '/pay-cualquiera' })).toBe('ignored'); // un tercero no puede fijar tarifarios
      expect(await ctx.consumers.handle({ ...feeSchedule(merchantId(), 1, 100), type: 'merchant.created' })).toBe('ignored');
      expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_fee_plans')).rows[0].n).toBe(0);
    });
  });

  it('el ledger responde mal justo al cobrar el abono (el asiento SÍ se aplicó): el reintento no cobra dos veces', async () => {
    const m = merchantId();
    await plan(m, 1, 2000);
    ctx.ledger.seedCharge({ merchant: m, net: 10000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    // la primera createTransaction del corte es la liberación; la segunda, el cobro del abono
    ctx.ledger.failNext('createTransaction', new LedgerUnavailableError(), 1, true);
    const idem = key();
    const first = await ctx.as('pay-console').post('/batches', BATCH_BODY(CUT_OCT_19)).set('idempotency-key', idem);
    expect(first.status).toBe(503);
    const retry = await ctx.as('pay-console').post('/batches', BATCH_BODY(CUT_OCT_19)).set('idempotency-key', idem);
    expect(retry.body.status).toBe('completed');
    expect(fees()).toBe(2000);
    expect((await charges())[0]).toMatchObject({ collected_minor: '2000', status: 'collected' });
    expect(ctx.ledger.balanceOf('payout:clearing')).toBe(8000);
  });
});

describe('comisión programada de proveedores y deuda por contracargo (P2.H2.M5, 7.8, D-22)', () => {
  const charge = (body: object, idem = key(), caller = 'pay-schedules') => ctx.as(caller).post('/charges', body).set('idempotency-key', idem);
  const commission = (m: string, amount: number, reference = 'sp_abcdefghijklmn:2026-10') => ({ merchant_id: m, kind: 'provider_commission', reference, amount_minor: amount, currency: 'BOB' });
  const fund = (m: string, amount: number) => ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release' });

  it('netea la comisión contra el saldo: el asiento deja platform:fees acreditada y el saldo del comercio debitado', async () => {
    const m = merchantId();
    fund(m, 5000);
    const res = await charge(commission(m, 1200));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ object: 'settlement_charge', merchant_id: m, kind: 'provider_commission', amount_minor: 1200, collected_minor: 1200, debt_minor: 0, status: 'collected' });
    expect(available(m)).toBe(3800);
    expect(fees()).toBe(1200);
    const entry = ctx.ledger.entries.find((e) => e.account === 'platform:fees');
    expect(entry).toMatchObject({ direction: 'credit', counterparty_account: `merchant:${m}:available`, code: 'fee', amount_minor: 1200 });
  });

  it('saldo insuficiente: cobra lo que hay y el resto queda como deuda; nunca deja el saldo en negativo', async () => {
    const m = merchantId();
    fund(m, 700);
    const res = await charge(commission(m, 1200));
    expect(res.body).toMatchObject({ collected_minor: 700, debt_minor: 500, status: 'open' });
    expect(available(m)).toBe(0);
    // sin saldo: la deuda no se mueve y el cobro no falla
    const none = await charge(commission(merchantId(), 100, 'sp_otrootrootroo:2026-10'));
    expect(none.body).toMatchObject({ collected_minor: 0, debt_minor: 100, status: 'open' });
  });

  it('la deuda se cobra en el corte, ANTES del payout', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    await charge(commission(m, 1200)); // sin saldo todavía: deuda completa
    ctx.ledger.seedCharge({ merchant: m, net: 5000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    await runBatch(CUT_OCT_19);
    expect(fees()).toBe(1200);
    expect((await ctx.db.pool.query('SELECT amount_minor FROM settlement_payouts')).rows).toEqual([{ amount_minor: '3800' }]);
    expect(await charges()).toEqual([{ kind: 'provider_commission', period_key: 'sp_abcdefghijklmn:2026-10', amount_minor: '1200', collected_minor: '1200', status: 'collected' }]);
  });

  it('contracargo: se debita del saldo hacia el conector (código refund); exige el conector; la comisión no lo admite', async () => {
    const m = merchantId();
    fund(m, 3000);
    const ok = await charge({ merchant_id: m, kind: 'chargeback_debt', reference: 'dp_abcdefghijklmn', amount_minor: 3000, currency: 'BOB', connector: 'mercantil_qr' }, key(), 'pay-payments');
    expect(ok.body).toMatchObject({ kind: 'chargeback_debt', collected_minor: 3000, status: 'collected' });
    expect(ctx.ledger.entries.find((e) => e.account === 'connector:mercantil_qr:clearing')).toMatchObject({ direction: 'credit', code: 'refund', counterparty_account: `merchant:${m}:available` });
    expect(fees()).toBe(0); // un contracargo no es ingreso de la plataforma
    expect((await charge({ merchant_id: m, kind: 'chargeback_debt', reference: 'dp_otrootrootroo', amount_minor: 1, currency: 'BOB' }, key(), 'pay-payments')).status).toBe(422);
    expect((await charge({ ...commission(m, 1), connector: 'mercantil_qr' })).status).toBe(422);
  });

  it('idempotencia: misma clave ⇒ misma respuesta; misma referencia con otra clave ⇒ el mismo cobro; con otro monto ⇒ 409; nunca se cobra dos veces', async () => {
    const m = merchantId();
    fund(m, 10_000);
    const idem = key();
    const first = await charge(commission(m, 1000), idem);
    const replay = await charge(commission(m, 1000), idem);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const other = await charge(commission(m, 1000));
    expect(other.body.id).toBe(first.body.id);
    expect((await charge(commission(m, 1001))).status).toBe(409);
    expect((await charge(commission(m, 1000), idem)).status).toBe(201);
    expect((await charge(commission(m, 999), idem)).body.code).toBe('idempotency_key_reused');
    expect(fees()).toBe(1000);
    expect(available(m)).toBe(9000);
  });

  it('cinco pedidos simultáneos por la misma comisión: se cobra una sola vez', async () => {
    const m = merchantId();
    fund(m, 10_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => charge(commission(m, 1000))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(fees()).toBe(1000);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_charge_collections')).rows[0].n).toBe(1);
  });

  it('el ledger se cae después de aplicar el asiento: 503 y el reintento no cobra de más', async () => {
    const m = merchantId();
    fund(m, 10_000);
    ctx.ledger.failNext('createTransaction', new LedgerUnavailableError(), 1, true);
    const idem = key();
    expect((await charge(commission(m, 1000), idem)).status).toBe(503);
    expect(fees()).toBe(1000); // el asiento ya estaba
    const retry = await charge(commission(m, 1000), idem);
    expect(retry.body).toMatchObject({ status: 'collected', collected_minor: 1000 });
    expect(fees()).toBe(1000);
  });

  it('el saldo cambió entre leerlo y cobrar (el ledger rechaza): ese intento queda quemado, el cobro sigue abierto y el siguiente usa otra referencia', async () => {
    const m = merchantId();
    fund(m, 10_000);
    ctx.ledger.rejectNextTransaction();
    const res = await charge(commission(m, 1000));
    expect(res.body).toMatchObject({ collected_minor: 0, status: 'open' });
    expect((await ctx.db.pool.query('SELECT status FROM settlement_charge_collections')).rows).toEqual([{ status: 'rejected' }]);
    const again = await ctx.netting.collect(res.body.id);
    expect(again).toMatchObject({ status: 'collected' });
    expect(fees()).toBe(1000);
    expect((await ctx.db.pool.query('SELECT seq, status FROM settlement_charge_collections ORDER BY seq')).rows).toEqual([
      { seq: 1, status: 'rejected' },
      { seq: 2, status: 'posted' },
    ]);
  });

  it.each([
    ['monto 0', (m: string) => commission(m, 0)],
    ['monto con decimales', (m: string) => commission(m, 1.5)],
    ['tipo abono mensual (lo crea el corte, no un llamador)', (m: string) => ({ ...commission(m, 10), kind: 'monthly_fee' })],
    ['referencia con espacios', (m: string) => commission(m, 10, 'con espacios')],
    ['moneda distinta', (m: string) => ({ ...commission(m, 10), currency: 'USD' })],
    ['campo no declarado', (m: string) => ({ ...commission(m, 10), destination: 'platform:fees' })],
  ])('rechaza %s con 422 y no crea nada', async (_n, make) => {
    const m = merchantId();
    fund(m, 100);
    expect((await charge(make(m))).status).toBe(422);
    expect(await charges()).toEqual([]);
    expect(available(m)).toBe(100);
  });

  it('autorización: pay-edge, pay-risk y pay-vault no cobran; pay-schedules, pay-payments y la consola sí', async () => {
    const m = merchantId();
    fund(m, 100);
    for (const caller of ['pay-edge', 'pay-risk', 'pay-vault']) expect((await charge(commission(m, 1), key(), caller)).status).toBe(403);
    expect((await charge(commission(m, 1, 'sp_unounounounou:2026-10'), key(), 'pay-schedules')).status).toBe(201);
    expect((await charge(commission(m, 1, 'sp_dosdosdosdos:2026-10'), key(), 'pay-console')).status).toBe(201);
    expect((await ctx.as('pay-schedules').post('/charges', commission(m, 1))).status).toBe(400);
  });
});

void checked;
