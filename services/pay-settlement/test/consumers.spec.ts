import { newCloudEvent } from '@pay/outbox';
import { type SettlementTestContext, createSettlementContext, key, merchantId, operatorToken } from './helpers/app';
import { loadEventValidators } from './helpers/events-contract';
import { feeSchedule, transferPosted } from './helpers/scenarios';

/**
 * Los consumidores de eventos de pay-settlement (ledger.transfer.posted, fee_schedule.published, payment_intent.contradiction_detected) usan inbox
 * (`processOnce`: efecto único por `(consumidor, evento)`) y toleran entrega repetida, concurrente y en cualquier orden. Sin red: se alimenta
 * `SettlementConsumers.handle` con eventos que cumplen el AsyncAPI real (el cableado con NATS lo prueba `nats.spec`).
 */
let ctx: SettlementTestContext;
let payments: Awaited<ReturnType<typeof loadEventValidators>>;
beforeAll(async () => {
  payments = await loadEventValidators('payments.yaml');
});
beforeEach(async () => {
  ctx = await createSettlementContext();
});
afterEach(async () => ctx.close());

const count = async (sql: string, params: unknown[] = []) => Number((await ctx.db.pool.query(sql, params)).rows[0].n);
const inbox = (consumer: string) => count('SELECT count(*) AS n FROM inbox_events WHERE consumer = $1', [consumer]);
const pi = () => `pi_${Math.random().toString(36).slice(2, 14).padEnd(12, 'k')}`;

type Mode = 'test' | 'live';
function contradiction(over: { id?: string; paymentIntent?: string; merchant?: string; kind?: string; current?: string; incoming?: string; mode?: Mode | null; detectedAt?: string } = {}) {
  const paymentIntent = over.paymentIntent ?? pi();
  const merchant = over.merchant ?? merchantId();
  const event = newCloudEvent({
    source: '/pay-payments',
    type: 'payment_intent.contradiction_detected',
    subject: paymentIntent,
    merchantId: merchant,
    data: {
      payment_intent_id: paymentIntent,
      merchant_id: merchant,
      kind: over.kind ?? 'status_conflict',
      current_status: over.current ?? 'failed',
      incoming_status: over.incoming ?? 'captured',
      ...(over.mode === null ? {} : { mode: over.mode ?? 'test' }),
      detected_at: over.detectedAt ?? '2026-10-27T15:00:00.000Z',
    },
  });
  return over.id ? { ...event, id: over.id } : event;
}
const rows = async () => (await ctx.db.pool.query('SELECT kind, mode, run_id, connector, merchant_id, payment_intent_id, status, source_detail FROM settlement_exceptions ORDER BY created_at, id')).rows;
const moneyUntouched = async () => {
  expect(ctx.ledger.calls).toEqual([]);
  expect(ctx.connectors.orders).toEqual([]);
  expect(await count('SELECT count(*) AS n FROM settlement_payouts')).toBe(0);
  expect(await count('SELECT count(*) AS n FROM settlement_charges')).toBe(0);
  expect(await count('SELECT count(*) AS n FROM outbox_events')).toBe(0);
};

