import { type LedgerTestContext, businessRef, checked, createLedgerContext, merchantId, repoPath } from './helpers/app';

let ctx: LedgerTestContext;
beforeAll(async () => {
  ctx = await createLedgerContext();
});
afterAll(async () => ctx.close());

const CLEARING = 'connector:mercantil_qr:clearing';
const key = () => `key-${Math.random().toString(36).slice(2, 12)}`;
async function charge(m: string, amount: number) {
  const res = await ctx
    .as('pay-payments')
    .post('/transactions', { business_ref: businessRef(), attempt: 1, currency: 'BOB', legs: [{ debit_account: CLEARING, credit_account: `merchant:${m}:pending`, amount_minor: amount, code: 'charge' }] })
    .set('idempotency-key', key());
  expect(res.status).toBe(201);
}
const statement = async (account: string, query = '') =>
  checked(ctx, 'GET', '/statements', await ctx.as('pay-settlement').get(`/statements?account=${encodeURIComponent(account)}${query}`));

describe('GET /balances', () => {
  it('cuenta acreedora: balance = créditos − débitos − débitos pendientes; cuenta deudora: valor absoluto con nature debit', async () => {
    const m = merchantId();
    await charge(m, 2500);
    const pending = checked(ctx, 'GET', '/balances', await ctx.as('pay-payments').get(`/balances?account=${encodeURIComponent(`merchant:${m}:pending`)}`));
    expect(pending.body).toMatchObject({ object: 'balance', account: `merchant:${m}:pending`, currency: 'BOB', balance_minor: 2500, nature: 'credit', pending_debits_minor: 0 });
    const clearing = checked(ctx, 'GET', '/balances', await ctx.as('pay-payments').get(`/balances?account=${encodeURIComponent(CLEARING)}`));
    expect(clearing.body.nature).toBe('debit');
  });

  it('cuenta que el ledger nunca vio ⇒ 404; cuenta fuera del plan o sin parámetro ⇒ 422', async () => {
    expect((await ctx.as('pay-payments').get(`/balances?account=${encodeURIComponent(`merchant:${merchantId()}:pending`)}`)).status).toBe(404);
    for (const q of ['?account=foo', '', `?account=platform:fees&extra=1`]) {
      const res = checked(ctx, 'GET', '/balances', await ctx.as('pay-payments').get(`/balances${q}`));
      expect(res.status).toBe(422);
    }
  });
});

