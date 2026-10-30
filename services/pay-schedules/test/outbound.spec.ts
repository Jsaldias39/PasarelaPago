import type { LedgerClient } from '../src/ledger/ledger.client';
import { createTestContext, PLATFORM_MERCHANT, type TestContext } from './support/app';
import { dueMandate, eventsOf, rows, setMerchantStatus } from './support/http';

/**
 * Auditoría de las llamadas SALIENTES de pay-schedules (D-28). pay-schedules habla con UN solo servicio: `pay-ledger`
 * (holds, post, void, get, transactions, balances). No llama a `pay-payments` (ver DECISIONES-TOMADAS D5-32) ni a `pay-settlement`.
 * Cada llamada tiene que llevar `X-Service-Id: pay-schedules`, `X-Pay-Mode` = el del mandato y, si muta, `Idempotency-Key`; el doble
 * valida cada petición contra `contracts/openapi/internal-ledger-v1.yaml`.
 */
let ctx: TestContext;
afterEach(async () => {
  const violations = ctx.ledger.violations;
  await ctx.close();
  expect(violations).toEqual([]);
});

const HOUR = 3600_000;
const advance = (ms: number) => (ctx.clock.now = new Date(ctx.clock.now.getTime() + ms));
const payments = (mandateId: string) => rows(ctx, 'SELECT * FROM scheduled_payments WHERE mandate_id = $1 ORDER BY period', [mandateId]);
const op = (c: { method: string; path: string }) => `${c.method} ${c.path.replace(/hd_[a-z0-9]+/, 'hd_*')}`;

function assertOutbound(mode: string, wanted: string[]): void {
  const seen = new Set(ctx.ledger.calls.map(op));
  for (const expected of wanted) expect({ expected, seen: [...seen].sort() }).toEqual({ expected, seen: expect.arrayContaining([expected]) });
  for (const call of ctx.ledger.calls) {
    expect({ op: op(call), service: call.headers['x-service-id'], mode: call.headers['x-pay-mode'] }).toEqual({ op: op(call), service: 'pay-schedules', mode });
    if (call.method === 'POST') expect({ op: op(call), key: call.headers['idempotency-key'] }).toEqual({ op: op(call), key: expect.stringMatching(/^sp_[a-z0-9]{10,40}:(reserve|post|void|release|reverse)(:\d+)?$/) });
  }
}

