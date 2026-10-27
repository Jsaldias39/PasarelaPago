import { XMLParser } from 'fast-xml-parser';
import { TRANSFER_BANK } from '../src/connectors.module';
import type { SimulatedBank } from '../src/connectors/mock/simulated-bank';
import { SIMULATED_BANK } from '../src/core/mock-pump.service';
import { StatementsService } from '../src/core/statements.service';
import type { StatementLine } from '../src/domain/connector';
import { asPayments, asSettlement, chargeBody, createTestApp, get, post, uniqueKey, type TestApp } from './support/app';
import { loadEventValidator, MESSAGES, outboxEvents } from './support/events';

let t: TestApp;
let bank: SimulatedBank;
let transferBank: SimulatedBank;
let statements: StatementsService;
let validateEvent: Awaited<ReturnType<typeof loadEventValidator>>;

beforeAll(async () => {
  t = await createTestApp();
  bank = t.app.get(SIMULATED_BANK);
  transferBank = t.app.get(TRANSFER_BANK);
  statements = t.app.get(StatementsService);
  validateEvent = await loadEventValidator();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
});

const create = async (over: Record<string, unknown> = {}) => (await post(t.app, '/charges', chargeBody(over, t.clock), asPayments, uniqueKey())).body;
const window = () => ({ from: new Date(t.clock.now().getTime() - 60_000), to: new Date(t.clock.now().getTime() + 3_600_000) });
const query = (connector: string, extra = '') => {
  const w = window();
  return `/statements?connector=${connector}&from=${w.from.toISOString()}&to=${w.to.toISOString()}${extra}`;
};
const exceptions = async () => (await t.db.pool.query('SELECT kind, charge_id, expected_minor::int AS expected, actual_minor::int AS actual, provider_reference FROM statement_exceptions ORDER BY provider_reference, kind')).rows;
const statusEvents = () => outboxEvents(t.db.pool, 'connector.transaction.status_changed');

const credit = (over: Partial<StatementLine> & { providerReference: string }): StatementLine => ({
  ourReference: null,
  direction: 'credit',
  amountMinor: 1000n,
  currency: 'BOB',
  valueDate: new Date().toISOString().slice(0, 10),
  bookedAt: t.clock.now(),
  description: null,
  ...over,
});

