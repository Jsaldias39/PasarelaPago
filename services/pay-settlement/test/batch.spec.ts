import { LedgerRejectedError } from '../src/settlement/errors';
import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { loadEventValidators } from './helpers/events-contract';
import { BATCH_BODY, ref, registerMerchant } from './helpers/scenarios';

// Lunes de corte (D-19). El corte del 2026-10-19 libera lo cobrado antes del 2026-10-12 00:00 local (T+7).
const CUT_1 = '2026-10-19';
const CUT_2 = '2026-10-26';
const BEFORE_CUT_1 = new Date('2026-10-05T15:00:00Z');
const AFTER_CUT_1 = new Date('2026-10-15T15:00:00Z'); // cobrado, pero todavía no vence (T+7)
const BEFORE_CUT_2 = new Date('2026-10-14T15:00:00Z');

let ctx: SettlementTestContext;
let validators: Awaited<ReturnType<typeof loadEventValidators>>;
beforeAll(async () => {
  validators = await loadEventValidators('ledger-settlement.yaml');
});
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

const runBatch = (body: object, idem = key()) => ctx.as('pay-console').post('/batches', body).set('idempotency-key', idem);
const pending = (m: string) => ctx.ledger.balanceOf(`merchant:${m}:pending`);
const available = (m: string) => ctx.ledger.balanceOf(`merchant:${m}:available`);
const valid = async (type: string) => {
  const events = await ctx.events(type);
  for (const e of events) expect(validators.get(type)?.(e)).toEqual([]);
  return events;
};

