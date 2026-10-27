import { createTestContext, PLATFORM_MERCHANT, type TestContext } from './support/app';
import { createMandate, dueMandate, eventsOf, mandateBody, newMerchant, pub, rows, setMerchantStatus } from './support/http';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  await setMerchantStatus(ctx, PLATFORM_MERCHANT, 'active');
});
afterEach(async () => {
  // El doble valida cada petición que recibe contra internal-ledger-v1.yaml: pay-schedules tiene que cumplir el contrato en el cable.
  const violations = ctx.ledger.violations;
  await ctx.close();
  expect(violations).toEqual([]);
});

const HOUR = 3600_000;
const advance = (ms: number) => (ctx.clock.now = new Date(ctx.clock.now.getTime() + ms));
const payments = (mandateId: string) => rows(ctx, 'SELECT * FROM scheduled_payments WHERE mandate_id = $1 ORDER BY period', [mandateId]);
const mandateRow = async (id: string) => (await rows(ctx, 'SELECT status, next_run_on::text AS next_run_on FROM mandates WHERE id = $1', [id]))[0];
const payerBalance = (payer: string, mode = 'test') => ctx.ledger.balanceOf(mode, `merchant:${payer}:available`);
const voidCalls = () => ctx.ledger.calls.filter((c) => /void|cancel|delete/i.test(c.path) || c.method === 'DELETE');

