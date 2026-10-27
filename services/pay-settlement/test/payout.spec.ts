import { LedgerUnavailableError } from '../src/settlement/errors';
import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { loadEventValidators } from './helpers/events-contract';
import { ref } from './helpers/scenarios';

let ctx: SettlementTestContext;
let validators: Awaited<ReturnType<typeof loadEventValidators>>;
beforeAll(async () => {
  validators = await loadEventValidators('ledger-settlement.yaml');
});
afterEach(async () => ctx.close());

/** Un comercio con `amount` disponible (cobro ya liberado). */
async function funded(amount: number, config: Parameters<typeof createSettlementContext>[0] = {}) {
  ctx = await createSettlementContext(config);
  const m = merchantId();
  ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release' });
  return m;
}
const body = (m: string, amount: number, extra: object = {}) => ({ merchant_id: m, amount_minor: amount, currency: 'BOB', rail: 'bank_transfer', reason: 'manual', ...extra });
const create = (payload: object, idem = key(), caller = 'pay-schedules') => ctx.as(caller).post('/payouts', payload).set('idempotency-key', idem);
const available = (m: string) => ctx.ledger.balanceOf(`merchant:${m}:available`);
const rows = async () => (await ctx.db.pool.query('SELECT id, status, step, failure_code, hold_id, rail_reference FROM settlement_payouts ORDER BY created_at')).rows;

