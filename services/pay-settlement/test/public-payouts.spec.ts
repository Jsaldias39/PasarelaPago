import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { ref } from './helpers/scenarios';

let ctx: SettlementTestContext;
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

const fund = (m: string, amount: number) => ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release' });
const pay = (m: string, amount: number) =>
  ctx.as('pay-schedules').post('/payouts', { merchant_id: m, amount_minor: amount, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key());
const asEdge = (path: string, merchant?: string) => {
  const req = ctx.as('pay-edge').get(path);
  return merchant === undefined ? req : req.set('x-merchant-id', merchant);
};
const PUBLIC_FIELDS = ['amount_minor', 'created_at', 'currency', 'failure_code', 'id', 'object', 'period_from', 'period_to', 'status'];

describe('GET /payouts público (vía pay-edge), contrato public-v1', () => {
  it('el comercio ve SOLO sus liquidaciones, con la forma pública y sin campos internos', async () => {
    const [a, b] = [merchantId(), merchantId()];
    fund(a, 10_000);
    fund(b, 10_000);
    await pay(a, 1_000);
    await pay(a, 2_000);
    const other = await pay(b, 3_000);
    const res = checked(ctx, 'GET', '/payouts', await asEdge('/payouts', a), ctx.publicContract);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { amount_minor: number }) => p.amount_minor)).toEqual([2_000, 1_000]);
    for (const payout of res.body.data) {
      expect(Object.keys(payout).sort()).toEqual(PUBLIC_FIELDS);
      expect(payout.id).not.toBe(other.body.id);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/merchant_id|hold_id|batch_id|rail|simulated|requested_by|business_ref/);
    const mine = checked(ctx, 'GET', '/payouts', await asEdge('/payouts', b), ctx.publicContract);
    expect(mine.body.data.map((p: { id: string }) => p.id)).toEqual([other.body.id]);
  });

  it('IDOR: probar otro comercio por la consulta no filtra nada (merchant_id y status no existen en la API pública)', async () => {
    const [a, b] = [merchantId(), merchantId()];
    fund(b, 5_000);
    await pay(b, 1_000);
    expect((await asEdge(`/payouts?merchant_id=${b}`, a)).status).toBe(422);
    expect((await asEdge('/payouts?status=paid', a)).status).toBe(422);
    expect((await asEdge('/payouts', a)).body.data).toEqual([]);
  });

  it('sin X-Merchant-Id válido, 401: pay-edge no autenticó a nadie', async () => {
    for (const header of [undefined, '', 'mc_x', 'otro', `mc_${'a'.repeat(41)}`, "mc_abc'; DROP TABLE settlement_payouts;--"]) {
      const res = checked(ctx, 'GET', '/payouts', await asEdge('/payouts', header), ctx.publicContract);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('unauthorized');
    }
  });

  it('pagina del más nuevo al más viejo sin repetir ni saltar, y el cursor roto es 422', async () => {
    const m = merchantId();
    fund(m, 100_000);
    for (let i = 1; i <= 5; i += 1) await pay(m, i * 100);
    const page1 = checked(ctx, 'GET', '/payouts', await asEdge('/payouts?limit=2', m), ctx.publicContract);
    const page2 = checked(ctx, 'GET', '/payouts', await asEdge(`/payouts?limit=2&starting_after=${page1.body.next_cursor}`, m), ctx.publicContract);
    const page3 = checked(ctx, 'GET', '/payouts', await asEdge(`/payouts?limit=2&starting_after=${page2.body.next_cursor}`, m), ctx.publicContract);
    expect([...page1.body.data, ...page2.body.data, ...page3.body.data].map((p: { amount_minor: number }) => p.amount_minor)).toEqual([500, 400, 300, 200, 100]);
    expect([page1.body.has_more, page2.body.has_more, page3.body.has_more]).toEqual([true, true, false]);
    expect((await asEdge('/payouts?starting_after=%%%', m)).status).toBe(422);
    expect((await asEdge('/payouts?limit=0', m)).status).toBe(422);
    expect((await asEdge('/payouts?limit=101', m)).status).toBe(422);
  });

  it('un pago fallido muestra su failure_code y uno en tránsito su estado, sin detalles del riel', async () => {
    const m = merchantId();
    fund(m, 5_000);
    ctx.connectors.scenario = 'in_transit';
    await pay(m, 1_000);
    ctx.connectors.scenario = 'paid';
    await pay(m, 999_999); // insufficient_funds
    const statuses = (await asEdge('/payouts', m)).body.data.map((p: { status: string; failure_code: string | null }) => [p.status, p.failure_code]);
    expect(statuses).toEqual([['failed', 'insufficient_funds'], ['in_transit', null]]);
  });

  it('el mismo recurso lo ven los servicios internos con la forma interna (completa) y con filtros; pay-edge no lee /payouts/{id}', async () => {
    const m = merchantId();
    fund(m, 1_000);
    const p = await pay(m, 100);
    const internal = checked(ctx, 'GET', '/payouts', await ctx.as('pay-schedules').get(`/payouts?merchant_id=${m}`));
    expect(internal.body.data[0]).toMatchObject({ merchant_id: m, rail: 'bank_transfer', simulated: false, hold_id: expect.stringMatching(/^hd_/) });
    expect((await ctx.as('pay-edge').get(`/payouts/${p.body.id}`).set('x-merchant-id', m)).status).toBe(403);
    expect((await ctx.as('pay-payments').get('/payouts')).status).toBe(403);
  });
});