describe('kill-test del carril y flujo E5 (REQ-P5-6, P5.H3.M3 y M5)', () => {
  it('1.000,00 programados con 500,00 disponibles: NO se ejecuta, queda esperando fondos, avisa, y el saldo no se toca', async () => {
    const m = await dueMandate(ctx, { funds: 50_000, amount: 100_000 });
    const summary = await ctx.executor.runOnce();
    expect(summary).toMatchObject({ materialized: 1, processed: 1, executed: 0, waitingFunds: 1 });

    const [sp] = await payments(m.mandateId);
    expect(sp).toMatchObject({ status: 'waiting_funds', phase: 'hold', attempts: 1, ledger_attempt: 2, last_failure_code: 'insufficient_funds', needs_review: false, hold_id: null });
    expect(await mandateRow(m.mandateId)).toMatchObject({ status: 'paused_insufficient_funds' });
    expect(payerBalance(m.payer)).toBe(50_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(0);
    expect(ctx.ledger.holds()).toHaveLength(0);

    const [notice] = await eventsOf(ctx, 'scheduled_payment.insufficient_funds', sp.id);
    expect(notice.data).toEqual({
      scheduled_payment_id: sp.id, mandate_id: m.mandateId, merchant_id: m.payer, period: '2026-03', amount_minor: 100_000, currency: 'BOB',
      required_minor: 100_000, available_minor: 50_000, attempt: 1, retry_at: new Date(ctx.clock.now.getTime() + HOUR).toISOString(),
    });
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(0);
  });

  it('E5: sin fondos → aviso → entran fondos → reintento a la hora fijada → éxito; todo con una sola ejecución', async () => {
    const m = await dueMandate(ctx, { funds: 50_000, amount: 100_000 });
    await ctx.executor.runOnce();
    const [waiting] = await payments(m.mandateId);

    // Entran fondos, pero todavía no es la hora del reintento: no se vuelve a intentar.
    ctx.ledger.fund('test', `merchant:${m.payer}:available`, 60_000);
    advance(HOUR - 1000);
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 0, processed: 0, executed: 0 });
    expect((await payments(m.mandateId))[0].status).toBe('waiting_funds');

    advance(1000);
    expect(await ctx.executor.runOnce()).toMatchObject({ processed: 1, executed: 1 });
    const [sp] = await payments(m.mandateId);
    expect(sp).toMatchObject({ id: waiting.id, status: 'executed', phase: 'done', attempts: 2, ledger_attempt: 2, needs_review: false, last_failure_code: null });
    expect(sp.ledger_transfer_id).toMatch(/^tf_[a-z0-9]{10,40}$/);
    expect(payerBalance(m.payer)).toBe(10_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(ctx.ledger.balanceOf('test', `schedule:${m.mandateId}:reserve`)).toBe(0);
    expect(await mandateRow(m.mandateId)).toMatchObject({ status: 'active', next_run_on: '2026-04-10' });

    const executed = await eventsOf(ctx, 'scheduled_payment.executed', sp.id);
    expect(executed).toHaveLength(1);
    expect(executed[0].data).toMatchObject({ scheduled_payment_id: sp.id, mandate_id: m.mandateId, merchant_id: m.payer, period: '2026-03', amount_minor: 100_000, currency: 'BOB', ledger_transfer_id: sp.ledger_transfer_id });
    // El segundo intento usó un `attempt` nuevo del libro mayor y claves distintas; el primero no se reutilizó.
    const holdCalls = ctx.ledger.calls.filter((c) => c.method === 'POST' && c.path === '/holds');
    expect(holdCalls.map((c) => [c.body.attempt, c.headers['idempotency-key']])).toEqual([[1, `${sp.id}:reserve:1`], [2, `${sp.id}:reserve:2`]]);
    expect(holdCalls.every((c) => c.body.business_ref === `${sp.id}:reserve`)).toBe(true);
    expect(voidCalls()).toEqual([]);
  });

  it('límite: con exactamente el monto se ejecuta; con un centavo menos, no', async () => {
    const exact = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    const short = await dueMandate(ctx, { funds: 99_999, amount: 100_000 });
    await ctx.executor.runOnce();
    expect((await payments(exact.mandateId))[0].status).toBe('executed');
    expect(payerBalance(exact.payer)).toBe(0);
    expect((await payments(short.mandateId))[0].status).toBe('waiting_funds');
    expect(payerBalance(short.payer)).toBe(99_999);
  });

  it('la reserva `schedule:{mandato}:reserve` retiene el monto entre las dos fases y queda en cero al liberar', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    await ctx.executor.runOnce();
    const [hold] = ctx.ledger.holds();
    expect(hold).toMatchObject({ debit_account: `merchant:${m.payer}:available`, credit_account: `schedule:${m.mandateId}:reserve`, amount_minor: 100_000, status: 'posted' });
    const release = ctx.ledger.calls.find((c) => c.method === 'POST' && c.path === '/transactions');
    expect(release?.body.legs).toEqual([{ debit_account: `schedule:${m.mandateId}:reserve`, credit_account: `merchant:${m.beneficiary}:available`, amount_minor: 100_000, code: 'mandate' }]);
  });

  it('política agotada: tras el último reintento sin fondos queda `failed` con aviso, el mandato vuelve a `active` y no queda ninguna retención', async () => {
    const m = await dueMandate(ctx, { funds: 10_000, amount: 100_000 }); // política de prueba: 3 esperas ⇒ 4 intentos
    for (const wait of [HOUR, 2 * HOUR, 4 * HOUR]) {
      await ctx.executor.runOnce();
      expect((await payments(m.mandateId))[0].status).toBe('waiting_funds');
      advance(wait);
    }
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    const [sp] = await payments(m.mandateId);
    expect(sp).toMatchObject({ status: 'failed', attempts: 4, last_failure_code: 'insufficient_funds', needs_review: false });
    expect(await mandateRow(m.mandateId)).toMatchObject({ status: 'active' });
    expect(ctx.ledger.holds()).toHaveLength(0);
    expect(payerBalance(m.payer)).toBe(10_000);
    const failed = await eventsOf(ctx, 'scheduled_payment.failed', sp.id);
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({ failure_code: 'insufficient_funds', attempt: 4, period: '2026-03', amount_minor: 100_000 });
    expect(await eventsOf(ctx, 'scheduled_payment.insufficient_funds', sp.id)).toHaveLength(3);
    advance(30 * 24 * HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ processed: expect.any(Number) }); // el siguiente periodo es independiente
  });
});