describe('payout (P2.H2.M4, REQ-P2-1/2 del lado del pago)', () => {
  it('retiene, ordena el pago por el riel y confirma la retención: el dinero sale una vez', async () => {
    const m = await funded(50_000);
    const res = checked(ctx, 'POST', '/payouts', await create(body(m, 30_000)));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ object: 'payout', merchant_id: m, amount_minor: 30_000, currency: 'BOB', rail: 'bank_transfer', simulated: false, status: 'paid', failure_code: null, batch_id: null });
    expect(res.body.hold_id).toMatch(/^hd_[a-z0-9]{10,40}$/);
    expect(available(m)).toBe(20_000);
    expect(ctx.ledger.balanceOf('payout:clearing')).toBe(30_000);
    expect(ctx.connectors.orders).toHaveLength(1);
    expect(ctx.connectors.orders[0].key).toBe(`payout-${res.body.id}`); // la clave del riel es estable por pago
    // un pago suelto (sin lote) emite paid; payout.created exige lote en el contrato y no se emite (PROPUESTAS.md)
    const paid = await ctx.events('payout.paid');
    expect(paid).toHaveLength(1);
    expect(validators.get('payout.paid')?.(paid[0])).toEqual([]);
    expect(await ctx.events('payout.created')).toHaveLength(0);
    expect((await ctx.as('pay-schedules').get(`/payouts/${res.body.id}`)).body.status).toBe('paid');
  });

  it('un monto mayor al disponible da 422 insufficient_funds sin mover dinero ni llamar al riel (REQ-P2-2)', async () => {
    const m = await funded(5_000);
    const res = checked(ctx, 'POST', '/payouts', await create(body(m, 5_001)));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('insufficient_funds');
    expect(available(m)).toBe(5_000);
    expect(ctx.ledger.balanceOf('payout:clearing')).toBe(0);
    expect(ctx.connectors.orders).toHaveLength(0);
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', step: 'resolved', failure_code: 'insufficient_funds', hold_id: null })]);
    const failed = await ctx.events('payout.failed');
    expect(failed).toHaveLength(1);
    expect(validators.get('payout.failed')?.(failed[0])).toEqual([]);
    expect((failed[0].data as { failure_code: string }).failure_code).toBe('insufficient_funds');
  });

  it('límite: justo lo disponible se paga; 1 centavo más no; y de a 1 centavo también', async () => {
    const m = await funded(1_000);
    expect((await create(body(m, 1_000))).body.status).toBe('paid');
    expect(available(m)).toBe(0);
    expect((await create(body(m, 1))).status).toBe(422);
    const tiny = merchantId();
    ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${tiny}:available`, amount: 1, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release' });
    expect((await create(body(tiny, 1))).body.status).toBe('paid');
  });

  it.each([
    ['monto 0', (m: string) => body(m, 0)],
    ['monto negativo', (m: string) => body(m, -5)],
    ['monto con decimales', (m: string) => body(m, 10.5)],
    ['monto como texto', (m: string) => body(m, '100' as unknown as number)],
    ['moneda distinta', (m: string) => body(m, 100, { currency: 'USD' })],
    ['campo no declarado', (m: string) => body(m, 100, { resolved_by: 'yo' })],
    ['comercio mal formado', () => body('mc_x', 100)],
    ['riel desconocido', (m: string) => body(m, 100, { rail: 'cheque' })],
    ['motivo reservado al corte', (m: string) => body(m, 100, { reason: 'weekly_cut' })],
    ['lote puesto a mano', (m: string) => body(m, 100, { batch_id: 'sb_abcdefghij12' })],
    ['riel que no está habilitado por settlement.mode', (m: string) => body(m, 100, { rail: 'acquirer_settlement' })],
  ])('rechaza %s con 422 y sin efecto', async (_name, make) => {
    const m = await funded(10_000);
    const res = checked(ctx, 'POST', '/payouts', await create(make(m)));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(await rows()).toEqual([]);
    expect(available(m)).toBe(10_000);
    expect(ctx.connectors.orders).toHaveLength(0);
  });

  describe('el riel falla', () => {
    it('sin efecto garantizado (502 connector_unavailable): se anula la retención y el saldo queda intacto', async () => {
      const m = await funded(9_000);
      ctx.connectors.scenario = 'unavailable';
      const res = checked(ctx, 'POST', '/payouts', await create(body(m, 9_000)));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });
      expect(available(m)).toBe(9_000);
      expect(ctx.ledger.count('voidHold')).toBe(1);
      expect(ctx.ledger.count('postHold')).toBe(0);
      const failed = await ctx.events('payout.failed');
      expect(validators.get('payout.failed')?.(failed[0])).toEqual([]);
      expect((failed[0].data as { failure_code: string }).failure_code).toBe('connector_unavailable');
    });

    it('rechazo definitivo del riel: se anula la retención; el código propio se guarda y el evento usa el del contrato', async () => {
      const m = await funded(9_000);
      ctx.connectors.scenario = 'rejected';
      const res = await create(body(m, 9_000));
      expect(res.body).toMatchObject({ status: 'failed', failure_code: 'rail_rejected' });
      expect(available(m)).toBe(9_000);
      const failed = await ctx.events('payout.failed');
      expect(validators.get('payout.failed')?.(failed[0])).toEqual([]);
      expect((failed[0].data as { failure_code: string }).failure_code).toBe('internal_error');
    });

    it('AMBIGUO (el banco pagó pero se perdió la respuesta): NO se anula; queda en tránsito con la retención viva y una consulta posterior «pagado» confirma', async () => {
      const m = await funded(9_000);
      ctx.connectors.scenario = 'ambiguous_executed';
      const res = checked(ctx, 'POST', '/payouts', await create(body(m, 9_000)));
      expect(res.body.status).toBe('in_transit');
      expect(ctx.ledger.count('voidHold')).toBe(0); // nunca se anula por ambigüedad
      expect(available(m)).toBe(0); // la retención sigue reservando el dinero
      expect(ctx.connectors.executedCount).toBe(1);

      const outcome = await ctx.payouts.recover();
      expect(outcome).toEqual({ advanced: 1, failed: 0 });
      const after = await ctx.as('pay-schedules').get(`/payouts/${res.body.id}`);
      expect(after.body.status).toBe('paid');
      expect(ctx.ledger.count('postHold')).toBe(1);
      expect(ctx.ledger.count('voidHold')).toBe(0);
      expect(ctx.ledger.balanceOf('payout:clearing')).toBe(9_000);
      expect(ctx.connectors.executedCount).toBe(1); // no se pagó dos veces
    });

    it('AMBIGUO (la orden nunca llegó): la consulta dice «no existe» y recién entonces se anula la retención', async () => {
      const m = await funded(9_000);
      ctx.connectors.scenario = 'ambiguous_lost';
      const res = await create(body(m, 9_000));
      expect(res.body.status).toBe('in_transit');
      expect(ctx.ledger.count('voidHold')).toBe(0);
      await ctx.payouts.recover();
      const after = await ctx.as('pay-schedules').get(`/payouts/${res.body.id}`);
      expect(after.body).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });
      expect(ctx.ledger.count('voidHold')).toBe(1);
      expect(available(m)).toBe(9_000);
      expect(ctx.connectors.executedCount).toBe(0);
    });

    it('en tránsito (el banco confirma tarde): la retención sigue viva hasta que el riel diga pagado', async () => {
      const m = await funded(4_000);
      ctx.connectors.scenario = 'in_transit';
      const res = await create(body(m, 4_000));
      expect(res.body.status).toBe('in_transit');
      expect(await ctx.payouts.recover()).toEqual({ advanced: 0, failed: 0 }); // todavía no
      expect(ctx.ledger.count('postHold')).toBe(0);
      ctx.connectors.settle(res.body.id);
      await ctx.payouts.recover();
      expect((await ctx.as('pay-schedules').get(`/payouts/${res.body.id}`)).body.status).toBe('paid');
      expect(ctx.ledger.balanceOf('payout:clearing')).toBe(4_000);
      expect(await ctx.events('payout.paid')).toHaveLength(1);
    });

    it('la retención venció mientras el banco pagaba: NO se declara pagado ni fallido (lo resuelve una persona) y no se anula nada', async () => {
      const m = await funded(4_000);
      ctx.connectors.scenario = 'in_transit';
      const res = await create(body(m, 4_000));
      ctx.ledger.now = () => new Date(Date.now() + 8 * 86_400_000); // pasó el TTL de 7 días
      ctx.connectors.settle(res.body.id);
      expect(await ctx.payouts.recover()).toEqual({ advanced: 0, failed: 1 });
      const [row] = await rows();
      expect(row).toMatchObject({ status: 'in_transit', step: 'sent' });
      expect(ctx.ledger.count('voidHold')).toBe(0);
      expect(await ctx.events('payout.failed')).toHaveLength(0);
      expect(await ctx.events('payout.paid')).toHaveLength(0);
    });
  });

  describe('el ledger falla', () => {
    it('no responde al retener: 503 sin guardar la respuesta; el mismo pedido retoma y paga una sola vez', async () => {
      const m = await funded(7_000);
      ctx.ledger.failNext('createHold');
      const idem = key();
      const lost = checked(ctx, 'POST', '/payouts', await create(body(m, 7_000), idem));
      expect(lost.status).toBe(503);
      expect(ctx.connectors.orders).toHaveLength(0);
      const retry = await create(body(m, 7_000), idem);
      expect(retry.status).toBe(201);
      expect(retry.body.status).toBe('paid');
      expect(await rows()).toHaveLength(1);
      expect(ctx.connectors.executedCount).toBe(1);
    });

    it('la retención SE CREÓ pero la respuesta se perdió: el reintento reutiliza la misma retención', async () => {
      const m = await funded(7_000);
      ctx.ledger.failNext('createHold', new LedgerUnavailableError(), 1, true);
      const idem = key();
      expect((await create(body(m, 7_000), idem)).status).toBe(503);
      expect(available(m)).toBe(0); // ya está retenido
      const retry = await create(body(m, 7_000), idem);
      expect(retry.body.status).toBe('paid');
      expect(ctx.ledger.balanceOf('payout:clearing')).toBe(7_000); // una sola vez
    });

    it('el riel pagó pero el ledger no confirma la retención: 503; el reintento solo confirma, sin pagar otra vez', async () => {
      const m = await funded(7_000);
      ctx.ledger.failNext('postHold');
      const idem = key();
      expect((await create(body(m, 7_000), idem)).status).toBe(503);
      expect(ctx.connectors.executedCount).toBe(1);
      const retry = await create(body(m, 7_000), idem);
      expect(retry.body.status).toBe('paid');
      expect(ctx.connectors.executedCount).toBe(1);
      expect(ctx.connectors.orders).toHaveLength(1);
      expect(ctx.ledger.balanceOf('payout:clearing')).toBe(7_000);
    });

    it('el barrido retoma un pago que quedó en `created` sin que nadie reintente', async () => {
      const m = await funded(7_000);
      ctx.ledger.failNext('createHold');
      expect((await create(body(m, 7_000))).status).toBe(503);
      expect(await ctx.payouts.recover()).toEqual({ advanced: 1, failed: 0 });
      expect((await rows())[0]).toMatchObject({ status: 'paid', step: 'resolved' });
    });
  });

  describe('idempotencia', () => {
    it('la misma clave repite la respuesta guardada sin pagar de nuevo', async () => {
      const m = await funded(10_000);
      const idem = key();
      const first = await create(body(m, 4_000), idem);
      const again = await create(body(m, 4_000), idem);
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      expect(available(m)).toBe(6_000);
      expect(ctx.connectors.orders).toHaveLength(1);
    });

    it('la misma clave con otro pedido es 422 idempotency_key_reused; sin clave, 400', async () => {
      const m = await funded(10_000);
      const idem = key();
      await create(body(m, 4_000), idem);
      expect((await create(body(m, 4_001), idem)).body.code).toBe('idempotency_key_reused');
      expect((await ctx.as('pay-schedules').post('/payouts', body(m, 1))).status).toBe(400);
      expect(await rows()).toHaveLength(1);
    });

    it('el rechazo por saldo también se repite tal cual con la misma clave', async () => {
      const m = await funded(100);
      const idem = key();
      const first = await create(body(m, 500), idem);
      ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount: 10_000, at: new Date(), ref: ref(), code: 'release' });
      const again = await create(body(m, 500), idem);
      expect(first.status).toBe(422);
      expect(again.status).toBe(422);
      expect(again.headers['idempotency-replayed']).toBe('true');
    });

    it('diez pedidos simultáneos con la misma clave: un solo pago', async () => {
      const m = await funded(10_000);
      const idem = key();
      const results = await Promise.all(Array.from({ length: 10 }, () => create(body(m, 3_000), idem)));
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(results.some((r) => r.status === 201)).toBe(true);
      expect(await rows()).toHaveLength(1);
      expect(ctx.connectors.orders).toHaveLength(1);
      expect(available(m)).toBe(7_000);
    });

    it('veinte pagos simultáneos que juntos superan el disponible: el saldo nunca queda en negativo ni se paga de más', async () => {
      const m = await funded(10_000);
      const results = await Promise.all(Array.from({ length: 20 }, () => create(body(m, 1_500))));
      const paid = results.filter((r) => r.status === 201 && r.body.status === 'paid').length;
      const refused = results.filter((r) => r.status === 422).length;
      expect(paid).toBe(6); // 6 × 1.500 = 9.000 ≤ 10.000 < 7 × 1.500
      expect(paid + refused).toBe(20);
      expect(available(m)).toBe(1_000);
      expect(ctx.ledger.balanceOf('payout:clearing')).toBe(9_000);
      expect(ctx.connectors.executedCount).toBe(6);
    });
  });

  describe('modo B (settlement.mode=acquirer, REQ-P2-7, P2.H2.M8)', () => {
    it('usa el riel acquirer_settlement, que es un doble: el pago sale `simulated: true` y no se le pide nada al conector', async () => {
      const m = await funded(8_000, { config: { mode: 'acquirer' } });
      const res = checked(ctx, 'POST', '/payouts', await create(body(m, 8_000, { rail: 'acquirer_settlement' })));
      expect(res.body).toMatchObject({ rail: 'acquirer_settlement', simulated: true, status: 'paid' });
      expect(ctx.connectors.orders).toHaveLength(0);
      expect((await create(body(m, 1, { rail: 'bank_transfer' }))).body.errors).toEqual([{ field: 'rail', code: 'rail_not_enabled' }]);
    });

    it('en modo A el riel real no es simulado', async () => {
      const m = await funded(100);
      expect((await create(body(m, 100))).body).toMatchObject({ rail: 'bank_transfer', simulated: false });
    });
  });

  describe('lectura y autorización', () => {
    it('solo pay-schedules y la consola pagan; el resto, incluido pay-payments y pay-edge, recibe 403', async () => {
      const m = await funded(1_000);
      for (const caller of ['pay-edge', 'pay-payments', 'pay-risk', 'pay-ledger']) expect((await create(body(m, 100), key(), caller)).status).toBe(403);
      expect((await create(body(m, 100), key(), 'pay-console')).status).toBe(201);
      expect(await rows()).toHaveLength(1);
    });

    it('GET /payouts/{id}: 404 si no existe, 404 si el id no tiene forma de payout, y la consulta es solo de lectura', async () => {
      await funded(1);
      expect(checked(ctx, 'GET', '/payouts/po_abcdefghijklmn', await ctx.as('pay-schedules').get('/payouts/po_abcdefghijklmn')).status).toBe(404);
      expect((await ctx.as('pay-schedules').get('/payouts/xyz')).status).toBe(404);
      expect((await ctx.as('pay-edge').get('/payouts/po_abcdefghijklmn')).status).toBe(403);
    });

    it('lista paginada, del más nuevo al más viejo, con filtros por comercio y estado', async () => {
      const m = await funded(10_000);
      for (let i = 0; i < 5; i += 1) await create(body(m, 100 + i));
      ctx.connectors.scenario = 'in_transit';
      await create(body(m, 999));
      const page1 = checked(ctx, 'GET', '/payouts', await ctx.as('pay-console').get('/payouts?limit=4'));
      expect(page1.body.data).toHaveLength(4);
      expect(page1.body.data[0].amount_minor).toBe(999);
      const page2 = checked(ctx, 'GET', '/payouts', await ctx.as('pay-console').get(`/payouts?limit=4&starting_after=${page1.body.next_cursor}`));
      expect(page2.body.data).toHaveLength(2);
      expect(page2.body.has_more).toBe(false);
      const ids = [...page1.body.data, ...page2.body.data].map((p: { id: string }) => p.id);
      expect(new Set(ids).size).toBe(6); // sin repetidos ni huecos entre páginas
      expect((await ctx.as('pay-console').get(`/payouts?status=in_transit&merchant_id=${m}`)).body.data).toHaveLength(1);
      expect((await ctx.as('pay-console').get(`/payouts?merchant_id=${merchantId()}`)).body.data).toEqual([]);
      expect((await ctx.as('pay-console').get('/payouts?status=raro')).status).toBe(422);
      expect((await ctx.as('pay-console').get('/payouts?limit=0')).status).toBe(422);
      expect((await ctx.as('pay-console').get('/payouts?limit=101')).status).toBe(422);
    });
  });
});