describe.each(['test', 'live'] as const)('cada llamada saliente al libro mayor propaga servicio y modo del mandato (%s)', (mode) => {
  beforeEach(async () => {
    ctx = await createTestContext();
    await setMerchantStatus(ctx, PLATFORM_MERCHANT, 'active');
  });

  it('retención, confirmación y liberación (POST /holds, /holds/{id}/post, /transactions)', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, mode });
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    assertOutbound(mode, ['POST /holds', 'POST /holds/hd_*/post', 'POST /transactions']);
    expect((await eventsOf(ctx, 'scheduled_payment.executed'))[0].data.mode).toBe(mode);
    expect(ctx.ledger.balanceOf(mode, `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(ctx.ledger.balanceOf(mode === 'test' ? 'live' : 'test', `merchant:${m.beneficiary}:available`)).toBe(0);
  });

  it('consulta de saldo para el aviso (GET /balances)', async () => {
    await dueMandate(ctx, { funds: 10_000, mode });
    await ctx.executor.runOnce();
    assertOutbound(mode, ['POST /holds', 'GET /balances']);
  });

  it('anulación de la retención (POST /holds/{id}/void) y consulta autoritativa (GET /holds/{id})', async () => {
    const m = await dueMandate(ctx, { funds: 100_000, mode });
    ctx.ledger.faults.push({ kind: 'drop-after', when: (r) => r.path.endsWith('/post') });
    await ctx.executor.runOnce();
    await setMerchantStatus(ctx, m.beneficiary, 'suspended', new Date('2026-03-11T00:00:00Z'));
    advance(HOUR);
    await ctx.executor.runOnce(); // void ⇒ 409 (la confirmación sí se aplicó) ⇒ GET ⇒ asiento inverso
    assertOutbound(mode, ['POST /holds', 'POST /holds/hd_*/post', 'POST /holds/hd_*/void', 'GET /holds/hd_*', 'POST /transactions']);
    const reversal = ctx.ledger.calls.find((c) => c.path === '/transactions' && c.body.business_ref.endsWith(':reverse'));
    expect(reversal?.body.legs[0].code).toBe('adjustment');
  });
});

describe('sin modo el libro mayor responde 403: el pago NO se cuenta como ejecutado ni queda en un estado terminal erróneo (regla 11)', () => {
  let mode: string | undefined = undefined;
  const withoutMode = (inner: LedgerClient): LedgerClient => {
    const forced = () => mode as string;
    return {
      createHold: (_m, k, r) => inner.createHold(forced(), k, r),
      postHold: (_m, k, id) => inner.postHold(forced(), k, id),
      voidHold: (_m, k, id) => inner.voidHold(forced(), k, id),
      getHold: (_m, id) => inner.getHold(forced(), id),
      createTransaction: (_m, k, r) => inner.createTransaction(forced(), k, r),
      balance: (_m, a) => inner.balance(forced(), a),
    };
  };
  beforeEach(async () => {
    mode = '';
    ctx = await createTestContext({ wrapLedger: withoutMode });
  });

  it.each([[''], ['sandbox'], ['prod'], ['LIVE']])('modo %p: se rechaza, se reintenta con la misma clave y al volver el modo se ejecuta UNA vez', async (bad) => {
    mode = bad;
    const m = await dueMandate(ctx, { funds: 100_000 });
    expect(await ctx.executor.runOnce()).toMatchObject({ processed: 1, executed: 0, failed: 0, retryLater: 1 });
    let [sp] = await payments(m.mandateId);
    expect(sp).toMatchObject({ status: 'due', phase: 'hold', attempts: 1, ledger_attempt: 1, last_failure_code: 'ledger_unavailable', needs_review: false, hold_id: null, ledger_transaction_id: null });
    expect(ctx.ledger.rejectedForMode).toEqual(['POST /holds']);
    expect(ctx.ledger.holds()).toHaveLength(0);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.payer}:available`)).toBe(100_000);
    expect(await rows(ctx, `SELECT 1 FROM outbox_events WHERE type LIKE 'scheduled_payment.%'`)).toHaveLength(0);

    // Segundo intento, todavía sin modo: misma clave, sin efectos, sin estado terminal.
    advance(HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ retryLater: 1, failed: 0 });
    [sp] = await payments(m.mandateId);
    expect(sp).toMatchObject({ status: 'due', attempts: 2, ledger_attempt: 1 });
    const keys = new Set(ctx.ledger.calls.map((c) => c.headers['idempotency-key']));
    expect(keys.size).toBe(1);

    // Se corrige el modo: el mismo pago se ejecuta una sola vez.
    mode = 'test';
    advance(2 * HOUR);
    expect(await ctx.executor.runOnce()).toMatchObject({ executed: 1 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'executed', attempts: 3, needs_review: false });
    expect(ctx.ledger.holds()).toHaveLength(1);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(100_000);
    expect(await eventsOf(ctx, 'scheduled_payment.executed')).toHaveLength(1);
  });

  it('si el modo no vuelve nunca: al agotar la política queda `failed` `ledger_unavailable` A REVISIÓN (lo mira una persona); nada se ejecuta ni se anula', async () => {
    const m = await dueMandate(ctx, { funds: 100_000 });
    for (const wait of [HOUR, 2 * HOUR, 4 * HOUR]) {
      await ctx.executor.runOnce();
      expect((await payments(m.mandateId))[0].status).toBe('due');
      advance(wait);
    }
    expect(await ctx.executor.runOnce()).toMatchObject({ failed: 1, executed: 0 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'failed', last_failure_code: 'ledger_unavailable', needs_review: true, ledger_transaction_id: null });
    expect(ctx.ledger.holds()).toHaveLength(0);
    expect(ctx.ledger.calls.filter((c) => /void/.test(c.path))).toEqual([]);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.payer}:available`)).toBe(100_000);
    expect(ctx.ledger.balanceOf('test', `merchant:${m.beneficiary}:available`)).toBe(0);
    expect(ctx.ledger.rejectedForMode.length).toBe(4);
  });

  it('sin modo en la consulta de saldo del aviso: no se emite un aviso con datos inventados (queda reintento)', async () => {
    mode = 'test';
    const m = await dueMandate(ctx, { funds: 10_000 });
    // La retención lleva modo; el saldo del aviso no (el cliente envuelto falla solo en `balance`).
    ctx.ledger.faults.push({ kind: 'status', status: 403, applied: false, body: { type: 'x', title: 'x', status: 403, code: 'forbidden' }, when: (r) => r.method === 'GET' && r.path === '/balances' });
    expect(await ctx.executor.runOnce()).toMatchObject({ retryLater: 1, waitingFunds: 0 });
    expect((await payments(m.mandateId))[0]).toMatchObject({ status: 'due', ledger_attempt: 1 });
    expect(await eventsOf(ctx, 'scheduled_payment.insufficient_funds')).toHaveLength(0);
  });
});