describe('payment_intent.contradiction_detected (pay-payments → pay-settlement, ola 2)', () => {
  it('correcto: un evento válido abre UNA excepción de conciliación con el detalle, visible solo en su modo, y no mueve dinero', async () => {
    const e = contradiction({ mode: 'live' });
    expect((payments.get('payment_intent.contradiction_detected') as (v: unknown) => string[])(e)).toEqual([]);
    expect(await ctx.consumers.handle(e)).toBe('processed');
    expect(await rows()).toEqual([
      {
        kind: 'payment_contradiction',
        mode: 'live',
        run_id: null,
        connector: null,
        merchant_id: e.data.merchant_id,
        payment_intent_id: e.data.payment_intent_id,
        status: 'open',
        source_detail: { kind: 'status_conflict', current_status: 'failed', incoming_status: 'captured', detected_at: '2026-10-27T15:00:00.000Z' },
      },
    ]);
    expect(await inbox('pay-settlement.payment_intent.contradiction_detected')).toBe(1);
    const mine = await ctx.as('pay-console', 'live').get('/reconciliation_exceptions?status=open');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ object: 'reconciliation_exception', kind: 'payment_contradiction', run_id: null, status: 'open', payment_intent_id: e.data.payment_intent_id, merchant_id: e.data.merchant_id });
    expect((await ctx.as('pay-console', 'test').get('/reconciliation_exceptions?status=open')).body.data).toEqual([]);
    await moneyUntouched();
  });

  it('la lista con una contradicción difiere del contrato SOLO en `kind` y `run_id` (propuesta de contrato; si el contrato ya los admite, esta prueba sigue verde)', async () => {
    await ctx.consumers.handle(contradiction());
    const res = await ctx.as('pay-console', 'test').get('/reconciliation_exceptions');
    const errors = ctx.settlementContract.validateResponse({ method: 'GET', path: '/reconciliation_exceptions', status: 200, body: res.body });
    expect(errors.filter((x) => !/kind|run_id/.test(x))).toEqual([]);
  });

  it('duplicado: el mismo evento dos veces tiene efecto una vez; el mismo hecho con OTRO id de evento tampoco abre otra excepción', async () => {
    const paymentIntent = pi();
    const e = contradiction({ paymentIntent });
    expect(await ctx.consumers.handle(e)).toBe('processed');
    expect(await ctx.consumers.handle(e)).toBe('duplicate');
    expect(await ctx.consumers.handle(contradiction({ paymentIntent, merchant: e.data.merchant_id as string }))).toBe('processed'); // otro id: el inbox lo deja pasar…
    expect(await rows()).toHaveLength(1); // …pero es el mismo hecho: una sola excepción
    expect(await inbox('pay-settlement.payment_intent.contradiction_detected')).toBe(2);
  });

  it('hechos distintos del mismo cobro (otro kind, otro estado o otro instante) abren excepciones distintas', async () => {
    const paymentIntent = pi();
    const merchant = merchantId();
    for (const over of [{}, { kind: 'charge_outcome_unknown', incoming: 'ambiguous' }, { incoming: 'refunded' }, { detectedAt: '2026-10-27T16:00:00.000Z' }]) {
      expect(await ctx.consumers.handle(contradiction({ paymentIntent, merchant, ...over }))).toBe('processed');
    }
    expect(await rows()).toHaveLength(4);
  });

  it('concurrencia: el mismo evento entregado 10 veces a la vez ⇒ 1 procesado, 9 duplicados, 1 excepción', async () => {
    const e = contradiction();
    const results = await Promise.all(Array.from({ length: 10 }, () => ctx.consumers.handle(e)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(9);
    expect(await rows()).toHaveLength(1);
  });

  it('desorden: el orden de llegada de dos hechos del mismo cobro no cambia el resultado', async () => {
    const outcome = async (order: 'asc' | 'desc') => {
      await ctx.db.pool.query('DELETE FROM settlement_exceptions');
      await ctx.db.pool.query('DELETE FROM inbox_events');
      const paymentIntent = 'pi_desordenok1234';
      const merchant = 'mc_desordenok1234';
      const a = contradiction({ id: 'a1111111-0000-0000-0000-000000000001', paymentIntent, merchant, incoming: 'captured', detectedAt: '2026-10-27T15:00:00.000Z' });
      const b = contradiction({ id: 'b2222222-0000-0000-0000-000000000002', paymentIntent, merchant, incoming: 'refunded', detectedAt: '2026-10-27T15:05:00.000Z' });
      for (const e of order === 'asc' ? [a, b] : [b, a]) await ctx.consumers.handle(e);
      return (await ctx.db.pool.query('SELECT source_detail FROM settlement_exceptions ORDER BY source_detail->>\'detected_at\'')).rows;
    };
    const asc = await outcome('asc');
    expect(asc).toHaveLength(2);
    expect(await outcome('desc')).toEqual(asc);
  });

  it('límite: sin `mode` (el productor aún no lo informa) la excepción queda con modo desconocido, se ve desde los dos modos y se puede resolver desde cualquiera; nunca se asume live', async () => {
    await ctx.consumers.handle(contradiction({ mode: null }));
    expect((await rows())[0].mode).toBeNull();
    for (const mode of ['test', 'live'] as const) expect((await ctx.as('pay-console', mode).get('/reconciliation_exceptions?status=open')).body.data).toHaveLength(1);
    const id = (await ctx.as('pay-console', 'test').get('/reconciliation_exceptions?status=open')).body.data[0].id as string;
    const res = await ctx.as('pay-console', 'live').post(`/reconciliation_exceptions/${id}/resolve`, { resolution: 'dismiss', note: 'Revisado: sin efecto' }).set('idempotency-key', key()).set('authorization', `Bearer ${operatorToken(['settlement_operator'])}`);
    expect(res.status).toBe(200);
    for (const mode of ['test', 'live'] as const) expect((await ctx.as('pay-console', mode).get('/reconciliation_exceptions?status=open')).body.data).toEqual([]);
  });

  it('una contradicción con modo no se resuelve desde el otro modo (404) y sigue abierta', async () => {
    await ctx.consumers.handle(contradiction({ mode: 'test' }));
    const id = (await ctx.as('pay-console', 'test').get('/reconciliation_exceptions?status=open')).body.data[0].id as string;
    const cross = await ctx.as('pay-console', 'live').post(`/reconciliation_exceptions/${id}/resolve`, { resolution: 'dismiss', note: 'cruzado' }).set('idempotency-key', key()).set('authorization', `Bearer ${operatorToken(['settlement_admin'])}`);
    expect(cross.status).toBe(404);
    expect((await rows())[0].status).toBe('open');
  });

  it('resolver es una decisión de una persona y NO toca el ledger: request_adjustment solo deja un pedido', async () => {
    await ctx.consumers.handle(contradiction({ kind: 'compensation_failed', incoming: 'compensation_failed' }));
    const id = (await ctx.as('pay-console', 'test').get('/reconciliation_exceptions?status=open')).body.data[0].id as string;
    const res = await ctx.as('pay-console', 'test').post(`/reconciliation_exceptions/${id}/resolve`, { resolution: 'request_adjustment', note: 'Corresponde revisar la compensación' }).set('idempotency-key', key()).set('authorization', `Bearer ${operatorToken(['settlement_admin'], { sub: 'op_carla02' })}`);
    expect(res.body).toMatchObject({ status: 'resolved', resolved_by: 'op_carla02' });
    expect(await count('SELECT count(*) AS n FROM settlement_adjustment_requests')).toBe(1);
    await moneyUntouched();
  });

  it.each([
    ['payment_intent_id mal formado', { payment_intent_id: 'xx' }],
    ['sin merchant_id', { merchant_id: undefined }],
    ['kind en mayúsculas', { kind: 'Status_Conflict' }],
    ['estado de 41 caracteres', { current_status: 'x'.repeat(41) }],
    ['modo fuera de test|live', { mode: 'sandbox' }],
    ['fecha ilegible', { detected_at: 'ayer' }],
    ['campo faltante current_status', { current_status: undefined }],
  ])('inválido (%s): se descarta sin abrir nada ni dejar rastro en el inbox', async (_n, patch) => {
    const e = contradiction();
    expect(await ctx.consumers.handle({ ...e, data: { ...e.data, ...patch } })).toBe('invalid');
    expect(await rows()).toEqual([]);
    expect(await inbox('pay-settlement.payment_intent.contradiction_detected')).toBe(0);
  });

  it('un evento con ese tipo pero de otro origen se ignora', async () => {
    expect(await ctx.consumers.handle({ ...contradiction(), source: '/pay-ledger' })).toBe('ignored');
    expect(await rows()).toEqual([]);
  });
});