describe('ejecución única por (mandato, periodo) (REQ-P5-6)', () => {
  it('el job corrido dos veces seguidas ejecuta una sola vez: un hold, un post, un asiento, un evento', async () => {
    const m = await dueMandate(ctx, { funds: 300_000, amount: 100_000 });
    await ctx.executor.runOnce();
    await ctx.executor.runOnce();
    const posted = ctx.ledger.calls.filter((c) => c.method === 'POST');
    expect(posted.map((c) => c.path.replace(/hd_[a-z0-9]+/, 'hd_*'))).toEqual(['/holds', '/holds/hd_*/post', '/transactions']);
    expect(payerBalance(m.payer)).toBe(200_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(await payments(m.mandateId)).toHaveLength(1);
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(1);
  });

  it.each([1, 2, 3, 4, 5])('corrida %i: 5 ejecutores simultáneos sobre 4 mandatos ⇒ cada periodo se ejecuta exactamente una vez', async () => {
    const mandates = await Promise.all(Array.from({ length: 4 }, () => dueMandate(ctx, { funds: 100_000, amount: 100_000 })));
    const summaries = await Promise.all(Array.from({ length: 5 }, () => ctx.executor.runOnce()));
    expect(summaries.reduce((n, s) => n + s.executed, 0)).toBe(4);
    for (const m of mandates) {
      const sps = await payments(m.mandateId);
      expect(sps).toHaveLength(1);
      expect(sps[0].status).toBe('executed');
      expect(payerBalance(m.payer)).toBe(0);
      expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    }
    expect(ctx.ledger.holds()).toHaveLength(4);
    expect((await eventsOf(ctx, 'scheduled_payment.executed')).length).toBe(4);
    expect(ctx.ledger.calls.filter((c) => c.method === 'POST' && c.path === '/transactions')).toHaveLength(4);
  });

  it('la base lo impide aunque el ejecutor falle: no hay dos pagos para el mismo (mandato, periodo)', async () => {
    const m = await dueMandate(ctx, { funds: 0 });
    await ctx.executor.runOnce();
    await expect(
      ctx.db.pool.query(`INSERT INTO scheduled_payments (id, mandate_id, period, due_on, next_attempt_at, created_at) VALUES ('sp_duplicadoabcdef', $1, '2026-03', '2026-03-10', now(), now())`, [m.mandateId]),
    ).rejects.toThrow(/scheduled_payments_period_uq/);
  });

  it('un ejecutor con el arriendo vigente no es pisado; al vencer el arriendo, otro retoma', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    await ctx.executor.runOnce(); // materializa y ejecuta
    const m2 = await dueMandate(ctx, { funds: 100_000 });
    await ctx.executor.runOnce();
    void m;
    // Simula un ejecutor caído a mitad: pago listo con arriendo vigente.
    await ctx.db.pool.query(`INSERT INTO scheduled_payments (id, mandate_id, period, due_on, next_attempt_at, lease_until, created_at) VALUES ('sp_arriendoabcdefgh', $1, '2026-02', '2026-02-10', $2, $3, $2)`, [m2.mandateId, ctx.clock.now, new Date(ctx.clock.now.getTime() + 60_000)]);
    ctx.ledger.fund('test', `merchant:${m2.payer}:available`, 100_000);
    expect(await ctx.executor.runOnce()).toMatchObject({ processed: 0 });
    advance(61_000);
    expect(await ctx.executor.runOnce()).toMatchObject({ processed: 1, executed: 1 });
  });
});

describe('periodos y calendario', () => {
  it('cada mes es un periodo propio y se ejecuta una vez; el mandato avanza su próxima fecha', async () => {
    const m = await dueMandate(ctx, { funds: 1_000_000, amount: 100_000 });
    await ctx.executor.runOnce();
    expect((await mandateRow(m.mandateId)).next_run_on).toBe('2026-04-10');
    advance(31 * 24 * HOUR);
    await ctx.executor.runOnce();
    advance(30 * 24 * HOUR);
    await ctx.executor.runOnce();
    const sps = await payments(m.mandateId);
    expect(sps.map((s) => [s.period, s.status])).toEqual([['2026-03', 'executed'], ['2026-04', 'executed'], ['2026-05', 'executed']]);
    expect(payerBalance(m.payer)).toBe(700_000);
  });

  it('no se adelanta: antes de la fecha de inicio no se materializa nada ni se toca el libro mayor', async () => {
    const payer = newMerchant();
    const beneficiary = newMerchant();
    await setMerchantStatus(ctx, payer, 'active');
    await setMerchantStatus(ctx, beneficiary, 'active');
    ctx.ledger.fund('test', `merchant:${payer}:available`, 500_000);
    const res = await createMandate(ctx, payer, mandateBody(beneficiary, {}, { start_date: '2026-03-20', day_of_month: 25 }));
    expect(res.status).toBe(201);
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 0, processed: 0 });
    ctx.clock.now = new Date('2026-03-25T03:59:59Z'); // en La Paz todavía es el 24
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 0 });
    ctx.clock.now = new Date('2026-03-25T04:00:00Z');
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 1, executed: 1 });
    expect(ctx.ledger.calls.length).toBeGreaterThan(0);
  });

  it('con fecha de fin: al ejecutar el último periodo el mandato queda `completed` y no hay más pagos', async () => {
    const payer = newMerchant();
    const beneficiary = newMerchant();
    await setMerchantStatus(ctx, payer, 'active');
    await setMerchantStatus(ctx, beneficiary, 'active');
    ctx.ledger.fund('test', `merchant:${payer}:available`, 1_000_000);
    const created = await createMandate(ctx, payer, mandateBody(beneficiary, { amount_minor: 100_000 }, { start_date: '2026-03-10', day_of_month: 10, end_date: '2026-04-30' }));
    const id = created.body.id as string;
    await ctx.executor.runOnce();
    advance(31 * 24 * HOUR);
    await ctx.executor.runOnce();
    expect(await mandateRow(id)).toEqual({ status: 'completed', next_run_on: null });
    advance(60 * 24 * HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 0, processed: 0 });
    expect(await payments(id)).toHaveLength(2);
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(2);
  });
});

