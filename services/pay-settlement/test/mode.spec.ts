import { type SettlementTestContext, checked, createSettlementContext, key, merchantId, operatorToken } from './helpers/app';
import { loadEventValidators } from './helpers/events-contract';
import { BATCH_BODY, feeSchedule, ref, registerMerchant } from './helpers/scenarios';

/**
 * Modo de la operación (D-28): `X-Pay-Mode: test|live` lo fija `pay-edge`. pay-settlement lo exige en TODA su API interna, lo guarda en cada
 * pago, corte, cobro, corrida y excepción, lo filtra en cada consulta y lo propaga al ledger y a los conectores. Tres niveles: correcto, límite
 * e inválido, con la negativa test↔live en los dos sentidos. El ledger y los conectores son DOBLES declarados (el ledger real, en `ledger-real.spec`).
 */
type Mode = 'test' | 'live';
const MODES: Mode[] = ['test', 'live'];
const other = (mode: Mode): Mode => (mode === 'test' ? 'live' : 'test');
const CUT = '2026-10-19';
const BEFORE_CUT = new Date('2026-10-05T15:00:00Z');

let ctx: SettlementTestContext;
let validators: Awaited<ReturnType<typeof loadEventValidators>>;
beforeAll(async () => {
  validators = await loadEventValidators('ledger-settlement.yaml');
});
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

const body = (m: string, amount: number, extra: object = {}) => ({ merchant_id: m, amount_minor: amount, currency: 'BOB', rail: 'bank_transfer', reason: 'manual', ...extra });
const pay = (mode: string | null, payload: object, idem = key(), caller = 'pay-schedules') => ctx.as(caller, mode).post('/payouts', payload).set('idempotency-key', idem);
const batch = (mode: string | null, cutoff = CUT, idem = key()) => ctx.as('pay-backoffice', mode).post('/batches', BATCH_BODY(cutoff)).set('idempotency-key', idem);
/** `amount` disponibles al comercio en ESE modo (cobro ya liberado). */
const fund = (mode: Mode, m: string, amount: number) => ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release', mode });
const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);

describe('correcto: cada modo opera con lo suyo y todo lo propaga', () => {
  it.each(MODES)('un pago en %s se retiene, se paga y se publica con ese modo; el ledger y el conector reciben el mismo modo', async (mode) => {
    const m = merchantId();
    fund(mode, m, 50_000);
    const res = checked(ctx, 'POST', '/payouts', await pay(mode, body(m, 30_000)));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'paid', amount_minor: 30_000 });
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`, mode)).toBe(20_000);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`, other(mode))).toBe(0);
    // Toda llamada al ledger llevó el modo del pago, y la orden al conector también.
    expect(ctx.ledger.calls.length).toBeGreaterThan(0);
    expect(new Set(ctx.ledger.calls.map((c) => c.mode))).toEqual(new Set([mode]));
    expect(ctx.connectors.orders.map((o) => o.order.mode)).toEqual([mode]);
    expect((await ctx.db.pool.query('SELECT mode FROM settlement_payouts WHERE id = $1', [res.body.id])).rows).toEqual([{ mode }]);
    for (const type of ['payout.created', 'payout.paid']) {
      const events = await ctx.events(type);
      expect(events).toHaveLength(1);
      expect(validators.get(type)?.(events[0])).toEqual([]);
      expect(events[0].data).toMatchObject({ mode, payout_id: res.body.id });
    }
    expect((await ctx.as('pay-schedules', mode).get(`/payouts/${res.body.id}`)).status).toBe(200);
  });

  it('la misma Idempotency-Key en los dos modos son DOS pagos distintos, cada uno en su ledger, sin repetir la respuesta del otro', async () => {
    const m = merchantId();
    for (const mode of MODES) fund(mode, m, 10_000);
    const idem = key();
    const [t, l] = [await pay('test', body(m, 4_000), idem), await pay('live', body(m, 4_000), idem)];
    expect([t.status, l.status]).toEqual([201, 201]);
    expect(l.header['idempotency-replayed']).toBeUndefined();
    expect(t.body.id).not.toBe(l.body.id);
    // y repetir en el MISMO modo sí repite
    const again = await pay('test', body(m, 4_000), idem);
    expect(again.body.id).toBe(t.body.id);
    expect(again.header['idempotency-replayed']).toBe('true');
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`, 'test')).toBe(6_000);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`, 'live')).toBe(6_000);
    expect(ctx.connectors.executedCount).toBe(2);
  });

  it('el pago suelto emite payout.created sin lote y válido; el del corte lo trae', async () => {
    const m = merchantId();
    fund('live', m, 1_000);
    await pay('live', body(m, 1_000));
    const [created] = await ctx.events('payout.created');
    expect(validators.get('payout.created')?.(created)).toEqual([]);
    expect(created.data).not.toHaveProperty('settlement_batch_id');
    expect(created.data).toMatchObject({ mode: 'live' });
  });
});

