import { LedgerUnavailableError, StatementUnavailableError } from '../src/settlement/errors';
import type { StatementLine } from '../src/settlement/ports';
import { type SettlementTestContext, checked, createSettlementContext, key, merchantId } from './helpers/app';
import { loadEventValidators } from './helpers/events-contract';
import { ref } from './helpers/scenarios';

const FROM = '2026-10-19T04:00:00.000Z';
const TO = '2026-10-26T04:00:00.000Z';
const AT = new Date('2026-10-21T14:30:00.000Z');

let ctx: SettlementTestContext;
let validators: Awaited<ReturnType<typeof loadEventValidators>>;
beforeAll(async () => {
  validators = await loadEventValidators('ledger-settlement.yaml');
});
afterEach(async () => ctx.close());

const line = (over: Partial<StatementLine> & { provider_reference: string }): StatementLine => ({ our_reference: null, direction: 'credit', amount_minor: 10000, value_date: '2026-10-21', booked_at: AT.toISOString(), ...over });
const setup = async (config: Parameters<typeof createSettlementContext>[0] = {}) => {
  ctx = await createSettlementContext(config);
};
const statement = (...lines: StatementLine[]) => ctx.connectors.statements.set('mock', { format: 'json', lines });
const charge = (merchant: string, net: number, fee: number, at = AT) => {
  const r = ref();
  ctx.ledger.seedCharge({ merchant, net, fee, at, ref: r });
  return r;
};
const start = (body: object = { connector: 'mock', period_from: FROM, period_to: TO }, idem = key(), caller = 'pay-backoffice') => ctx.as(caller).post('/reconciliation_runs', body).set('idempotency-key', idem);
async function reconcileNow(body?: object) {
  const res = checked(ctx, 'POST', '/reconciliation_runs', await start(body));
  expect(res.status).toBe(202);
  await ctx.reconciliation.idle();
  return checked(ctx, 'GET', `/reconciliation_runs/${res.body.id}`, await ctx.as('pay-backoffice').get(`/reconciliation_runs/${res.body.id}`)).body;
}
const exceptions = async (status?: string) => checked(ctx, 'GET', '/reconciliation_exceptions', await ctx.as('pay-backoffice').get(`/reconciliation_exceptions${status ? `?status=${status}` : ''}`)).body.data;
/** El ledger no se tocó: ninguna operación de escritura, y las mismas líneas de antes. */
const writes = () => ['createTransaction', 'createHold', 'postHold', 'voidHold'].reduce((n, op) => n + ctx.ledger.count(op), 0);