describe('resultado ambiguo del libro mayor ≠ fallo (regla 11): se reintenta con la MISMA clave y nunca se anula', () => {
  it.each([
    ['la respuesta del hold se pierde (se creó, se cortó la conexión)', 'POST', '/holds', 'drop-after'],
    ['la conexión se corta antes de crear el hold', 'POST', '/holds', 'drop-before'],
    ['la confirmación del hold se pierde', 'POST', '/holds/', 'drop-after'],
    ['la liberación al beneficiario se aplica pero la respuesta se pierde', 'POST', '/transactions', 'drop-after'],
  ] as const)('%s ⇒ se reintenta y el dinero se mueve UNA vez', async (_name, method, pathPrefix, kind) => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    ctx.ledger.faults.push({ kind, when: (r) => r.method === method && (pathPrefix.endsWith('/') ? r.path.startsWith(pathPrefix) && r.path.endsWith('/post') : r.path === pathPrefix) });
    expect(await ctx.executor.runOnce()).toMatchObject({ processed: 1, executed: 0, retryLater: 1 });
    const [pending] = await payments(m.mandateId);
    expect(pending).toMatchObject({ status: 'due', attempts: 1, ledger_attempt: 1, last_failure_code: 'ledger_unavailable', needs_review: false });
    expect(voidCalls()).toEqual([]); // ni se anula ni se borra nada por la duda

    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'executed', attempts: 2, ledger_attempt: 1 });
    expect(ctx.ledger.holds()).toHaveLength(1);
    expect(payerBalance(m.payer)).toBe(0);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(ctx.ledger.balanceOf('test', `schedule:${m.mandateId}:reserve`)).toBe(0);
    // Las llamadas repetidas llevaron la MISMA clave.
    const byPath = new Map<string, Set<string>>();
    for (const c of ctx.ledger.calls.filter((c) => c.method === 'POST')) {
      const keyName = c.path.replace(/hd_[a-z0-9]+/, 'hd_*');
      byPath.set(keyName, (byPath.get(keyName) ?? new Set()).add(c.headers['idempotency-key'] ?? ''));
    }
    for (const [path, keys] of byPath) expect({ path, distinctKeys: keys.size }).toEqual({ path, distinctKeys: 1 });
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(1);
  });

  it.each([
    ['500 antes de aplicar', 500, false],
    ['503 después de aplicar', 503, true],
    ['502 con HTML', 502, false],
    ['404 sin el cuerpo del contrato', 404, false],
    ['403 de red', 403, false],
    ['200 con cuerpo que no es el contrato', 200, false],
  ])('%s sobre la confirmación del hold ⇒ ambiguo, se conserva el estado y se completa en el reintento', async (_name, status, applied) => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    ctx.ledger.faults.push({ kind: 'status', status, applied, body: status === 502 ? '<html>bad gateway</html>' : status === 200 ? { ok: true } : undefined, when: (r) => r.method === 'POST' && r.path.endsWith('/post') });
    expect(await ctx.executor.runOnce()).toMatchObject({ retryLater: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'due', phase: 'post', last_failure_code: 'ledger_unavailable' });
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect(ctx.ledger.holds()).toHaveLength(1);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(voidCalls()).toEqual([]);
  });

  it('libro mayor caído de forma persistente: al agotar la política queda `failed` `ledger_unavailable` A REVISIÓN, sin anular la retención', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    // Cae justo después de crear el hold: de ahí en adelante nada responde.
    ctx.ledger.faults.push({ kind: 'drop-after', when: (r) => r.path === '/holds' });
    const alwaysDown = () => ctx.ledger.faults.push({ kind: 'drop-before', when: () => true });
    for (const wait of [HOUR, 2 * HOUR, 4 * HOUR]) {
      await ctx.executor.runOnce();
      alwaysDown();
      advance(wait);
    }
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    const [sp] = await payments(m.mandateId);
    expect(sp).toMatchObject({ status: 'failed', last_failure_code: 'ledger_unavailable', needs_review: true });
    expect(ctx.ledger.holds()).toHaveLength(1); // la retención sigue ahí: la resuelve una persona
    expect(ctx.ledger.holds()[0].status).toBe('pending');
    expect(voidCalls()).toEqual([]);
    const [failed] = await eventsOf(ctx, 'scheduled_payment.failed', sp.id);
    expect(failed.data.failure_code).toBe('ledger_unavailable');
  });

  it('una retención ya resuelta por otro (409 + consulta autoritativa distinta de `posted`) ⇒ `failed` `invalid_state_transition` a revisión', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-before', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    ctx.ledger.holds()[0].status = 'voided';
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'invalid_state_transition', needs_review: true });
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(0);
  });

  it('un rechazo `validation_failed` del libro mayor es un defecto nuestro: `failed` `internal_error`, sin reintentos ciegos', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    ctx.ledger.faults.push({ kind: 'status', status: 422, applied: false, body: { type: 'x', title: 'x', status: 422, code: 'validation_failed' }, when: (r) => r.path === '/holds' });
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'internal_error' });
  });

  it('un 422 sin el cuerpo exacto del contrato NO se toma por «sin fondos»: es ambiguo', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    ctx.ledger.faults.push({ kind: 'status', status: 422, applied: false, body: 'texto', when: (r) => r.path === '/holds' });
    expect(await ctx.executor.runOnce()).toMatchObject({ retryLater: 1, waitingFunds: 0 });
    expect((await mandateRow(m.mandateId)).status).toBe('active');
    expect(await eventsOf(ctx, 'scheduled_payment.insufficient_funds')).toHaveLength(0);
  });

  it('sin fondos pero el saldo no se puede consultar: no se avisa con datos inventados; se reintenta el MISMO attempt (devuelve el mismo rechazo)', async () => {
    const m = await dueMandate(ctx, { funds: 10_000, amount: 100_000 });
    ctx.ledger.faults.push({ kind: 'status', status: 500, applied: false, when: (r) => r.method === 'GET' && r.path === '/balances' });
    expect(await ctx.executor.runOnce()).toMatchObject({ retryLater: 1, waitingFunds: 0 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ ledger_attempt: 1, attempts: 1, status: 'due' });
    expect(await eventsOf(ctx, 'scheduled_payment.insufficient_funds')).toHaveLength(0);
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ waitingFunds: 1 });
    expect((await eventsOf(ctx, 'scheduled_payment.insufficient_funds'))[0].data.available_minor).toBe(10_000);
    expect((await payments(m.mandateId))[0]).toMatchObject({ ledger_attempt: 2, attempts: 2 });
  });
});