describe('GET /statements (P4.H2.M5)', () => {
  it('el extracto del simulador CUADRA con sus cobros: una línea por cobro pagado, emparejada, con el importe cobrado', async () => {
    const a = await create();
    const b = await create({ amount_minor: 25050 });
    const response = await get(t.app, query('mock'), asSettlement);
    expect(response.status).toBe(200);
    t.contract.assertResponse({ method: 'GET', path: '/statements', status: 200, body: response.body });
    const byCharge = new Map<string, { amount_minor: number }>(response.body.data.map((l: { charge_id: string; amount_minor: number }) => [l.charge_id, l]));
    expect(byCharge.get(a.id)?.amount_minor).toBe(10000);
    expect(byCharge.get(b.id)?.amount_minor).toBe(25050);
    expect(response.body.data.every((l: { direction: string; currency: string; description: unknown }) => l.direction === 'credit' && l.currency === 'BOB' && l.description === null)).toBe(true);
    expect(response.body).toMatchObject({ object: 'list', has_more: false, next_cursor: null });
  });

  it('payment_intent_id y merchant_id (tanda 4b): cada línea emparejada con un cobro trae el `pi_…` y el `mc_…` de ESE cobro (la clave con la que pay-settlement cruza con el ledger)', async () => {
    const a = await create();
    const b = await create({ amount_minor: 25050 });
    const response = await get(t.app, query('mock'), asSettlement);
    t.contract.assertResponse({ method: 'GET', path: '/statements', status: 200, body: response.body });
    const row = (id: string) => response.body.data.find((l: { charge_id: string }) => l.charge_id === id);
    expect(row(a.id).payment_intent_id).toBe((await t.db.pool.query('SELECT payment_intent_id FROM connector_charges WHERE id = $1', [a.id])).rows[0].payment_intent_id);
    expect(row(a.id).payment_intent_id).toMatch(/^pi_[a-z0-9]{10,40}$/);
    expect(row(b.id).payment_intent_id).not.toBe(row(a.id).payment_intent_id);
    expect(row(a.id).merchant_id).toMatch(/^mc_[a-z0-9]+$/);
    expect(row(a.id).merchant_id).toBe((await t.db.pool.query('SELECT merchant_id FROM connector_charges WHERE id = $1', [a.id])).rows[0].merchant_id);
    // Con otro comercio, cada línea trae el SUYO (no se mezcla).
    const other = await create({ merchant_id: 'mc_otrocomercio0001', amount_minor: 30050 });
    const again = await get(t.app, query('mock'), asSettlement);
    expect(again.body.data.find((l: { charge_id: string }) => l.charge_id === other.id).merchant_id).toBe('mc_otrocomercio0001');
    expect(again.body.data.find((l: { charge_id: string }) => l.charge_id === a.id).merchant_id).not.toBe('mc_otrocomercio0001');
  });

  it('payment_intent_id y merchant_id: una línea SIN cobro (referencia ajena o sin referencia) trae `null` en ambos, nunca uno inventado; la línea de una transferencia bancaria trae el del cobro que paga', async () => {
    const charge = await create({ method: 'bank_transfer', amount_minor: 25000 });
    const reference = charge.next_action.reference as string;
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-PI-1', ourReference: reference, amountMinor: 25000n }));
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-PI-2', ourReference: 'TRZZZZZZZZZZ', amountMinor: 1000n }));
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-PI-3', ourReference: null, amountMinor: 1000n }));
    const response = await get(t.app, query('bank_transfer'), asSettlement);
    const byRef = new Map<string, { charge_id: string | null; payment_intent_id: string | null; merchant_id: string | null }>(response.body.data.map((l: { provider_reference: string }) => [l.provider_reference, l]));
    expect(byRef.get('BNK-PI-1')?.charge_id).toBe(charge.id);
    expect(byRef.get('BNK-PI-1')?.payment_intent_id).toBe((await t.db.pool.query('SELECT payment_intent_id FROM connector_charges WHERE id = $1', [charge.id])).rows[0].payment_intent_id);
    expect(byRef.get('BNK-PI-1')?.merchant_id).toBe((await t.db.pool.query('SELECT merchant_id FROM connector_charges WHERE id = $1', [charge.id])).rows[0].merchant_id);
    expect(byRef.get('BNK-PI-2')).toMatchObject({ charge_id: null, payment_intent_id: null, merchant_id: null });
    expect(byRef.get('BNK-PI-3')).toMatchObject({ charge_id: null, payment_intent_id: null, merchant_id: null });
    t.contract.assertResponse({ method: 'GET', path: '/statements', status: 200, body: response.body });
  });

  it('paginación por cursor: sin repetidos ni saltos; un cursor inventado es 422', async () => {
    const ids = [] as string[];
    for (let i = 0; i < 5; i += 1) ids.push((await create({ amount_minor: 10000 + (i + 1) * 100 })).id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await get(t.app, query('mock', `&limit=2${cursor ? `&starting_after=${cursor}` : ''}`), asSettlement);
      expect(page.status).toBe(200);
      t.contract.assertResponse({ method: 'GET', path: '/statements', status: 200, body: page.body });
      seen.push(...page.body.data.map((l: { charge_id: string }) => l.charge_id));
      cursor = page.body.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
    const bad = await get(t.app, query('mock', '&starting_after=bm8tZXhpc3Rl'), asSettlement);
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([{ field: 'starting_after', code: 'unknown_cursor' }]);
  });

  it('camt.053 (Accept: application/xml): XML bien formado con una entrada por línea y los importes del extracto', async () => {
    const a = await create();
    const response = await get(t.app, query('mock'), { ...asSettlement, accept: 'application/xml' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/xml');
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(response.text);
    const entries = [parsed.Document.BkToCstmrStmt.Stmt.Ntry].flat();
    const mine = entries.find((e: { AcctSvcrRef: string; NtryDtls: { TxDtls: { Refs: { EndToEndId: string } } } }) => e.NtryDtls.TxDtls.Refs.EndToEndId === a.id);
    expect(mine).toBeDefined();
    expect(mine.Amt['#text']).toBe(100);
    expect(mine.CdtDbtInd).toBe('CRDT');
  });

  it('CSV (Accept: text/csv): cabecera estable y una fila por línea', async () => {
    const a = await create();
    const response = await get(t.app, query('mock'), { ...asSettlement, accept: 'text/csv' });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    const [header, ...rows] = response.text.trim().split(/\r?\n/);
    expect(header).toBe('provider_reference,our_reference,charge_id,direction,amount_minor,currency,value_date,booked_at,description');
    expect(rows.some((r) => r.includes(a.id) && r.includes(',credit,10000,BOB,'))).toBe(true);
  });

  it.each([
    ['sin conector', '', 'connector'],
    ['conector inexistente', '&connector=paypal', 'connector'],
    ['sin fechas', '&connector=mock', 'from'],
    ['fecha ilegible', '&connector=mock&from=ayer&to=hoy', 'from'],
    ['to antes de from', '&connector=mock&from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', 'to'],
    ['rango de más de 92 días', '&connector=mock&from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z', 'to'],
    ['límite 0', '&connector=mock&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=0', 'limit'],
    ['límite 101', '&connector=mock&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=101', 'limit'],
    ['límite no numérico', '&connector=mock&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=abc', 'limit'],
    ['conector no cargado', '&connector=mercantil_card&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z', 'connector'],
  ])('validación: %s ⇒ 422', async (_name, params, field) => {
    const response = await get(t.app, `/statements?x=1${params}`, asSettlement);
    expect(response.status).toBe(422);
    expect(response.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    t.contract.assertResponse({ method: 'GET', path: '/statements', status: 422, body: response.body });
  });

  it('banco caído ⇒ 502 connector_unavailable', async () => {
    bank.setDown(true);
    const response = await get(t.app, query('mock'), asSettlement);
    expect(response.status).toBe(502);
    expect(response.body.code).toBe('connector_unavailable');
    t.contract.assertResponse({ method: 'GET', path: '/statements', status: 502, body: response.body });
  });
});

describe('conciliación por extracto', () => {
  it('escenario 09: el extracto trae Bs 1,00 menos ⇒ queda como excepción `amount_mismatch` con lo esperado y lo recibido', async () => {
    const ok = await create();
    const off = await create({ amount_minor: 10009 });
    const summary = await statements.reconcile('mock', window());
    expect(summary).toMatchObject({ matched: 2, captured: 0, exceptions: 1 });
    expect(await exceptions()).toEqual([{ kind: 'amount_mismatch', charge_id: off.id, expected: 10009, actual: 9909, provider_reference: expect.stringMatching(/^SIM-/) }]);
    expect(ok.id).not.toBe(off.id);
    // Segunda corrida: nada nuevo (idempotente).
    expect(await statements.reconcile('mock', window())).toMatchObject({ exceptions: 0 });
    expect(await exceptions()).toHaveLength(1);
  });

  it('transferencia: una línea con la referencia y el importe exactos CONFIRMA el cobro, una sola vez', async () => {
    const charge = await create({ method: 'bank_transfer', amount_minor: 25000 });
    const reference = charge.next_action.reference as string;
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-0001', ourReference: reference, amountMinor: 25000n }));
    expect(await statements.reconcile('bank_transfer', window())).toMatchObject({ lines: expect.any(Number), matched: 1, captured: 1, exceptions: 0 });
    const row = (await t.db.pool.query('SELECT provider_status FROM connector_charges WHERE id = $1', [charge.id])).rows[0];
    expect(row.provider_status).toBe('captured');
    const events = await statusEvents();
    expect(events).toHaveLength(1);
    expect(validateEvent(MESSAGES.status, events[0]?.envelope)).toEqual([]);
    expect(events[0]?.envelope.data).toMatchObject({ status: 'captured', connector: 'bank_transfer', observed_via: 'status_inquiry', provider_event_id: 'stmt:BNK-0001', amount_minor: 25000 });
    // El extracto de transferencias muestra la línea emparejada con el cobro.
    const listed = await get(t.app, query('bank_transfer'), asSettlement);
    expect(listed.body.data.find((l: { provider_reference: string }) => l.provider_reference === 'BNK-0001')).toMatchObject({ charge_id: charge.id, our_reference: reference, amount_minor: 25000 });
    // Segunda corrida: ni cambia el cobro ni repite el evento ni crea excepciones.
    expect(await statements.reconcile('bank_transfer', window())).toMatchObject({ captured: 0, exceptions: 0 });
    expect(await statusEvents()).toHaveLength(1);
  });

  it('línea SIN referencia, con referencia ajena, o con otro importe ⇒ excepción; el cobro NO se confirma', async () => {
    const charge = await create({ method: 'bank_transfer', amount_minor: 25000 });
    const reference = charge.next_action.reference as string;
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-0010', ourReference: null, amountMinor: 25000n }));
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-0011', ourReference: 'TRZZZZZZZZZZ', amountMinor: 25000n }));
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-0012', ourReference: reference, amountMinor: 24999n }));
    transferBank.injectStatementLine({ ...credit({ providerReference: 'BNK-0013', ourReference: reference, amountMinor: 25000n }), direction: 'debit' });
    const summary = await statements.reconcile('bank_transfer', window());
    expect(summary).toMatchObject({ captured: 0, exceptions: 3 });
    expect((await exceptions()).map((e) => [e.provider_reference, e.kind, e.expected, e.actual])).toEqual([
      ['BNK-0010', 'unmatched', null, 25000],
      ['BNK-0011', 'unmatched', null, 25000],
      ['BNK-0012', 'amount_mismatch', 25000, 24999],
    ]);
    expect((await t.db.pool.query('SELECT provider_status FROM connector_charges WHERE id = $1', [charge.id])).rows[0].provider_status).toBe('pending');
    expect(await statusEvents()).toHaveLength(0); // el débito no cuenta como pago
  });

  it('crédito sobre un cobro ya anulado o vencido ⇒ `late_credit` para decisión humana (no se reactiva el cobro)', async () => {
    const canceled = await create({ method: 'bank_transfer', amount_minor: 30000 });
    await post(t.app, `/charges/${canceled.id}/cancel`, undefined);
    transferBank.injectStatementLine(credit({ providerReference: 'BNK-0020', ourReference: canceled.next_action.reference, amountMinor: 30000n }));
    expect(await statements.reconcile('bank_transfer', window())).toMatchObject({ captured: 0, exceptions: 1 });
    expect(await exceptions()).toEqual([{ kind: 'late_credit', charge_id: canceled.id, expected: 30000, actual: 30000, provider_reference: 'BNK-0020' }]);
    expect((await t.db.pool.query('SELECT provider_status FROM connector_charges WHERE id = $1', [canceled.id])).rows[0].provider_status).toBe('canceled');
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: tres conciliaciones simultáneas de la misma línea confirman el cobro UNA vez', async () => {
    await t.reset();
    const charge = await create({ method: 'bank_transfer', amount_minor: 40000 });
    transferBank.injectStatementLine(credit({ providerReference: `BNK-C${Date.now()}`, ourReference: charge.next_action.reference, amountMinor: 40000n }));
    const runs = await Promise.all([statements.reconcile('bank_transfer', window()), statements.reconcile('bank_transfer', window()), statements.reconcile('bank_transfer', window())]);
    expect(runs.reduce((n, r) => n + r.captured, 0)).toBe(1);
    expect(await statusEvents()).toHaveLength(1);
  });

  it('la transferencia vencida no tiene referencia reutilizable: la referencia de un cobro es única y estable', async () => {
    const a = await create({ method: 'bank_transfer', amount_minor: 11000 });
    const b = await create({ method: 'bank_transfer', amount_minor: 11000 });
    expect(a.next_action.reference).not.toBe(b.next_action.reference);
    const rows = await t.db.pool.query('SELECT count(DISTINCT reference)::int AS n, count(*)::int AS total FROM bank_transfer_references');
    expect(rows.rows[0]).toEqual({ n: 2, total: 2 });
    // Consultar el estado con refresh no cambia la referencia.
    await get(t.app, `/charges/${a.id}/status?refresh=true`);
    expect((await get(t.app, `/charges/${a.id}`)).body.next_action.reference).toBe(a.next_action.reference);
  });
});