describe('límite: lo de un modo NO se ve, NO se gasta y NO se paga desde el otro (test↔live, en los dos sentidos)', () => {
  it.each(MODES)('el dinero de %s no se puede pagar en el modo contrario: 422 por saldo, sin retención ni orden al conector', async (mode) => {
    const m = merchantId();
    fund(mode, m, 50_000);
    const res = checked(ctx, 'POST', '/payouts', await pay(other(mode), body(m, 100)));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('insufficient_funds');
    expect(ctx.connectors.orders).toHaveLength(0);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`, mode)).toBe(50_000);
    expect(ctx.ledger.balanceOf('payout:clearing', mode)).toBe(0);
  });

  it.each(MODES)('un pago de %s no se lista ni se consulta con el modo contrario (404, sin revelar nada)', async (mode) => {
    const m = merchantId();
    fund(mode, m, 5_000);
    const created = await pay(mode, body(m, 1_000));
    expect(checked(ctx, 'GET', '/payouts', await ctx.as('pay-backoffice', mode).get('/payouts')).body.data.map((p: { id: string }) => p.id)).toContain(created.body.id);
    expect(checked(ctx, 'GET', '/payouts', await ctx.as('pay-backoffice', other(mode)).get('/payouts')).body.data).toEqual([]);
    expect((await ctx.as('pay-backoffice', other(mode)).get(`/payouts/${created.body.id}`)).status).toBe(404);
    // la vista pública (pay-edge) también filtra por el modo de la clave
    expect((await ctx.as('pay-edge', other(mode)).get('/payouts').set('x-merchant-id', m)).body.data).toEqual([]);
    expect((await ctx.as('pay-edge', mode).get('/payouts').set('x-merchant-id', m)).body.data).toHaveLength(1);
  });

  it('concurrencia: 10 pagos simultáneos por modo sobre el mismo comercio suman por separado y ninguno cruza', async () => {
    const m = merchantId();
    for (const mode of MODES) fund(mode, m, 100_000);
    const calls = MODES.flatMap((mode) => Array.from({ length: 10 }, () => pay(mode, body(m, 1_000))));
    const results = await Promise.all(calls);
    expect(results.map((r) => r.status)).toEqual(results.map(() => 201));
    for (const mode of MODES) {
      expect(ctx.ledger.balanceOf(`merchant:${m}:available`, mode)).toBe(90_000);
      expect(await count('SELECT count(*) AS n FROM settlement_payouts WHERE mode = $1 AND merchant_id = $2', [mode, m])).toBe(10);
    }
  });

  it('el corte del MISMO lunes en los dos modos son dos lotes; cada uno libera solo lo cobrado en su modo y repetir uno no toca el otro', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 9_700, fee: 300, at: BEFORE_CUT, ref: ref(), mode: 'test' });
    ctx.ledger.seedCharge({ merchant: m, net: 2_000, fee: 0, at: BEFORE_CUT, ref: ref(), mode: 'live' });
    const t = checked(ctx, 'POST', '/batches', await batch('test'));
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: 'completed', released_minor: 9_700, payouts_count: 1 });
    // el lunes de test ya está cortado, pero el de live NO: es otro lote
    const l = checked(ctx, 'POST', '/batches', await batch('live'));
    expect(l.status).toBe(201);
    expect(l.body.id).not.toBe(t.body.id);
    expect(l.body).toMatchObject({ status: 'completed', released_minor: 2_000, payouts_count: 1 });
    // repetir cada uno devuelve su propio lote y no paga de nuevo
    const t2 = await batch('test');
    expect([t2.status, t2.body.id]).toEqual([200, t.body.id]);
    const l2 = await batch('live');
    expect([l2.status, l2.body.id]).toEqual([200, l.body.id]);
    expect(ctx.connectors.executedCount).toBe(2);
    // listados y marcas por modo
    for (const [mode, batchId] of [['test', t.body.id], ['live', l.body.id]] as const) {
      expect(checked(ctx, 'GET', '/batches', await ctx.as('pay-backoffice', mode).get('/batches')).body.data.map((b: { id: string }) => b.id)).toEqual([batchId]);
    }
    expect(await count("SELECT count(*) AS n FROM settlement_merchant_marks WHERE merchant_id = $1", [m])).toBe(2);
    expect(ctx.ledger.balanceOf(`merchant:${m}:pending`, 'test')).toBe(0);
    expect(ctx.ledger.balanceOf(`merchant:${m}:pending`, 'live')).toBe(0);
    expect(ctx.ledger.balanceOf('payout:clearing', 'test')).toBe(9_700);
    expect(ctx.ledger.balanceOf('payout:clearing', 'live')).toBe(2_000);
  });

  it('un cobro con la misma referencia en los dos modos son dos cobros; cada uno se cobra solo de su saldo, y el abono mensual sale una vez POR modo', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    await ctx.consumers.handle(feeSchedule(m, 1, 1_000));
    fund('test', m, 5_000); // en live el comercio no tiene saldo
    const chargeBody = { merchant_id: m, kind: 'provider_commission', reference: 'sp_abcdefghijklmn:2026-10', amount_minor: 800, currency: 'BOB' };
    const t = checked(ctx, 'POST', '/charges', await ctx.as('pay-schedules', 'test').post('/charges', chargeBody).set('idempotency-key', key()));
    const l = checked(ctx, 'POST', '/charges', await ctx.as('pay-schedules', 'live').post('/charges', chargeBody).set('idempotency-key', key()));
    expect(t.body).toMatchObject({ status: 'collected', collected_minor: 800 });
    expect(l.body).toMatchObject({ status: 'open', collected_minor: 0, debt_minor: 800 }); // sin saldo en live: queda abierto, no toma el de test
    expect(t.body.id).not.toBe(l.body.id);
    expect(ctx.ledger.balanceOf(`merchant:${m}:available`, 'test')).toBe(4_200);
    expect(ctx.ledger.balanceOf('platform:fees', 'live')).toBe(0);
    // el abono mensual: el corte de cada modo abre el suyo (una vez por mes y por modo)
    await batch('test');
    await batch('test', '2026-10-26');
    await batch('live');
    expect(await count("SELECT count(*) AS n FROM settlement_charges WHERE merchant_id = $1 AND kind = 'monthly_fee'", [m])).toBe(2);
    expect(await count("SELECT count(*) AS n FROM settlement_charges WHERE merchant_id = $1 AND kind = 'monthly_fee' AND mode = 'test'", [m])).toBe(1);
  });

  it('la exportación contable es de UN modo: no suma comisiones ni líneas del otro', async () => {
    const m = merchantId();
    await registerMerchant(ctx, m);
    ctx.ledger.seedCharge({ merchant: m, net: 9_700, fee: 300, at: BEFORE_CUT, ref: ref(), mode: 'test' });
    ctx.ledger.seedCharge({ merchant: m, net: 970, fee: 30, at: BEFORE_CUT, ref: ref(), mode: 'live' });
    const to = new Date(Date.now() - 5).toISOString();
    const exportOf = async (mode: Mode) => ctx.as('pay-backoffice', mode).get(`/exports/accounting?period_from=2026-10-01T00:00:00.000Z&period_to=${to}`);
    const [t, l] = [checked(ctx, 'GET', '/exports/accounting', await exportOf('test')), checked(ctx, 'GET', '/exports/accounting', await exportOf('live'))];
    expect(t.body.totals).toMatchObject({ fee_minor: 300, net_minor: 9_700 });
    expect(l.body.totals).toMatchObject({ fee_minor: 30, net_minor: 970 });
    expect([t.body.balanced, l.body.balanced]).toEqual([true, true]);
  });

  describe('conciliación', () => {
    const line = (r: string, amount: number) => ({ provider_reference: `B-${r.slice(0, 12)}`, our_reference: r, direction: 'credit' as const, amount_minor: amount, value_date: '2026-10-21', booked_at: '2026-10-21T14:30:00.000Z' });
    const run = async (mode: Mode) => {
      const started = await ctx.as('pay-backoffice', mode).post('/reconciliation_runs', { connector: 'mock', period_from: '2026-10-19T04:00:00.000Z', period_to: '2026-10-26T04:00:00.000Z' }).set('idempotency-key', key());
      await ctx.reconciliation.idle();
      return started;
    };

    it('la corrida lee el ledger de SU modo; la misma diferencia en los dos modos abre una excepción en cada uno (el dedupe no las funde)', async () => {
      const m = merchantId();
      const r = ref();
      for (const mode of MODES) ctx.ledger.seedCharge({ merchant: m, net: 1_000, fee: 0, at: new Date('2026-10-21T14:30:00Z'), ref: r, mode });
      ctx.connectors.statements.set('mock', { format: 'json', lines: [line(r, 900)] });
      const [t, l] = [await run('test'), await run('live')];
      expect([t.status, l.status]).toEqual([202, 202]);
      expect(t.body.id).not.toBe(l.body.id);
      expect(ctx.ledger.calls.filter((c) => c.op === 'listStatement').map((c) => c.mode).sort()).toEqual(['live', 'test']);
      for (const mode of MODES) {
        const ex = checked(ctx, 'GET', '/reconciliation_exceptions', await ctx.as('pay-backoffice', mode).get('/reconciliation_exceptions?status=open'));
        expect(ex.body.data).toHaveLength(1);
        expect(ex.body.data[0]).toMatchObject({ kind: 'amount_mismatch' });
      }
      expect(await count('SELECT count(*) AS n FROM settlement_exceptions')).toBe(2);
    });

    it('una corrida o una excepción de un modo no se consulta ni se resuelve desde el otro (404) y sigue abierta', async () => {
      const m = merchantId();
      const r = ref();
      ctx.ledger.seedCharge({ merchant: m, net: 1_000, fee: 0, at: new Date('2026-10-21T14:30:00Z'), ref: r, mode: 'test' });
      ctx.connectors.statements.set('mock', { format: 'json', lines: [line(r, 900)] });
      const started = await run('test');
      expect((await ctx.as('pay-backoffice', 'live').get(`/reconciliation_runs/${started.body.id}`)).status).toBe(404);
      const id = (await ctx.as('pay-backoffice', 'test').get('/reconciliation_exceptions?status=open')).body.data[0].id as string;
      const auth = `Bearer ${operatorToken(['settlement_admin'])}`;
      const cross = await ctx.as('pay-backoffice', 'live').post(`/reconciliation_exceptions/${id}/resolve`, { resolution: 'dismiss', note: 'cruzado' }).set('idempotency-key', key()).set('authorization', auth);
      expect(cross.status).toBe(404);
      expect((await ctx.as('pay-backoffice', 'test').get('/reconciliation_exceptions?status=open')).body.data).toHaveLength(1);
      expect((await ctx.as('pay-backoffice', 'live').get('/reconciliation_exceptions?status=open')).body.data).toEqual([]);
      expect(await count('SELECT count(*) AS n FROM settlement_audit')).toBe(0);
    });

    it('un extracto que prueba un pago solo confirma payouts del MISMO modo', async () => {
      const m = merchantId();
      fund('live', m, 5_000);
      ctx.connectors.scenario = 'in_transit';
      const payout = checked(ctx, 'POST', '/payouts', await pay('live', body(m, 2_000)));
      expect(payout.body.status).toBe('in_transit');
      ctx.connectors.statements.set('mock', { format: 'json', lines: [{ ...line(`${payout.body.id}:payout`, 2_000), direction: 'debit' as const }] });
      await run('test'); // el extracto es el del conector mock, pero la corrida es de test: ese pago es de live
      expect((await ctx.as('pay-backoffice', 'live').get(`/payouts/${payout.body.id}`)).body.status).toBe('in_transit');
      expect(ctx.ledger.balanceOf('payout:clearing', 'live')).toBe(0);
      // control positivo: la misma corrida en el modo del pago sí lo confirma
      await run('live');
      expect((await ctx.as('pay-backoffice', 'live').get(`/payouts/${payout.body.id}`)).body.status).toBe('paid');
      expect(ctx.ledger.balanceOf('payout:clearing', 'live')).toBe(2_000);
    });
  });
});

describe('inválido: sin un modo válido NO se atiende, NO se escribe nada y NO se cae en `live`', () => {
  const BAD: [string, string | null][] = [
    ['sin la cabecera', null],
    ['vacío', ''],
    ['en mayúsculas', 'TEST'],
    ['sandbox (modo de despliegue, no de clave)', 'sandbox'],
    ['un valor cualquiera', 'prod'],
    ['dos modos', 'test,live'],
  ];
  const m = merchantId();
  const auth = () => `Bearer ${operatorToken(['settlement_admin'])}`;

  it.each(BAD)('las rutas que mueven dinero %s ⇒ 403 forbidden, nada escrito, ni una llamada al ledger ni al conector', async (_name, mode) => {
    fund('test', m, 9_000);
    const calls = [
      ['POST', '/payouts', await pay(mode, body(m, 100))],
      ['POST', '/batches', await batch(mode)],
      ['POST', '/charges', await ctx.as('pay-schedules', mode).post('/charges', { merchant_id: m, kind: 'monthly_fee', reference: '2026-10', amount_minor: 100, currency: 'BOB' }).set('idempotency-key', key())],
      ['POST', '/reconciliation_runs', await ctx.as('pay-backoffice', mode).post('/reconciliation_runs', { connector: 'mock', period_from: '2026-10-19T04:00:00.000Z', period_to: '2026-10-26T04:00:00.000Z' }).set('idempotency-key', key())],
    ] as const;
    for (const [method, template, res] of calls) {
      checked(ctx, method, template, res);
      expect([method, template, res.status, res.body.code]).toEqual([method, template, 403, 'forbidden']);
    }
    for (const table of ['settlement_payouts', 'settlement_batches', 'settlement_charges', 'settlement_reconciliation_runs']) expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
    expect(ctx.ledger.calls).toEqual([]);
    expect(ctx.connectors.orders).toEqual([]);
    expect(await ctx.events('payout.created')).toEqual([]);
  });

  it.each(BAD)('las lecturas y la resolución %s ⇒ 403 en cada ruta', async (_name, mode) => {
    const reads = [
      ['GET', '/payouts', await ctx.as('pay-backoffice', mode).get('/payouts')],
      ['GET', '/payouts', await ctx.as('pay-edge', mode).get('/payouts').set('x-merchant-id', m)],
      ['GET', '/payouts/{id}', await ctx.as('pay-backoffice', mode).get('/payouts/po_abcdefghijklmn')],
      ['GET', '/batches', await ctx.as('pay-backoffice', mode).get('/batches')],
      ['GET', '/reconciliation_runs/{id}', await ctx.as('pay-backoffice', mode).get('/reconciliation_runs/rr_abcdefghijklmn')],
      ['GET', '/reconciliation_exceptions', await ctx.as('pay-backoffice', mode).get('/reconciliation_exceptions')],
      ['GET', '/exports/accounting', await ctx.as('pay-backoffice', mode).get(`/exports/accounting?period_from=2026-10-01T00:00:00.000Z&period_to=${new Date(Date.now() - 5).toISOString()}`)],
      ['POST', '/reconciliation_exceptions/{id}/resolve', await ctx.as('pay-backoffice', mode).post('/reconciliation_exceptions/rx_abcdefghijklmn/resolve', { resolution: 'dismiss', note: 'x' }).set('idempotency-key', key()).set('authorization', auth())],
    ] as const;
    for (const [method, template, res] of reads) expect([method, template, res.status, res.body.code]).toEqual([method, template, 403, 'forbidden']);
  });

  it.each([
    ['sandbox', 'live'],
    ['live', 'test'],
  ] as const)('una clave %2$s contra un despliegue %1$s ⇒ 403 en TODAS las rutas, sin escribir nada ni llamar al ledger o al conector (test solo opera contra sandbox; live, contra live)', async (deployment, keyMode) => {
    fund('test', m, 9_000);
    fund('live', m, 9_000);
    const as = (service: string) => ctx.as(service, keyMode, deployment);
    const window = `period_from=2026-10-01T00:00:00.000Z&period_to=${new Date(Date.now() - 5).toISOString()}`;
    const calls = [
      ['POST /payouts', as('pay-schedules').post('/payouts', body(m, 100)).set('idempotency-key', key())],
      ['GET /payouts', as('pay-backoffice').get('/payouts')],
      ['GET /payouts (pay-edge)', as('pay-edge').get('/payouts').set('x-merchant-id', m)],
      ['GET /payouts/{id}', as('pay-backoffice').get('/payouts/po_abcdefghijklmn')],
      ['POST /batches', as('pay-backoffice').post('/batches', BATCH_BODY(CUT)).set('idempotency-key', key())],
      ['GET /batches', as('pay-backoffice').get('/batches')],
      ['POST /reconciliation_runs', as('pay-backoffice').post('/reconciliation_runs', { connector: 'mock', period_from: '2026-10-19T04:00:00.000Z', period_to: '2026-10-26T04:00:00.000Z' }).set('idempotency-key', key())],
      ['GET /reconciliation_runs/{id}', as('pay-backoffice').get('/reconciliation_runs/rr_abcdefghijklmn')],
      ['GET /reconciliation_exceptions', as('pay-backoffice').get('/reconciliation_exceptions')],
      ['POST /reconciliation_exceptions/{id}/resolve', as('pay-backoffice').post('/reconciliation_exceptions/rx_abcdefghijklmn/resolve', { resolution: 'dismiss', note: 'x' }).set('idempotency-key', key()).set('authorization', auth())],
      ['POST /charges', as('pay-schedules').post('/charges', { merchant_id: m, kind: 'monthly_fee', reference: '2026-10', amount_minor: 100, currency: 'BOB' }).set('idempotency-key', key())],
      ['GET /exports/accounting', as('pay-backoffice').get(`/exports/accounting?${window}`)],
    ] as const;
    for (const [name, call] of calls) {
      const res = await call;
      expect([name, res.status, res.body.code]).toEqual([name, 403, 'forbidden']);
    }
    for (const table of ['settlement_payouts', 'settlement_batches', 'settlement_charges', 'settlement_reconciliation_runs']) expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
    expect(ctx.ledger.calls).toEqual([]);
    expect(ctx.connectors.orders).toEqual([]);
  });

  it('el modo solo sale de la cabecera: un `mode` en el cuerpo o en la consulta se rechaza como campo desconocido y no cambia de modo', async () => {
    fund('test', m, 9_000);
    const viaBody = await pay('test', body(m, 100, { mode: 'live' }));
    expect([viaBody.status, viaBody.body.code]).toEqual([422, 'validation_failed']);
    const viaQuery = await ctx.as('pay-backoffice', 'test').get('/payouts?mode=live');
    expect(viaQuery.status).toBe(422);
    expect(await count('SELECT count(*) AS n FROM settlement_payouts')).toBe(0);
  });

  it('el almacenamiento también lo impide: ninguna tabla de registro acepta un modo fuera de test|live', async () => {
    const bad = (sql: string) => ctx.db.pool.query(sql).then(() => 'aceptó', (e: { code?: string }) => e.code);
    expect(await bad("INSERT INTO settlement_merchant_marks (mode, merchant_id) VALUES ('prod', 'mc_x')")).toBe('23514');
  });
});