describe('comercio suspendido o cerrado', () => {
  it('un pagador suspendido no ejecuta: `failed` `merchant_suspended` sin tocar el libro mayor', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    await setMerchantStatus(ctx, m.payer, 'suspended', new Date('2026-03-01T00:00:00Z'));
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: false });
    expect(ctx.ledger.calls).toEqual([]);
    expect(payerBalance(m.payer)).toBe(100_000);
    expect((await eventsOf(ctx, 'scheduled_payment.failed'))[0].data.failure_code).toBe('merchant_suspended');
  });

  it('suspendido DESPUÉS de reservar: nada se libera ni se anula solo; queda a revisión con el dinero en la reserva', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-before', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    await setMerchantStatus(ctx, m.payer, 'closed', new Date('2026-03-11T00:00:00Z'));
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: true });
    expect(ctx.ledger.holds()[0].status).toBe('pending');
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(0);
    expect(voidCalls()).toEqual([]);
  });

  it('un comercio desconocido para la réplica (evento todavía sin llegar) no bloquea: manda lo que autenticó pay-edge', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    await ctx.db.pool.query('DELETE FROM merchant_replica WHERE merchant_id = $1', [m.payer]);
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
  });
});

describe('beneficiario suspendido, cerrado o inexistente: no se le acredita nada', () => {
  const credits = (beneficiary: string) =>
    ctx.ledger.calls.filter((c) => c.method === 'POST' && c.path === '/transactions' && c.body.legs.some((l: { credit_account: string }) => l.credit_account === `merchant:${beneficiary}:available`));

  it.each([
    ['suspendido', 'suspended'],
    ['cerrado', 'closed'],
    ['inexistente en la réplica', null],
  ] as const)('beneficiario %s ANTES de reservar ⇒ `failed` `merchant_suspended`, sin tocar el libro mayor y sin revisión (no hay dinero en vuelo)', async (_name, status) => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    if (status) await setMerchantStatus(ctx, m.beneficiary, status, new Date('2026-03-09T00:00:00Z'));
    else await ctx.db.pool.query('DELETE FROM merchant_replica WHERE merchant_id = $1', [m.beneficiary]);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1, executed: 0 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: false, hold_id: null });
    expect(ctx.ledger.calls).toEqual([]);
    expect(payerBalance(m.payer)).toBe(100_000);
    const [notice] = await eventsOf(ctx, 'scheduled_payment.failed');
    expect(notice.data).toMatchObject({ failure_code: 'merchant_suspended', merchant_id: m.payer, amount_minor: 100_000 });
    expect(JSON.stringify(notice)).not.toContain(m.beneficiary); // el aviso al pagador no nombra al beneficiario
  });

  it('beneficiario activo ⇒ se paga (control)', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect(credits(m.beneficiary)).toHaveLength(1);
  });

  it('se suspende ENTRE la retención y la confirmación: se anula la retención (void), queda a revisión y no se acredita', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-before', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    expect((await payments(m.mandateId))[0]).toMatchObject({ phase: 'post', status: 'due' });
    expect(payerBalance(m.payer)).toBe(100_000);
    expect(ctx.ledger.holds()[0].status).toBe('pending');

    await setMerchantStatus(ctx, m.beneficiary, 'suspended', new Date('2026-03-11T00:00:00Z'));
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: true });
    expect(ctx.ledger.holds()[0].status).toBe('voided');
    expect(ctx.ledger.calls.filter((c) => c.path.endsWith('/void'))).toHaveLength(1);
    expect(ctx.ledger.calls.filter((c) => c.path === '/transactions')).toHaveLength(0);
    expect(credits(m.beneficiary)).toHaveLength(0);
    expect(payerBalance(m.payer)).toBe(100_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(0);
    expect((await eventsOf(ctx, 'scheduled_payment.failed'))[0].data.failure_code).toBe('merchant_suspended');
  });

  it('se suspende DESPUÉS de confirmar hacia la reserva: asiento inverso al pagador (el void ya no existe), a revisión, sin acreditar', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-before', when: (r) => r.path === '/transactions' });
    await ctx.executor.runOnce();
    expect((await payments(m.mandateId))[0]).toMatchObject({ phase: 'release' });
    expect(ctx.ledger.balanceOf('test', `schedule:${m.mandateId}:reserve`)).toBe(100_000);

    await setMerchantStatus(ctx, m.beneficiary, 'closed', new Date('2026-03-11T00:00:00Z'));
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: true });
    // La única orden de liberación al beneficiario fue la que se cortó ANTES de aplicarse; tras la suspensión no se emitió otra.
    expect(credits(m.beneficiary)).toHaveLength(1);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(0);
    expect(ctx.ledger.balanceOf('test', `schedule:${m.mandateId}:reserve`)).toBe(0);
    expect(payerBalance(m.payer)).toBe(100_000);
    const reversal = ctx.ledger.calls.find((c) => c.path === '/transactions' && c.body.business_ref.endsWith(':reverse'));
    expect(reversal?.body.legs).toEqual([{ debit_account: `schedule:${m.mandateId}:reserve`, credit_account: `merchant:${m.payer}:available`, amount_minor: 100_000, code: 'release' }]);
  });

  it('resultado AMBIGUO del void ⇒ no se asume nada: se reintenta con la MISMA clave y termina anulada una sola vez', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-before', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    await setMerchantStatus(ctx, m.beneficiary, 'suspended', new Date('2026-03-11T00:00:00Z'));
    ctx.ledger.faults.push({ kind: 'drop-after', when: (r) => r.path.endsWith('/void') }); // se anula pero la respuesta se pierde
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ retryLater: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'due', phase: 'void', needs_review: false });
    advance(2 * HOUR); // ya van dos intentos: la política espera 2 h
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: true });
    const voids = ctx.ledger.calls.filter((c) => c.path.endsWith('/void'));
    expect(voids).toHaveLength(2);
    expect(new Set(voids.map((c) => c.headers['idempotency-key'])).size).toBe(1);
    expect(ctx.ledger.holds()).toHaveLength(1);
    expect(credits(m.beneficiary)).toHaveLength(0);
  });

  it('void ⇒ 409 porque la confirmación SÍ se había aplicado (respuesta perdida): consulta autoritativa y asiento inverso', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-after', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    expect(ctx.ledger.holds()[0].status).toBe('posted');
    expect((await payments(m.mandateId))[0]).toMatchObject({ phase: 'post' });
    await setMerchantStatus(ctx, m.beneficiary, 'suspended', new Date('2026-03-11T00:00:00Z'));
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended', needs_review: true });
    expect(payerBalance(m.payer)).toBe(100_000);
    expect(ctx.ledger.balanceOf('test', `schedule:${m.mandateId}:reserve`)).toBe(0);
    expect(credits(m.beneficiary)).toHaveLength(0);
  });

  it('comisión hacia la plataforma: NO se consulta el estado de comercio del beneficiario (aunque no esté en la réplica); sí el del pagador', async () => {
    await ctx.db.pool.query('DELETE FROM merchant_replica WHERE merchant_id = $1', [PLATFORM_MERCHANT]);
    const ok = await dueMandate(ctx, { funds: 100_000, amount: 25_000, kind: 'pay_commission', beneficiary: PLATFORM_MERCHANT });
    await ctx.db.pool.query('DELETE FROM merchant_replica WHERE merchant_id = $1', [PLATFORM_MERCHANT]);
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect(ctx.ledger.balanceOf('test', 'platform:fees')).toBe(25_000);
    void ok;
    const blocked = await dueMandate(ctx, { funds: 100_000, amount: 25_000, kind: 'pay_commission', beneficiary: PLATFORM_MERCHANT });
    await setMerchantStatus(ctx, blocked.payer, 'suspended', new Date('2026-03-10T00:00:00Z'));
    await ctx.db.pool.query('DELETE FROM merchant_replica WHERE merchant_id = $1', [PLATFORM_MERCHANT]);
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1 });
    expect((await payments(blocked.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'merchant_suspended' });
  });
});

