import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { BATCH_BODY, feeSchedule, ref, registerMerchant } from './helpers/scenarios';

const FROM = '2026-10-01T00:00:00.000Z';
const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T15:00:00Z`);

let ctx: SettlementTestContext;
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

const exportOf = async (query = '', caller = 'pay-console') => {
  const to = new Date(Date.now() - 5).toISOString();
  return ctx.as(caller).get(`/exports/accounting?period_from=${FROM}&period_to=${to}${query}`);
};

describe('exportación de asientos para M16 (P2.H2.M7, REQ-P2-8, D-21)', () => {
  it('por comercio: cada cobro con bruto = neto + comisión, el abono y la comisión programada; cuadra con platform:fees del ledger', async () => {
    const [a, b] = [merchantId(), merchantId()];
    await registerMerchant(ctx, a);
    await registerMerchant(ctx, b);
    await ctx.consumers.handle(feeSchedule(a, 1, 1000));
    const [r1, r2, r3] = [ref(), ref(), ref()];
    ctx.ledger.seedCharge({ merchant: a, net: 9700, fee: 300, at: at(2), ref: r1 });
    ctx.ledger.seedCharge({ merchant: a, net: 4850, fee: 150, at: at(3), ref: r2 });
    ctx.ledger.seedCharge({ merchant: b, net: 975, fee: 25, at: at(4), ref: r3 });
    // reembolso parcial del primer cobro (la comisión no se devuelve en este escenario)
    ctx.ledger.seedMovement({ debit: `merchant:${a}:pending`, credit: 'connector:mock:clearing', amount: 2000, at: at(5), ref: r1, code: 'refund' });
    await ctx.as('pay-console').post('/batches', BATCH_BODY('2026-10-12')).set('idempotency-key', key()); // cobra el abono de `a`
    await ctx.as('pay-schedules').post('/charges', { merchant_id: b, kind: 'provider_commission', reference: 'sp_abcdefghijklmn:2026-10', amount_minor: 0 + 1, currency: 'BOB' }).set('idempotency-key', key());

    const res = await exportOf();
    expect(res.status).toBe(200);
    const doc = res.body;
    expect(doc).toMatchObject({ schema: 'alovida-pay.accounting-export/v1', currency: 'BOB', balanced: true });
    expect(doc.ledger.unassigned_minor).toBe(0);
    expect(doc.ledger.difference_minor).toBe(0);
    const byMerchant = Object.fromEntries(doc.merchants.map((m: { merchant_id: string }) => [m.merchant_id, m]));
    expect(byMerchant[a].lines).toEqual(
      expect.arrayContaining([
        { kind: 'charge', reference: r1, gross_minor: 10000, fee_minor: 300, net_minor: 9700 },
        { kind: 'refund', reference: r1, gross_minor: 2000, fee_minor: 0, net_minor: 2000 },
        { kind: 'charge', reference: r2, gross_minor: 5000, fee_minor: 150, net_minor: 4850 },
        expect.objectContaining({ kind: 'monthly_fee', fee_minor: 1000, gross_minor: 1000 }),
      ]),
    );
    expect(byMerchant[a].total_fee_minor).toBe(300 + 150 + 1000);
    expect(byMerchant[b].lines).toEqual(expect.arrayContaining([{ kind: 'charge', reference: r3, gross_minor: 1000, fee_minor: 25, net_minor: 975 }]));
    // el total exportado de comisiones ES lo que tiene platform:fees en el ledger
    expect(doc.totals.fee_minor).toBe(ctx.ledger.balanceOf('platform:fees'));
    expect(doc.ledger.platform_fees_minor).toBe(ctx.ledger.balanceOf('platform:fees'));
  });

  it('un contracargo sale como línea del comercio pero NO suma a las comisiones', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 5000, fee: 100, at: at(2), ref: ref() });
    ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount: 3000, at: at(3), ref: ref(), code: 'release' });
    await ctx.as('pay-payments').post('/charges', { merchant_id: m, kind: 'chargeback_debt', reference: 'dp_abcdefghijklmn', amount_minor: 3000, currency: 'BOB', connector: 'mercantil_qr' }).set('idempotency-key', key());
    const doc = (await exportOf()).body;
    const merchant = doc.merchants.find((x: { merchant_id: string }) => x.merchant_id === m);
    expect(merchant.lines.find((l: { kind: string }) => l.kind === 'chargeback_debt')).toMatchObject({ fee_minor: 0, net_minor: 3000 });
    expect(doc.totals.fee_minor).toBe(100);
    expect(doc.balanced).toBe(true);
  });

  it('NO cuadra si hay comisión en el ledger sin comercio: se devuelve igual, con la diferencia a la vista', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 900, fee: 100, at: at(2), ref: ref() });
    ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: 'platform:fees', amount: 77, at: at(3), ref: ref(), code: 'fee' }); // comisión huérfana
    const doc = (await exportOf()).body;
    expect(doc.balanced).toBe(false);
    expect(doc.ledger).toEqual({ platform_fees_minor: 177, unassigned_minor: 77, difference_minor: 77 });
    expect(doc.totals.fee_minor).toBe(100);
  });

  it('un periodo sin movimientos exporta vacío y cuadra', async () => {
    const doc = (await exportOf()).body;
    expect(doc).toMatchObject({ merchants: [], totals: { gross_minor: 0, fee_minor: 0, net_minor: 0 }, balanced: true });
  });

  it('propiedad (30 casos con semilla fija): lo exportado suma exactamente lo que el ledger tiene en platform:fees', async () => {
    let seed = 20261027n;
    const next = (limit: number): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return Number((seed >> 11n) % BigInt(limit));
    };
    const merchants = [merchantId(), merchantId(), merchantId()];
    for (const m of merchants) await registerMerchant(ctx, m);
    let feeTotal = 0;
    for (let i = 0; i < 30; i += 1) {
      const fee = next(5000);
      feeTotal += fee;
      ctx.ledger.seedCharge({ merchant: merchants[next(3)], net: 1 + next(900_000), fee, at: at(2 + next(20)), ref: ref() });
    }
    const doc = (await exportOf()).body;
    expect(doc.balanced).toBe(true);
    expect(doc.totals.fee_minor).toBe(feeTotal);
    expect(doc.totals.gross_minor - doc.totals.fee_minor).toBe(doc.totals.net_minor);
  });

  describe('periodo cerrado y forma del pedido', () => {
    it('un periodo que no terminó es 409; invertido o mal escrito, 422; un campo de más, 422', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const res = await ctx.as('pay-console').get(`/exports/accounting?period_from=${FROM}&period_to=${future}`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('invalid_state_transition');
      expect((await ctx.as('pay-console').get(`/exports/accounting?period_from=${FROM}&period_to=${FROM}`)).status).toBe(422);
      expect((await ctx.as('pay-console').get('/exports/accounting?period_from=ayer&period_to=hoy')).status).toBe(422);
      expect((await exportOf('&merchant_id=mc_x')).status).toBe(422);
      expect((await exportOf('&format=xml')).status).toBe(422);
    });

    it('un corte del periodo que no se completó impide exportar (409): no se exporta a medias', async () => {
      const m = merchantId();
      await registerMerchant(ctx, m);
      ctx.ledger.seedCharge({ merchant: m, net: 800, fee: 0, at: new Date('2026-10-01T10:00:00Z'), ref: ref() });
      ctx.ledger.rejectNextTransaction();
      await ctx.as('pay-console').post('/batches', BATCH_BODY('2026-10-12')).set('idempotency-key', key());
      expect((await ctx.db.pool.query('SELECT status FROM settlement_batches')).rows[0].status).toBe('failed');
      const res = await exportOf();
      expect(res.status).toBe(409);
      expect(res.body.detail).toMatch(/cortes/);
      // al reintentar el corte y completarlo, se puede exportar
      await ctx.as('pay-console').post('/batches', BATCH_BODY('2026-10-12')).set('idempotency-key', key());
      expect((await exportOf()).status).toBe(200);
    });

    it('solo la consola de operación exporta', async () => {
      for (const caller of ['pay-schedules', 'pay-edge', 'pay-payments']) expect((await exportOf('', caller)).status).toBe(403);
    });

    it('el ledger caído es 503 y no se devuelve un documento parcial', async () => {
      const m = merchantId();
      await registerMerchant(ctx, m);
      ctx.ledger.failNext('listStatement');
      const res = await exportOf();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('ledger_unavailable');
      expect(res.body.merchants).toBeUndefined();
    });
  });

  it('CSV para M16: una fila por línea, importes enteros en centavos, sin datos personales', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    const r1 = ref();
    ctx.ledger.seedCharge({ merchant: m, net: 9700, fee: 300, at: at(2), ref: r1 });
    const res = await exportOf('&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.trim().split('\n')).toEqual(['merchant_id,kind,reference,gross_minor,fee_minor,net_minor,currency', `${m},charge,${r1},10000,300,9700,BOB`]);
  });
});

void checked;