describe('corte semanal (P2.H2.M2, REQ-P2-5)', () => {
  it('libera lo vencido (T+7) y paga una vez por comercio; lo cobrado después sigue pendiente', async () => {
    const [a, b] = [merchantId(), merchantId()];
    await registerMerchant(ctx, a);
    await registerMerchant(ctx, b);
    ctx.ledger.seedCharge({ merchant: a, net: 9700, fee: 300, at: BEFORE_CUT_1, ref: ref() });
    ctx.ledger.seedCharge({ merchant: a, net: 4850, fee: 150, at: BEFORE_CUT_1, ref: ref() });
    ctx.ledger.seedCharge({ merchant: a, net: 1940, fee: 60, at: AFTER_CUT_1, ref: ref() }); // no vence todavía
    ctx.ledger.seedCharge({ merchant: b, net: 975, fee: 25, at: BEFORE_CUT_1, ref: ref() });

    const res = checked(ctx, 'POST', '/batches', await runBatch(BATCH_BODY(CUT_1)));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ object: 'settlement_batch', cutoff_date: CUT_1, release_before: '2026-10-12T04:00:00.000Z', status: 'completed', merchants_count: 2, payouts_count: 2, released_minor: 9700 + 4850 + 975 });

    expect(pending(a)).toBe(1940); // lo de después del corte queda pendiente
    expect(pending(b)).toBe(0);
    expect(available(a)).toBe(0); // todo lo liberado salió como payout
    const payouts = checked(ctx, 'GET', '/payouts', await ctx.as('pay-console').get('/payouts'));
    expect(payouts.body.data.map((p: { amount_minor: number }) => p.amount_minor).sort((x: number, y: number) => x - y)).toEqual([975, 14550]);
    expect(payouts.body.data.every((p: { status: string; batch_id: string }) => p.status === 'paid' && p.batch_id === res.body.id)).toBe(true);
    expect(ctx.connectors.executedCount).toBe(2);
    // el payout del corte lleva el periodo del corte y se cuenta
    expect(await valid('payout.created')).toHaveLength(2);
    expect(await valid('payout.paid')).toHaveLength(2);
    const closed = await valid('settlement.batch.closed');
    expect(closed).toHaveLength(1);
    expect(closed[0].data).toMatchObject({ settlement_batch_id: res.body.id, merchants_count: 2, payouts_count: 2, released_minor: 15525 });
  });

  it('correr el corte dos veces el mismo lunes devuelve el mismo lote y no mueve dinero otra vez', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 5000, fee: 100, at: BEFORE_CUT_1, ref: ref() });
    const first = await runBatch(BATCH_BODY(CUT_1));
    const txCalls = ctx.ledger.count('createTransaction');
    const holdCalls = ctx.ledger.count('createHold');
    const second = checked(ctx, 'POST', '/batches', await runBatch(BATCH_BODY(CUT_1)));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(ctx.ledger.count('createTransaction')).toBe(txCalls);
    expect(ctx.ledger.count('createHold')).toBe(holdCalls);
    expect(ctx.connectors.executedCount).toBe(1);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_batches')).rows[0].n).toBe(1);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_payouts')).rows[0].n).toBe(1);
    expect(await ctx.events('settlement.batch.closed')).toHaveLength(1);
  });

  it('la misma Idempotency-Key repite la respuesta guardada', async () => {
    const idem = key();
    const first = await runBatch(BATCH_BODY(CUT_1), idem);
    const again = await runBatch(BATCH_BODY(CUT_1), idem);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
  });

  it('cinco cortes simultáneos del mismo lunes: un solo lote, un solo pago por comercio, el dinero sale una vez', async () => {
    const merchants = [merchantId(), merchantId(), merchantId()];
    for (const m of merchants) {
      await registerMerchant(ctx, m);
      ctx.ledger.seedCharge({ merchant: m, net: 7000, fee: 200, at: BEFORE_CUT_1, ref: ref() });
    }
    const results = await Promise.all(Array.from({ length: 5 }, () => runBatch(BATCH_BODY(CUT_1))));
    expect(results.map((r) => r.status).sort()).toContain(201);
    expect(new Set(results.filter((r) => r.status < 400).map((r) => r.body.id)).size).toBe(1);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_batches')).rows[0].n).toBe(1);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_payouts')).rows[0].n).toBe(3);
    expect(ctx.connectors.executedCount).toBe(3);
    for (const m of merchants) expect(ctx.ledger.balanceOf(`merchant:${m}:available`)).toBe(0);
    // el servicio nunca soltó más dinero del que cobró
    expect(ctx.ledger.balanceOf('payout:clearing')).toBe(21000);
  });

  it('el corte siguiente solo mira lo que vence en su ventana (la marca de agua avanza)', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 1000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    ctx.ledger.seedCharge({ merchant: m, net: 2000, fee: 0, at: BEFORE_CUT_2, ref: ref() });
    await runBatch(BATCH_BODY(CUT_1));
    expect(pending(m)).toBe(2000);
    ctx.ledger.calls.length = 0;
    const second = await runBatch(BATCH_BODY(CUT_2));
    expect(second.body).toMatchObject({ status: 'completed', released_minor: 2000 });
    expect(pending(m)).toBe(0);
    // la segunda lectura del extracto empieza en la marca de agua del primer corte, no en el origen de los tiempos
    const read = ctx.ledger.calls.find((c) => c.op === 'listStatement' && (c.args as { account: string }).account === `merchant:${m}:pending`);
    expect((read?.args as { from?: string }).from).toBe('2026-10-12T04:00:00.000Z');
  });

  it('un reembolso posterior al vencimiento no deja liberar de más y se descuenta en la ventana que le toca', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 10000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    // reembolso de 4000 cobrado DESPUÉS del vencimiento pero antes del corte: el saldo pendiente real es 6000
    ctx.ledger.seedMovement({ debit: `merchant:${m}:pending`, credit: 'connector:mock:clearing', amount: 4000, at: AFTER_CUT_1, ref: ref(), code: 'refund' });
    const first = await runBatch(BATCH_BODY(CUT_1));
    expect(first.body.released_minor).toBe(6000); // min(vencido 10000, saldo 6000)
    expect(pending(m)).toBe(0);
    const row = (await ctx.db.pool.query('SELECT residual_minor FROM settlement_merchants WHERE merchant_id = $1', [m])).rows[0];
    expect(row.residual_minor).toBe('4000'); // lo que faltó liberar se arrastra
    // el reembolso de la ventana siguiente compensa exactamente ese arrastre: no se libera nada más
    const second = await runBatch(BATCH_BODY(CUT_2));
    expect(second.body.released_minor).toBe(0);
    expect((await ctx.db.pool.query('SELECT residual_minor FROM settlement_merchants WHERE merchant_id = $1', [m])).rows[0].residual_minor).toBe('0');
  });

  it('límite: un comercio sin ventas, un comercio sin nada que liberar y un monto de 1 centavo', async () => {
    const [idle, tiny] = [merchantId(), merchantId()];
    await registerMerchant(ctx, idle);
    await registerMerchant(ctx, tiny);
    ctx.ledger.seedCharge({ merchant: tiny, net: 1, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    const res = await runBatch(BATCH_BODY(CUT_1));
    expect(res.body).toMatchObject({ status: 'completed', merchants_count: 2, payouts_count: 1, released_minor: 1 });
    expect((await ctx.db.pool.query('SELECT amount_minor FROM settlement_payouts')).rows).toEqual([{ amount_minor: '1' }]);
  });

  it('un comercio que aparece a mitad del corte entra en el siguiente, no en este', async () => {
    const early = merchantId();
    await registerMerchant(ctx, early);
    ctx.ledger.seedCharge({ merchant: early, net: 100, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    await runBatch(BATCH_BODY(CUT_1));
    const late = merchantId();
    await registerMerchant(ctx, late);
    ctx.ledger.seedCharge({ merchant: late, net: 300, fee: 0, at: BEFORE_CUT_1, ref: ref() });
    // el lote del 19 ya está cerrado: repetirlo no suma al comercio nuevo
    const again = await runBatch(BATCH_BODY(CUT_1));
    expect(again.body.merchants_count).toBe(1);
    expect(pending(late)).toBe(300);
  });

  describe('política del corte', () => {
    it.each([
      ['un martes (D-19: el corte es el lunes)', '2026-10-20', 'not_a_cutoff_day'],
      ['un lunes futuro', '2099-01-05', 'future_cutoff'],
      ['una fecha que no existe', '2026-02-30', undefined],
      ['una fecha mal escrita', '19/10/2026', undefined],
    ])('rechaza %s', async (_name, date, code) => {
      const res = checked(ctx, 'POST', '/batches', await runBatch(BATCH_BODY(date)));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      if (code) expect(res.body.errors).toEqual([{ field: 'cutoff_date', code }]);
      expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_batches')).rows[0].n).toBe(0);
    });

    it('rechaza campos que el contrato no declara y un desfase fuera de rango', async () => {
      expect((await runBatch({ cutoff_date: CUT_1, merchant_id: 'mc_x' })).status).toBe(422);
      expect((await runBatch({ cutoff_date: CUT_1, release_days: 61 })).status).toBe(422);
      expect((await runBatch({ cutoff_date: CUT_1, release_days: -1 })).status).toBe(422);
    });

    it('el mismo lunes con otro desfase no es el mismo lote: se rechaza en vez de reinterpretarlo', async () => {
      await runBatch(BATCH_BODY(CUT_1));
      const res = await runBatch(BATCH_BODY(CUT_1, { release_days: 3 }));
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([{ field: 'release_days', code: 'differs_from_existing_batch' }]);
    });

    it('con SETTLEMENT_CUTOFF_WEEKDAY=any acepta cualquier día', async () => {
      await ctx.close();
      ctx = await createSettlementContext({ config: { cutoffWeekday: null } });
      expect((await runBatch(BATCH_BODY('2026-10-20'))).status).toBe(201);
    });

    it('el desfase por defecto sale de la configuración (T+N) y release_days lo pisa', async () => {
      await ctx.close();
      ctx = await createSettlementContext({ config: { releaseDays: 14 } });
      const res = await runBatch(BATCH_BODY(CUT_1));
      expect(res.body.release_before).toBe('2026-10-05T04:00:00.000Z');
      const res2 = await runBatch(BATCH_BODY(CUT_2, { release_days: 0 }));
      expect(res2.body.release_before).toBe('2026-10-26T04:00:00.000Z');
    });
  });

  describe('fallos a mitad del corte', () => {
    it('el ledger rechaza la liberación de un comercio: el lote queda `failed`, los demás se pagan y repetir el corte reintenta solo a ese con attempt + 1', async () => {
      const [ok, bad] = [merchantId(), merchantId()];
      await registerMerchant(ctx, ok);
      await registerMerchant(ctx, bad);
      ctx.ledger.seedCharge({ merchant: ok, net: 500, fee: 0, at: BEFORE_CUT_1, ref: ref() });
      ctx.ledger.seedCharge({ merchant: bad, net: 900, fee: 0, at: BEFORE_CUT_1, ref: ref() });
      ctx.ledger.rejectNextTransaction(); // el primero que se procese (orden por id de comercio) es rechazado
      const first = await runBatch(BATCH_BODY(CUT_1));
      expect(first.body.status).toBe('failed');
      expect(first.body.completed_at).toBeNull();
      expect(await ctx.events('settlement.batch.closed')).toHaveLength(0); // no se cierra un lote con fallas
      const failedItem = (await ctx.db.pool.query("SELECT merchant_id, ledger_attempt, failure_code FROM settlement_batch_items WHERE status = 'failed'")).rows;
      expect(failedItem).toEqual([{ merchant_id: [ok, bad].sort()[0], ledger_attempt: 1, failure_code: 'insufficient_funds' }]);

      const second = await runBatch(BATCH_BODY(CUT_1), key());
      expect(second.body.status).toBe('completed');
      expect(second.body.id).toBe(first.body.id);
      const attempt = (await ctx.db.pool.query('SELECT merchant_id, ledger_attempt FROM settlement_batch_items WHERE ledger_attempt > 1')).rows;
      expect(attempt).toEqual([{ merchant_id: [ok, bad].sort()[0], ledger_attempt: 2 }]);
      expect(pending(ok)).toBe(0);
      expect(pending(bad)).toBe(0);
      expect(ctx.connectors.executedCount).toBe(2);
      expect(await ctx.events('settlement.batch.closed')).toHaveLength(1);
    });

    it('el ledger se cae a mitad: 503 sin guardar la respuesta; reintentar con la misma clave retoma y no libera dos veces', async () => {
      const m = merchantId();
      await registerMerchant(ctx, m);
      ctx.ledger.seedCharge({ merchant: m, net: 8000, fee: 0, at: BEFORE_CUT_1, ref: ref() });
      // la liberación SE APLICA en el ledger pero la respuesta se pierde (el peor caso)
      ctx.ledger.failNext('createTransaction', undefined, 1, true);
      const idem = key();
      const lost = checked(ctx, 'POST', '/batches', await runBatch(BATCH_BODY(CUT_1), idem));
      expect(lost.status).toBe(503);
      expect(lost.body.code).toBe('ledger_unavailable');
      expect(available(m)).toBe(8000); // el dinero ya se movió
      const retry = await runBatch(BATCH_BODY(CUT_1), idem);
      expect(retry.status).toBe(200); // el lote ya existía (la primera respuesta se perdió): el contrato lo llama 200
      expect(retry.body.status).toBe('completed');
      expect(pending(m)).toBe(0);
      expect(available(m)).toBe(0);
      expect(ctx.ledger.balanceOf('payout:clearing')).toBe(8000); // salió una sola vez
      expect(ctx.connectors.executedCount).toBe(1);
    });

    it('el ledger no responde al planear: el corte no escribe nada de ese comercio y se retoma limpio', async () => {
      const m = merchantId();
      await registerMerchant(ctx, m);
      ctx.ledger.seedCharge({ merchant: m, net: 800, fee: 0, at: BEFORE_CUT_1, ref: ref() });
      ctx.ledger.failNext('listStatement');
      const idem = key();
      expect((await runBatch(BATCH_BODY(CUT_1), idem)).status).toBe(503);
      expect(pending(m)).toBe(800);
      expect((await runBatch(BATCH_BODY(CUT_1), idem)).body.status).toBe('completed');
      expect(pending(m)).toBe(0);
    });

    it('resumeRunning retoma un lote que quedó a medias (el proceso murió)', async () => {
      const m = merchantId();
      await registerMerchant(ctx, m);
      ctx.ledger.seedCharge({ merchant: m, net: 800, fee: 0, at: BEFORE_CUT_1, ref: ref() });
      ctx.ledger.failNext('createTransaction', undefined, 1, true);
      await runBatch(BATCH_BODY(CUT_1));
      expect((await ctx.db.pool.query("SELECT status FROM settlement_batches")).rows[0].status).toBe('running');
      expect(await ctx.batches.resumeRunning()).toBe(1);
      expect((await ctx.db.pool.query("SELECT status FROM settlement_batches")).rows[0].status).toBe('completed');
    });
  });

  it('autorización: solo la consola de operación corre y lista cortes; sin identidad, 403', async () => {
    expect((await ctx.as('pay-schedules').post('/batches', BATCH_BODY(CUT_1)).set('idempotency-key', key())).status).toBe(403);
    expect((await ctx.as('pay-edge').get('/batches')).status).toBe(403);
    expect((await ctx.as('pay-payments').post('/batches', BATCH_BODY(CUT_1)).set('idempotency-key', key())).status).toBe(403);
    expect((await ctx.as('pay-console').post('/batches', BATCH_BODY(CUT_1))).status).toBe(400); // sin Idempotency-Key
    const anonymous = await ctx.as('pay-console').post('/batches', BATCH_BODY(CUT_1)).set('x-service-id', 'no-es-un-servicio').set('idempotency-key', key());
    expect(anonymous.status).toBe(403);
    expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_batches')).rows[0].n).toBe(0);
  });

  it('lista los lotes del más nuevo al más viejo, con paginación estable', async () => {
    // creados en este orden: el más nuevo es el último
    for (const date of [CUT_1, CUT_2, '2026-10-12']) await runBatch(BATCH_BODY(date));
    const page1 = checked(ctx, 'GET', '/batches', await ctx.as('pay-console').get('/batches?limit=2'));
    expect(page1.body.data.map((b: { cutoff_date: string }) => b.cutoff_date)).toEqual(['2026-10-12', CUT_2]);
    expect(page1.body.has_more).toBe(true);
    const page2 = checked(ctx, 'GET', '/batches', await ctx.as('pay-console').get(`/batches?limit=2&starting_after=${page1.body.next_cursor}`));
    expect(page2.body.data.map((b: { cutoff_date: string }) => b.cutoff_date)).toEqual([CUT_1]);
    expect(page2.body.has_more).toBe(false);
    expect((await ctx.as('pay-console').get('/batches?starting_after=%%%')).status).toBe(422);
  });
});

// Para que el import de LedgerRejectedError no sobre si una prueba futura lo necesita.
void LedgerRejectedError;