describe('cancelación', () => {
  it('cancelar antes de ejecutar: el pago pendiente se cancela sin tocar el libro mayor y no se materializa nada más', async () => {
    const m = await dueMandate(ctx, { funds: 10_000, amount: 100_000 });
    await ctx.executor.runOnce(); // sin fondos: queda esperando
    expect((await pub(ctx, 'delete', `/mandates/${m.mandateId}`, m.payer)).status).toBe(204);
    expect((await payments(m.mandateId))[0].status).toBe('canceled');
    const callsBefore = ctx.ledger.calls.length;
    ctx.ledger.fund('test', `merchant:${m.payer}:available`, 500_000);
    advance(31 * 24 * HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 0, processed: 0 });
    expect(ctx.ledger.calls.length).toBe(callsBefore);
  });

  it('un pago que ya tiene dinero retenido se COMPLETA aunque se cancele el mandato; lo ya ejecutado no se deshace', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    ctx.ledger.faults.push({ kind: 'drop-before', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    expect((await payments(m.mandateId))[0]).toMatchObject({ phase: 'post' });
    expect((await pub(ctx, 'delete', `/mandates/${m.mandateId}`, m.payer)).status).toBe(204);
    expect((await payments(m.mandateId))[0].status).toBe('due');
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect((await mandateRow(m.mandateId)).status).toBe('canceled');
  });
});