describe('ledger.transfer.posted: inbox, duplicados y desorden', () => {
  const merchantRow = async (m: string) => (await ctx.db.pool.query('SELECT first_seen_at, last_activity_at FROM settlement_merchants WHERE merchant_id = $1', [m])).rows;

  it('el mismo evento repetido y concurrente (10 a la vez) tiene un solo efecto', async () => {
    const m = merchantId();
    const e = transferPosted(m, new Date('2026-10-10T10:00:00Z'));
    const results = await Promise.all(Array.from({ length: 10 }, () => ctx.consumers.handle(e)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(9);
    expect(await merchantRow(m)).toHaveLength(1);
    expect(await inbox('pay-settlement.ledger-transfer-posted')).toBe(1);
  });

  it('desorden: un evento anterior que llega tarde adelanta la primera aparición y no atrasa la última actividad (cualquier orden da lo mismo)', async () => {
    const early = new Date('2026-10-01T10:00:00Z');
    const late = new Date('2026-10-20T10:00:00Z');
    const mid = new Date('2026-10-10T10:00:00Z');
    const m = merchantId();
    const events = [transferPosted(m, late), transferPosted(m, early), transferPosted(m, mid)];
    for (const e of events) await ctx.consumers.handle(e);
    const [row] = await merchantRow(m);
    expect(row.first_seen_at.toISOString()).toBe(early.toISOString());
    expect(row.last_activity_at.toISOString()).toBe(late.toISOString());
    // en orden cronológico y en orden inverso: el mismo resultado
    for (const order of [[1, 2, 0], [2, 1, 0], [0, 1, 2]]) {
      const other = merchantId();
      const set = [transferPosted(other, late), transferPosted(other, early), transferPosted(other, mid)];
      for (const i of order) await ctx.consumers.handle(set[i]);
      const [r] = await merchantRow(other);
      expect([r.first_seen_at.toISOString(), r.last_activity_at.toISOString()]).toEqual([early.toISOString(), late.toISOString()]);
    }
  });

  it('un crédito a una cuenta que no es `pending` de un comercio y un evento de otro origen se ignoran sin tocar el inbox', async () => {
    const e = transferPosted(merchantId());
    expect(await ctx.consumers.handle({ ...e, data: { ...e.data, credit_account: 'platform:fees' } })).toBe('ignored');
    expect(await ctx.consumers.handle({ ...e, source: '/otro' })).toBe('ignored');
    expect(await inbox('pay-settlement.ledger-transfer-posted')).toBe(0);
  });
});

describe('fee_schedule.published: inbox, duplicados y desorden', () => {
  const version = async (m: string) => (await ctx.db.pool.query('SELECT version, monthly_fee_minor FROM settlement_fee_plans WHERE merchant_id = $1', [m])).rows[0];
  const permutations = <T>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));

  it.each(permutations([1, 2, 3]))('las versiones 1, 2 y 3 llegando en el orden %j dejan siempre la 3', async (...order) => {
    const m = merchantId();
    for (const v of order) expect(await ctx.consumers.handle(feeSchedule(m, v, v * 100))).toBe('processed');
    expect(await version(m)).toEqual({ version: 3, monthly_fee_minor: '300' });
  });

  it('concurrencia: las tres versiones a la vez, cada una repetida, dejan la más nueva y un evento por versión en el inbox', async () => {
    const m = merchantId();
    const events = [1, 2, 3].map((v) => feeSchedule(m, v, v * 100));
    const results = await Promise.all([...events, ...events, ...events].map((e) => ctx.consumers.handle(e)));
    expect(results.filter((r) => r === 'processed')).toHaveLength(3);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(6);
    expect(await version(m)).toEqual({ version: 3, monthly_fee_minor: '300' });
    expect(await inbox('pay-settlement.fee-schedule-published')).toBe(3);
  });
});