describe('GET /statements — orden estable y paginación (P2.H1.M6)', () => {
  it('las páginas, en orden y sin repetir ni saltear, suman exactamente el extracto completo', async () => {
    const m = merchantId();
    const amounts = Array.from({ length: 25 }, (_, i) => 100 + i);
    for (const amount of amounts) await charge(m, amount);
    const account = `merchant:${m}:pending`;

    const full = (await statement(account, '&limit=100')).body;
    expect(full.data).toHaveLength(25);
    expect(full.has_more).toBe(false);
    expect(full.next_cursor).toBeNull();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { body: { data: { id: string }[]; has_more: boolean; next_cursor: string | null } } = await statement(account, `&limit=10${cursor ? `&starting_after=${cursor}` : ''}`);
      seen.push(...page.body.data.map((l) => l.id));
      cursor = page.body.next_cursor;
      pages += 1;
      expect(page.body.has_more).toBe(cursor !== null);
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(full.data.map((l: { id: string }) => l.id));
    expect(new Set(seen).size).toBe(25);

    // ordenado de más nuevo a más viejo, con desempate estable por id
    const keys = full.data.map((l: { posted_at: string; id: string }) => `${l.posted_at}|${l.id}`);
    expect(keys).toEqual([...keys].sort().reverse());
  });

  it('un movimiento nuevo entre dos páginas NO corre la segunda página (el cursor es por posición, no por desplazamiento)', async () => {
    const m = merchantId();
    for (let i = 0; i < 12; i += 1) await charge(m, 10 + i);
    const account = `merchant:${m}:pending`;
    const page1 = (await statement(account, '&limit=5')).body;
    const expectedPage2 = (await statement(account, `&limit=5&starting_after=${page1.next_cursor}`)).body.data.map((l: { id: string }) => l.id);
    await charge(m, 999); // entra un movimiento más nuevo
    const page2 = (await statement(account, `&limit=5&starting_after=${page1.next_cursor}`)).body.data.map((l: { id: string }) => l.id);
    expect(page2).toEqual(expectedPage2);
  });

  it('cada pata aparece como una línea de débito en una cuenta y una de crédito en la otra, con su contraparte', async () => {
    const m = merchantId();
    await charge(m, 777);
    const credit = (await statement(`merchant:${m}:pending`)).body.data[0];
    expect(credit).toMatchObject({ direction: 'credit', counterparty_account: CLEARING, amount_minor: 777, code: 'charge', leg_index: 0, attempt: 1 });
    const debit = (await statement(CLEARING, '&limit=100')).body.data.find((l: { business_ref: string }) => l.business_ref === credit.business_ref);
    expect(debit).toMatchObject({ direction: 'debit', counterparty_account: `merchant:${m}:pending`, amount_minor: 777 });
  });

  it('filtra por rango de fechas', async () => {
    const m = merchantId();
    await charge(m, 50);
    const account = `merchant:${m}:pending`;
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await statement(account, `&from=${encodeURIComponent(future)}`)).body.data).toHaveLength(0);
    expect((await statement(account, `&to=${encodeURIComponent(future)}`)).body.data).toHaveLength(1);
  });

  it('valida los parámetros: límite fuera de rango, cursor inválido, fecha mal formada, cuenta desconocida', async () => {
    const m = merchantId();
    await charge(m, 1);
    const account = `merchant:${m}:pending`;
    for (const q of ['&limit=0', '&limit=101', '&limit=abc', '&starting_after=no-es-un-cursor', '&from=ayer']) {
      const res = await statement(account, q);
      expect([422]).toContain(res.status);
    }
    const unknown = await statement(`merchant:${merchantId()}:pending`);
    expect(unknown.status).toBe(404);
  });
});

describe('GET /balance público (lo atiende pay-edge)', () => {
  it('devuelve pendiente y disponible del comercio autenticado, validado contra public-v1.yaml', async () => {
    const { loadContract } = await import('@pay/testing');
    const publicContract = await loadContract(repoPath('contracts/openapi/public-v1.yaml'));
    const m = merchantId();
    const other = merchantId();
    await charge(m, 3000);
    await charge(other, 111);
    const fetchBalance = async (id: string | undefined, service = 'pay-edge') => {
      let req = ctx.as(service).get('/balance');
      if (id) req = req.set('x-merchant-id', id);
      return req;
    };
    const res = await fetchBalance(m);
    expect(res.status).toBe(200);
    publicContract.assertResponse({ method: 'GET', path: '/balance', status: 200, body: res.body });
    expect(res.body).toMatchObject({ object: 'balance', currency: 'BOB', pending_minor: 3000, available_minor: 0 });
    expect((await fetchBalance(other)).body.pending_minor).toBe(111); // otro comercio, otro saldo
    expect((await fetchBalance(merchantId())).body).toMatchObject({ pending_minor: 0, available_minor: 0 }); // nunca operó
  });

  it('sin comercio identificado ⇒ 401; con una identidad de servicio que no es pay-edge ⇒ 403', async () => {
    expect((await ctx.as('pay-edge').get('/balance')).status).toBe(401);
    expect((await ctx.as('pay-edge').get('/balance').set('x-merchant-id', 'mc_corto')).status).toBe(401);
    for (const service of ['pay-payments', 'pay-settlement', 'pay-schedules']) {
      expect((await ctx.as(service).get('/balance').set('x-merchant-id', merchantId())).status).toBe(403);
    }
  });
});