describe('comisiones programadas de proveedores (7.8, REQ-P5-7)', () => {
  it('a la fecha del corte el proveedor paga su comisión a AloVida: asiento a `platform:fees` con código `fee`, una sola vez', async () => {
    const provider = newMerchant();
    await setMerchantStatus(ctx, provider, 'active');
    ctx.ledger.fund('test', `merchant:${provider}:available`, 80_000);
    const created = await createMandate(ctx, provider, mandateBody(PLATFORM_MERCHANT, { kind: 'pay_commission', amount_minor: 25_000 }, { start_date: '2026-03-16', day_of_month: 16 }));
    expect(created.status).toBe(201);
    // Antes del corte no pasa nada.
    expect(await ctx.executor.runOnce()).toMatchObject({ materialized: 0, processed: 0 });
    ctx.clock.now = new Date('2026-03-16T12:00:00Z');
    await Promise.all([ctx.executor.runOnce(), ctx.executor.runOnce()]);
    await ctx.executor.runOnce();
    expect(ctx.ledger.balanceOf('test', 'platform:fees')).toBe(25_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${provider}:available`)).toBe(55_000);
    const tx = ctx.ledger.calls.find((c) => c.method === 'POST' && c.path === '/transactions');
    expect(tx?.body.legs).toEqual([{ debit_account: `schedule:${created.body.id}:reserve`, credit_account: 'platform:fees', amount_minor: 25_000, code: 'fee' }]);
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(1);
  });

  it('una comisión sin fondos del proveedor se comporta igual que una obligación: espera, avisa y reintenta', async () => {
    const m = await dueMandate(ctx, { funds: 1000, amount: 25_000, kind: 'pay_commission', beneficiary: PLATFORM_MERCHANT });
    await ctx.executor.runOnce();
    expect((await payments(m.mandateId))[0].status).toBe('waiting_funds');
    expect(ctx.ledger.balanceOf('test', 'platform:fees')).toBe(0);
    expect(await eventsOf(ctx, 'scheduled_payment.insufficient_funds')).toHaveLength(1);
  });
});

describe('modo test / live (D-28)', () => {
  it('cada llamada al libro mayor lleva el modo del mandato; los saldos de test y de live no se mezclan', async () => {
    const live = await dueMandate(ctx, { funds: 0, amount: 100_000, mode: 'live' });
    ctx.ledger.fund('test', `merchant:${live.payer}:available`, 500_000); // fondos solo en `test`
    await ctx.executor.runOnce();
    expect((await payments(live.mandateId))[0].status).toBe('waiting_funds');
    expect(ctx.ledger.calls.every((c) => c.headers['x-pay-mode'] === 'live')).toBe(true);
    expect(ctx.ledger.balanceOf('test', `merchant:${live.payer}:available`)).toBe(500_000);

    ctx.ledger.fund('live', `merchant:${live.payer}:available`, 100_000);
    advance(HOUR);
    await ctx.executor.runOnce();
    expect((await payments(live.mandateId))[0].status).toBe('executed');
    expect(ctx.ledger.balanceOf('live', `merchant:${live.beneficiary}:available`)).toBe(100_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${live.beneficiary}:available`)).toBe(0);
  });
});