describe('conciliación (P2.H2.M6, REQ-P2-6)', () => {
  it('todo cuadra: la corrida termina `completed` sin excepciones ni eventos', async () => {
    await setup();
    const m = merchantId();
    const [a, b, c] = [charge(m, 9700, 300), charge(m, 4850, 150), charge(m, 975, 25)];
    statement(line({ provider_reference: 'B1', our_reference: a, amount_minor: 10000 }), line({ provider_reference: 'B2', our_reference: b, amount_minor: 5000 }), line({ provider_reference: 'B3', our_reference: c, amount_minor: 1000 }));
    const run = await reconcileNow();
    expect(run).toMatchObject({ status: 'completed', connector: 'mock', matched_count: 3, exception_count: 0, failure_code: null });
    expect(run.completed_at).not.toBeNull();
    expect(await exceptions()).toEqual([]);
    expect(await ctx.events('reconciliation.exception.opened')).toHaveLength(0);
  });

  it('una línea que no coincide crea una excepción con la diferencia y el ledger NO se ajusta solo', async () => {
    await setup();
    const m = merchantId();
    const r = charge(m, 9700, 300);
    statement(line({ provider_reference: 'B1', our_reference: r, amount_minor: 9950 }));
    const snapshot = JSON.stringify(ctx.ledger.entries);
    const balances = [...ctx.ledger.net.entries()];
    const run = await reconcileNow();
    expect(run).toMatchObject({ status: 'completed', matched_count: 0, exception_count: 1 });
    const [ex] = await exceptions('open');
    expect(ex).toMatchObject({ object: 'reconciliation_exception', run_id: run.id, kind: 'amount_mismatch', business_ref: r, provider_reference: 'B1', statement_amount_minor: 9950, ledger_amount_minor: 10000, status: 'open', resolved_by: null });
    // el ledger quedó exactamente como estaba: ni una escritura, ni un asiento nuevo, ni un saldo distinto
    expect(writes()).toBe(0);
    expect(JSON.stringify(ctx.ledger.entries)).toBe(snapshot);
    expect([...ctx.ledger.net.entries()]).toEqual(balances);
    const events = await ctx.events('reconciliation.exception.opened');
    expect(events).toHaveLength(1);
    expect(validators.get('reconciliation.exception.opened')?.(events[0])).toEqual([]);
    expect(events[0]).toMatchObject({ merchantid: m, subject: ex.id, data: { kind: 'amount_mismatch', difference_minor: -50, connector: 'mock', currency: 'BOB' } });
  });

  it('detecta las cinco clases de diferencia en una misma corrida', async () => {
    await setup();
    const m = merchantId();
    const okRef = charge(m, 1000, 0);
    const lonely = charge(m, 700, 0); // el banco no lo trae
    const mismatch = charge(m, 5000, 0);
    statement(
      line({ provider_reference: 'OK', our_reference: okRef, amount_minor: 1000 }),
      line({ provider_reference: 'MM', our_reference: mismatch, amount_minor: 4000 }),
      line({ provider_reference: 'GHOST', our_reference: ref(), amount_minor: 300 }),
      line({ provider_reference: 'NOREF', amount_minor: 250 }),
      line({ provider_reference: 'OK', our_reference: okRef, amount_minor: 1000 }),
    );
    const run = await reconcileNow();
    expect(run).toMatchObject({ status: 'completed', matched_count: 1, exception_count: 5 });
    const kinds = (await exceptions()).map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(['amount_mismatch', 'duplicate_in_statement', 'missing_in_ledger', 'missing_in_statement', 'unknown_reference'].sort());
    expect(lonely).toBeDefined();
    // `unknown_reference` no existe en el evento del contrato: sale como `missing_in_ledger` (PROPUESTAS.md) y el evento valida
    const events = await ctx.events('reconciliation.exception.opened');
    expect(events).toHaveLength(5);
    for (const e of events) expect(validators.get('reconciliation.exception.opened')?.(e)).toEqual([]);
    expect(events.map((e) => (e.data as { kind: string }).kind).sort()).toEqual(['amount_mismatch', 'duplicate_in_statement', 'missing_in_ledger', 'missing_in_ledger', 'missing_in_statement']);
  });

  it('repetir la corrida sobre el mismo periodo NO reabre ni vuelve a notificar lo ya conocido', async () => {
    await setup();
    const m = merchantId();
    const r = charge(m, 1000, 0);
    statement(line({ provider_reference: 'B1', our_reference: r, amount_minor: 900 }));
    const first = await reconcileNow();
    const second = await reconcileNow();
    expect(first.exception_count).toBe(1);
    expect(second.exception_count).toBe(1); // la corrida ve la diferencia otra vez…
    expect(await exceptions()).toHaveLength(1); // …pero es la misma excepción
    expect(await ctx.events('reconciliation.exception.opened')).toHaveLength(1);
  });

  it('una excepción ya resuelta no se reabre si la diferencia persiste', async () => {
    await setup();
    const m = merchantId();
    const r = charge(m, 1000, 0);
    statement(line({ provider_reference: 'B1', our_reference: r, amount_minor: 900 }));
    await reconcileNow();
    await ctx.db.pool.query("UPDATE settlement_exceptions SET status = 'dismissed', resolution = 'dismiss', resolved_by = 'op_x', resolved_at = now()");
    await reconcileNow();
    expect(await exceptions('open')).toEqual([]);
    expect(await exceptions('dismissed')).toHaveLength(1);
  });

  it('límite de periodo: una línea del banco asentada justo en `to` queda afuera; el cobro del ledger de ese borde se reporta, no se esconde', async () => {
    await setup();
    const m = merchantId();
    const inside = charge(m, 100, 0, new Date('2026-10-26T03:59:59.999Z'));
    const edge = charge(m, 200, 0, new Date('2026-10-26T04:00:00.000Z')); // ledger fuera del periodo
    statement(line({ provider_reference: 'IN', our_reference: inside, amount_minor: 100, booked_at: '2026-10-26T03:59:59.999Z' }), line({ provider_reference: 'EDGE', our_reference: edge, amount_minor: 200, booked_at: '2026-10-26T04:00:00.000Z' }));
    const run = await reconcileNow();
    expect(run).toMatchObject({ matched_count: 1, exception_count: 0 });
    const stored = await ctx.db.pool.query("SELECT outcome, count(*)::int AS n FROM settlement_statement_lines GROUP BY outcome ORDER BY outcome");
    expect(stored.rows).toEqual([{ outcome: 'ignored', n: 1 }, { outcome: 'matched', n: 1 }]);
    expect((await ctx.db.pool.query('SELECT ignored_count FROM settlement_reconciliation_runs')).rows[0].ignored_count).toBe(1);
  });

  it('no guarda la glosa del banco: ni en las líneas ni en las excepciones', async () => {
    await setup();
    const m = merchantId();
    charge(m, 100, 0);
    ctx.connectors.statements.set('mock', {
      format: 'json',
      lines: [{ ...line({ provider_reference: 'B1', our_reference: ref(), amount_minor: 100 }), description: 'Juan Perez CI 1234567', currency: 'BOB' } as unknown as StatementLine],
    });
    await reconcileNow();
    const dump = JSON.stringify([(await ctx.db.pool.query('SELECT * FROM settlement_statement_lines')).rows, (await ctx.db.pool.query('SELECT * FROM settlement_exceptions')).rows, await ctx.events('reconciliation.exception.opened')]);
    expect(dump).not.toContain('Perez');
    expect(dump).not.toContain('1234567');
  });

  describe('extractos que no se pueden leer: la corrida falla ENTERA, no asienta nada y no queda en `running`', () => {
    it.each<[string, () => void, string]>([
      ['JSON con una fecha inválida', () => ctx.connectors.statements.set('mock', { format: 'json', lines: [line({ provider_reference: 'B1', our_reference: ref(), value_date: '2026-02-30' })] }), 'statement_malformed'],
      ['JSON con un monto con decimales', () => ctx.connectors.statements.set('mock', { format: 'json', lines: [{ ...line({ provider_reference: 'B1' }), amount_minor: 10.5 }] }), 'statement_malformed'],
      ['texto JSON ilegible', () => ctx.connectors.statements.set('mock', { format: 'json', text: '{"data":' }), 'statement_malformed'],
      ['el conector no responde', () => (ctx.connectors.statementError = new StatementUnavailableError()), 'connector_unavailable'],
      ['el ledger no responde', () => ctx.ledger.failNext('listStatement', new LedgerUnavailableError()), 'ledger_unavailable'],
      ['un error inesperado del conector', () => (ctx.connectors.statementError = new TypeError('boom')), 'internal_error'],
    ])('%s ⇒ failed/%s', async (_name, arrange, code) => {
      await setup();
      const m = merchantId();
      charge(m, 100, 0);
      arrange();
      const run = await reconcileNow();
      expect(run).toMatchObject({ status: 'failed', failure_code: code, matched_count: 0, exception_count: 0 });
      expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_statement_lines')).rows[0].n).toBe(0);
      expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_exceptions')).rows[0].n).toBe(0);
      expect(await ctx.events('reconciliation.exception.opened')).toHaveLength(0);
      expect(writes()).toBe(0);
      // ya no está `running`: el barrido no la reintenta en bucle
      expect(await ctx.reconciliation.resumeRunning()).toBe(0);
    });

    it('el extracto es CSV o camt.053 según el conector, y lo ilegible falla igual', async () => {
      await setup({ config: { statementFormats: { mock: 'csv' } } });
      const m = merchantId();
      const r = charge(m, 9700, 300);
      ctx.connectors.statements.set('mock', { format: 'csv', text: `provider_reference,our_reference,direction,amount_minor,currency,value_date,booked_at,description\nB1,${r},credit,10000,BOB,2026-10-21,${AT.toISOString()},Maria Lopez\n` });
      const ok = await reconcileNow();
      expect(ok).toMatchObject({ status: 'completed', matched_count: 1, exception_count: 0 });
      expect(ctx.connectors.statementRequests.at(-1)?.format).toBe('csv');
      expect((await ctx.db.pool.query('SELECT source FROM settlement_reconciliation_runs')).rows[0].source).toBe('csv');
      ctx.connectors.statements.set('mock', { format: 'csv', text: 'provider_reference,our_reference\nB1,"sin cerrar' });
      expect(await reconcileNow()).toMatchObject({ status: 'failed', failure_code: 'statement_malformed' });
    });

    it('camt.053 truncado ⇒ failed/statement_malformed', async () => {
      await setup({ config: { statementFormats: { mock: 'camt053' } } });
      ctx.connectors.statements.set('mock', { format: 'camt053', text: '<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt><Ntry><Amt Ccy="BOB">10.00</Amt>' });
      expect(await reconcileNow()).toMatchObject({ status: 'failed', failure_code: 'statement_malformed' });
    });
  });

  it('un extracto que prueba que el banco pagó un payout en tránsito lo confirma; con otro monto, excepción y el pago sigue en tránsito', async () => {
    await setup();
    const m = merchantId();
    ctx.ledger.seedMovement({ debit: 'connector:mock:clearing', credit: `merchant:${m}:available`, amount: 9000, at: new Date('2026-10-01T10:00:00Z'), ref: ref(), code: 'release' });
    ctx.connectors.scenario = 'in_transit';
    const paid = await ctx.as('pay-schedules').post('/payouts', { merchant_id: m, amount_minor: 9000, currency: 'BOB', rail: 'bank_transfer', reason: 'manual' }).set('idempotency-key', key());
    expect(paid.body.status).toBe('in_transit');
    statement(line({ provider_reference: 'T1', our_reference: `${paid.body.id}:payout`, direction: 'debit', amount_minor: 8999 }));
    await reconcileNow();
    expect((await ctx.as('pay-schedules').get(`/payouts/${paid.body.id}`)).body.status).toBe('in_transit');
    expect((await exceptions()).map((e: { kind: string }) => e.kind)).toEqual(['amount_mismatch']);
    statement(line({ provider_reference: 'T1', our_reference: `${paid.body.id}:payout`, direction: 'debit', amount_minor: 9000 }));
    await reconcileNow();
    expect((await ctx.as('pay-schedules').get(`/payouts/${paid.body.id}`)).body.status).toBe('paid');
    expect(ctx.ledger.count('postHold')).toBe(1);
  });

  it('cinco corridas simultáneas sobre lo mismo: las excepciones no se duplican y cada una avisa una sola vez', async () => {
    await setup();
    const m = merchantId();
    const refs = [charge(m, 100, 0), charge(m, 200, 0), charge(m, 300, 0)];
    statement(...refs.map((r, i) => line({ provider_reference: `B${i}`, our_reference: r, amount_minor: 1 })));
    const responses = await Promise.all(Array.from({ length: 5 }, () => start()));
    expect(responses.every((r) => r.status === 202)).toBe(true);
    await ctx.reconciliation.idle();
    expect((await ctx.db.pool.query("SELECT count(*)::int AS n FROM settlement_reconciliation_runs WHERE status = 'completed'")).rows[0].n).toBe(5);
    expect(await exceptions()).toHaveLength(3);
    expect(await ctx.events('reconciliation.exception.opened')).toHaveLength(3);
  });

  it('un corte del proceso a mitad de corrida: resumeRunning la retoma desde cero y termina', async () => {
    await setup();
    const m = merchantId();
    charge(m, 100, 0);
    statement();
    const created = await ctx.db.pool.query(
      `INSERT INTO settlement_reconciliation_runs (id, mode, connector, period_from, period_to, source, status, requested_by, created_at) VALUES ('rr_abcdefghijklmnop', 'test', 'mock', $1, $2, 'api', 'running', 'pay-backoffice', now() - interval '1 hour') RETURNING id`,
      [FROM, TO],
    );
    expect(created.rows).toHaveLength(1);
    expect(await ctx.reconciliation.resumeRunning()).toBe(1);
    await ctx.reconciliation.idle();
    expect((await ctx.as('pay-backoffice').get('/reconciliation_runs/rr_abcdefghijklmnop')).body).toMatchObject({ status: 'completed', exception_count: 1 });
  });

  describe('forma del pedido y autorización', () => {
    beforeEach(async () => setup());
    it.each([
      ['conector desconocido', { connector: 'visa', period_from: FROM, period_to: TO }],
      ['periodo invertido', { connector: 'mock', period_from: TO, period_to: FROM }],
      ['periodo vacío', { connector: 'mock', period_from: FROM, period_to: FROM }],
      ['periodo de más de 93 días', { connector: 'mock', period_from: '2026-01-01T00:00:00.000Z', period_to: '2026-06-01T00:00:00.000Z' }],
      ['fecha mal escrita', { connector: 'mock', period_from: 'ayer', period_to: TO }],
      ['campo no declarado', { connector: 'mock', period_from: FROM, period_to: TO, force: true }],
      ['faltan campos', { connector: 'mock' }],
    ])('rechaza %s con 422 y no crea nada', async (_n, body) => {
      const res = checked(ctx, 'POST', '/reconciliation_runs', await start(body));
      expect(res.status).toBe(422);
      expect((await ctx.db.pool.query('SELECT count(*)::int AS n FROM settlement_reconciliation_runs')).rows[0].n).toBe(0);
    });

    it('solo la consola de operación; sin clave de idempotencia, 400; la misma clave repite la respuesta', async () => {
      expect((await start(undefined, key(), 'pay-schedules')).status).toBe(403);
      expect((await start(undefined, key(), 'pay-edge')).status).toBe(403);
      expect((await ctx.as('pay-backoffice').post('/reconciliation_runs', { connector: 'mock', period_from: FROM, period_to: TO })).status).toBe(400);
      const idem = key();
      const first = await start(undefined, idem);
      const again = await start(undefined, idem);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      await ctx.reconciliation.idle();
    });

    it('GET /reconciliation_runs/{id}: 404 si no existe o el id está mal formado; 403 para quien no es la consola', async () => {
      expect(checked(ctx, 'GET', '/reconciliation_runs/rr_abcdefghijklmnop', await ctx.as('pay-backoffice').get('/reconciliation_runs/rr_abcdefghijklmnop')).status).toBe(404);
      expect((await ctx.as('pay-backoffice').get('/reconciliation_runs/otra-cosa')).status).toBe(404);
      expect((await ctx.as('pay-schedules').get('/reconciliation_runs/rr_abcdefghijklmnop')).status).toBe(403);
    });

    it('lista las excepciones de la más nueva a la más vieja, con paginación y filtro por estado', async () => {
      const m = merchantId();
      const refs = [charge(m, 100, 0), charge(m, 200, 0), charge(m, 300, 0)];
      statement(...refs.map((r, i) => line({ provider_reference: `B${i}`, our_reference: r, amount_minor: 1 })));
      await reconcileNow();
      const page1 = checked(ctx, 'GET', '/reconciliation_exceptions', await ctx.as('pay-backoffice').get('/reconciliation_exceptions?limit=2'));
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.has_more).toBe(true);
      const page2 = checked(ctx, 'GET', '/reconciliation_exceptions', await ctx.as('pay-backoffice').get(`/reconciliation_exceptions?limit=2&starting_after=${page1.body.next_cursor}`));
      expect(page2.body.data).toHaveLength(1);
      expect(new Set([...page1.body.data, ...page2.body.data].map((e: { id: string }) => e.id)).size).toBe(3);
      expect((await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=resolved')).body.data).toEqual([]);
      expect((await ctx.as('pay-backoffice').get('/reconciliation_exceptions?status=raro')).status).toBe(422);
      expect((await ctx.as('pay-edge').get('/reconciliation_exceptions')).status).toBe(403);
    });
  });
});