describe('aviso (P5.H3.M6): solo ids y montos, nada sensible', () => {
  it('todos los eventos del flujo cumplen el AsyncAPI (sin campos de más) y no llevan descripciones ni datos de personas; los logs tampoco', async () => {
    const m = await dueMandate(ctx, { funds: 10_000, amount: 100_000 });
    await ctx.executor.runOnce();
    ctx.ledger.fund('test', `merchant:${m.payer}:available`, 100_000);
    advance(HOUR);
    await ctx.executor.runOnce();
    await pub(ctx, 'delete', `/mandates/${m.mandateId}`, m.payer);
    const all = (await rows(ctx, 'SELECT type, envelope::text AS e FROM outbox_events ORDER BY seq')) as { type: string; e: string }[];
    expect(all.map((r) => r.type)).toEqual(['mandate.created', 'scheduled_payment.insufficient_funds', 'scheduled_payment.executed', 'mandate.canceled']);
    for (const { type, e } of all) {
      expect({ type, leaks: /Obligación|descripci|nombre|document|cuenta/i.test(e) }).toEqual({ type, leaks: false });
      expect(Object.keys(JSON.parse(e).data).every((k) => /(_id|_minor|_at|_on|period|currency|status|kind|frequency|day_of_month|attempt|date)$/.test(k))).toBe(true);
    }
    await eventsOf(ctx, 'mandate.created');
    await eventsOf(ctx, 'scheduled_payment.insufficient_funds');
    await eventsOf(ctx, 'scheduled_payment.executed');
    await eventsOf(ctx, 'mandate.canceled');
    expect(ctx.logs.join('\n')).not.toMatch(/Obligación|merchant:mc_|schedule:md_/);
  });

  it('si el libro mayor no devuelve el id de la transferencia: el dinero se mueve, el pago queda `executed` A REVISIÓN y no se emite un evento inválido', async () => {
    ctx.ledger.includeTransferIds = false;
    const m = await dueMandate(ctx, { funds: 100_000, amount: 100_000 });
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'executed', needs_review: true, ledger_transfer_id: null });
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(0);
  });
});
