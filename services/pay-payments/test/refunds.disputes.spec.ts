import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { eventsOf, key, MC, MC2, seedMerchant, startStack, statusOf, waitFor, type Stack } from './helpers/stack';
import { disputesRepo } from '../src/persistence/disputes.repo';
import { refundsRepo } from '../src/persistence/refunds.repo';

let stack: Stack;
let validators: Map<string, EventValidator>;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };

beforeAll(async () => {
  stack = await startStack({ env: { REFUND_WAIT_MS: '2500' } });
  validators = await loadEventValidators();
  await seedMerchant(stack, MC);
  await seedMerchant(stack, MC2);
});
afterAll(async () => stack.stop());
afterEach(() => {
  stack.connectors.scenario = 'ok';
  stack.ledger.failNext = 0;
  for (const d of [stack.risk, stack.connectors, stack.ledger]) expect(d.server.violations).toEqual([]);
});

/** Un cobro exitoso real (por el workflow) y saldo disponible del comercio para poder reembolsar. */
async function succeededIntent(merchant = MC, available = 20000): Promise<string> {
  const id = (await stack.service.createIntent(merchant, 'test', key(), QR)).body.id as string;
  stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
  await waitFor(async () => ((await statusOf(stack, id)) === 'succeeded' ? true : undefined), 20_000, 'cobro exitoso');
  stack.ledger.setBalance(`merchant:${merchant}:available`, available);
  return id;
}
const refund = (id: string, amount: number, merchant = MC, k = key()) => stack.service.createRefund(merchant, 'test', id, k, { amount_minor: amount, reason: 'requested_by_customer' });
const available = (merchant = MC) => stack.ledger.balance(`merchant:${merchant}:available`);

describe('P3.H2.M5 · RefundWorkflow con retención en dos fases (REQ-P3-6)', () => {
  it('reembolso parcial: retiene, devuelve en el conector, confirma la retención y emite refund.created → refund.succeeded', async () => {
    const id = await succeededIntent();
    const result = await refund(id, 4000);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ object: 'refund', status: 'succeeded', amount_minor: 4000, payment_intent: id, failure_code: null });
    expect(available()).toBe(16000);
    const hold = [...stack.ledger.holds.values()].find((h) => h.business_ref === `${result.body.id}:refund`);
    expect(hold).toMatchObject({ status: 'posted', amount_minor: 4000, debit_account: `merchant:${MC}:available` });
    expect([...stack.connectors.refunds.values()].filter((r) => r.amount_minor === 4000)).toHaveLength(1);
    const events = await eventsOf(stack, result.body.id as string);
    expect(events.map((e) => e.type)).toEqual(['refund.created', 'refund.succeeded']);
    for (const e of events) expect({ type: e.type, errors: validators.get(e.type)?.(e.envelope) }).toEqual({ type: e.type, errors: [] });
  });

  it('el conector falla el reembolso: la retención se ANULA y el saldo del comercio queda intacto', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_fails';
    const result = await refund(id, 3000);
    expect(result.body).toMatchObject({ status: 'failed' });
    expect(available()).toBe(20000);
    const hold = [...stack.ledger.holds.values()].find((h) => h.business_ref === `${result.body.id}:refund`);
    expect(hold?.status).toBe('voided');
    const events = await eventsOf(stack, result.body.id as string);
    expect(events.map((e) => e.type)).toEqual(['refund.created', 'refund.failed']);
    expect(validators.get('refund.failed')?.(events[1]!.envelope)).toEqual([]);
    // El cupo del reembolso fallido vuelve: se puede pedir otro por el total.
    stack.connectors.scenario = 'ok';
    expect((await refund(id, 10000)).body).toMatchObject({ status: 'succeeded' });
  });

  it('sin saldo disponible: falla insufficient_funds SIN tocar al conector', async () => {
    const id = await succeededIntent(MC, 1000);
    const callsBefore = stack.connectors.server.callsTo('POST', /\/refunds$/).length;
    const result = await refund(id, 4000);
    expect(result.body).toMatchObject({ status: 'failed', failure_code: 'insufficient_funds' });
    expect(stack.connectors.server.callsTo('POST', /\/refunds$/).length).toBe(callsBefore);
    expect(available()).toBe(1000);
  });

  it('`502 connector_unavailable` exacto = el conector garantiza que NO envió nada: es definitivo, la retención se anula y el reembolso falla', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_down';
    const result = await refund(id, 2000);
    expect(result.body).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });
    expect(available()).toBe(20000);
    expect([...stack.ledger.holds.values()].find((h) => h.business_ref === `${result.body.id}:refund`)?.status).toBe('voided');
    expect((await stack.db.pool.query("SELECT kind FROM intent_contradictions WHERE payment_intent_id = $1", [id])).rows).toEqual([]);
  });

  it('un 500 del conector al reembolsar es AMBIGUO: NO se anula la retención ni se da por fallido; se escala y se reintenta con la MISMA clave hasta que haya respuesta', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_ambiguous';
    const result = await refund(id, 2000); // la petición espera createWaitMs y vuelve con el reembolso todavía pendiente
    const refundId = result.body.id as string;
    expect(result.body.status).toBe('pending');
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'refund_outcome_unknown'", [id])).rows[0].n) > 0 ? true : undefined), 30_000, 'escalado');
    const hold = () => [...stack.ledger.holds.values()].find((h) => h.business_ref === `${refundId}:refund`);
    expect(hold()?.status).toBe('pending'); // la retención sigue puesta
    expect(available()).toBe(20000); // y el saldo todavía no cambió
    stack.connectors.scenario = 'ok'; // el conector vuelve y contesta
    await waitFor(async () => ((await refundsRepo.byId(stack.deps.pool, refundId))?.status === 'succeeded' ? true : undefined), 30_000, 'reembolso completado');
    expect(hold()?.status).toBe('posted');
    expect(available()).toBe(18000); // se debitó UNA vez
    const attempts = stack.connectors.server.callsTo('POST', /\/refunds$/).filter((c) => String(c.headers['idempotency-key']).startsWith(refundId));
    expect(attempts.length).toBeGreaterThan(1); // se reintentó…
    expect(new Set(attempts.map((c) => c.headers['idempotency-key']))).toEqual(new Set([`${refundId}:refund`])); // …siempre con la misma clave
    expect([...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id)).toHaveLength(1);
  });

  it('ledger caído al retener (ambiguo): el reembolso queda pendiente y escalado, el conector no se toca; al volver el ledger se completa', async () => {
    const id = await succeededIntent();
    const before = stack.connectors.server.callsTo('POST', /\/refunds$/).length;
    stack.ledger.failNext = 1000;
    const result = await refund(id, 2000);
    const refundId = result.body.id as string;
    expect(result.body.status).toBe('pending');
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'hold_outcome_unknown'", [id])).rows[0].n) > 0 ? true : undefined), 30_000, 'escalado');
    expect((await refundsRepo.byId(stack.deps.pool, refundId))?.status).toBe('pending');
    expect(stack.connectors.server.callsTo('POST', /\/refunds$/).length).toBe(before);
    stack.ledger.failNext = 0;
    await waitFor(async () => ((await refundsRepo.byId(stack.deps.pool, refundId))?.status === 'succeeded' ? true : undefined), 30_000, 'reembolso completado');
    expect(available()).toBe(18000);
  });

  it('el conector responde `pending`: espera el evento y, al llegar, confirma', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const call = refund(id, 1000); // la petición espera el resultado: el aviso del banco llega mientras tanto
    const refundId = await waitFor(async () => (await stack.db.pool.query('SELECT id FROM refunds WHERE payment_intent_id = $1', [id])).rows[0]?.id as string | undefined, 10_000, 'reembolso creado');
    await waitFor(async () => ((await stack.orchestrator.signalRefund(refundId, { status: 'succeeded' })) === 'delivered' ? true : undefined), 10_000, 'workflow del reembolso en marcha');
    const result = await call;
    expect(result.body).toMatchObject({ status: 'succeeded' });
    expect(available()).toBe(19000);
  });

  it('`pending` y nadie avisa: NO se libera la retención ni se da por fallido; queda pendiente y a la vista de conciliación', async () => {
    const id = await succeededIntent();
    stack.connectors.scenario = 'refund_pending';
    const result = await refund(id, 1500);
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'refund_pending_timeout'", [id])).rows[0].n) > 0 ? true : undefined), 20_000, 'marcado para conciliar');
    expect((await refundsRepo.byId(stack.deps.pool, result.body.id as string))?.status).toBe('pending');
    const hold = [...stack.ledger.holds.values()].find((h) => h.business_ref === `${result.body.id}:refund`);
    expect(hold?.status).toBe('pending');
  });

  it('la misma Idempotency-Key devuelve el mismo reembolso y no devuelve dos veces el dinero', async () => {
    const id = await succeededIntent();
    const k = key();
    const first = await refund(id, 2500, MC, k);
    const second = await refund(id, 2500, MC, k);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual(first.body);
    expect(available()).toBe(17500);
    expect([...stack.connectors.refunds.values()].filter((r) => r.amount_minor === 2500 && r.charge_id === stack.connectors.chargeFor(id)!.id)).toHaveLength(1);
  });

  describe('límites del importe', () => {
    it('no se reembolsa más de lo cobrado (acumulando parciales) y el total exacto sí', async () => {
      const id = await succeededIntent();
      expect((await refund(id, 6000)).status).toBe(201);
      const over = await refund(id, 4001);
      expect(over.status).toBe(422);
      expect(over.body).toMatchObject({ code: 'validation_failed' });
      expect((await refund(id, 4000)).body).toMatchObject({ status: 'succeeded' });
      expect((await refund(id, 1)).status).toBe(422);
    });

    it('dos reembolsos concurrentes que juntos pasan el total: se acepta UNO solo', async () => {
      const id = await succeededIntent();
      const results = await Promise.all([refund(id, 6000), refund(id, 6000)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const accepted = await stack.db.pool.query("SELECT count(*)::int AS n, COALESCE(sum(amount_minor),0)::int AS total FROM refunds WHERE payment_intent_id = $1", [id]);
      expect(accepted.rows[0]).toEqual({ n: 1, total: 6000 });
    });

    it('importe 0, negativo, decimal o campo no declarado: 422', async () => {
      const id = await succeededIntent();
      for (const body of [{ amount_minor: 0 }, { amount_minor: -1 }, { amount_minor: 1.5 }, { amount_minor: 100, reason: 'otro' }, { amount_minor: 100, fee: 0 }]) {
        expect((await stack.service.createRefund(MC, 'test', id, key(), body).catch((e: { status: number }) => ({ status: e.status }))).status).toBe(422);
      }
    });

    it('un cobro que no está succeeded no se reembolsa (409) y uno ajeno es 404', async () => {
      stack.risk.mode = 'deny';
      const failed = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
      stack.risk.mode = 'allow';
      expect((await refund(failed, 100)).status).toBe(409);
      const mine = await succeededIntent();
      expect((await refund(mine, 100, MC2)).status).toBe(404);
    });
  });
});

describe('P3.H2.M6 · disputas: abrir, evidencia, resultado (D-22)', () => {
  it('perdida: se debita el importe al comercio de su saldo pendiente, se emite dispute.lost y el resultado es único', async () => {
    const id = await succeededIntent();
    const pendingBefore = stack.ledger.balance(`merchant:${MC}:pending`);
    const { dispute, created } = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-1' });
    expect(created).toBe(true);
    expect(dispute).toMatchObject({ status: 'open', amountMinor: 10000, merchantId: MC });
    await stack.service.addEvidence(dispute.id, 'doc_recibo_0001');
    await stack.service.addEvidence(dispute.id, 'doc_recibo_0001'); // repetida: no se duplica
    expect((await disputesRepo.byId(stack.deps.pool, dispute.id))?.evidence).toEqual(['doc_recibo_0001']);

    await stack.service.resolveDispute(dispute.id, 'lost');
    await waitFor(async () => ((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status === 'lost' ? true : undefined), 15_000, 'disputa perdida');
    expect(stack.ledger.balance(`merchant:${MC}:pending`)).toBe(pendingBefore - 10000);
    expect(stack.ledger.postedCount(`${dispute.id}:chargeback`)).toBe(1);
    const events = await eventsOf(stack, dispute.id);
    expect(events.map((e) => e.type)).toEqual(['dispute.opened', 'dispute.lost']);
    for (const e of events) expect({ type: e.type, errors: validators.get(e.type)?.(e.envelope) }).toEqual({ type: e.type, errors: [] });
    await expect(stack.service.resolveDispute(dispute.id, 'won')).rejects.toMatchObject({ code: 'invalid_state_transition' });
    expect((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status).toBe('lost');
  });

  it('si al comercio no le alcanza, el débito deja DEUDA (saldo negativo) para el próximo corte, no se rechaza', async () => {
    const id = await succeededIntent();
    stack.ledger.setBalance(`merchant:${MC}:pending`, 0);
    const { dispute } = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-debt' });
    await stack.service.resolveDispute(dispute.id, 'lost');
    await waitFor(async () => ((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status === 'lost' ? true : undefined), 15_000, 'disputa perdida');
    expect(stack.ledger.balance(`merchant:${MC}:pending`)).toBe(-10000);
  });

  it('perdida con el ledger caído (ambiguo): la disputa sigue abierta y escalada, no se da por resuelta; al volver el ledger el débito ocurre UNA vez', async () => {
    const id = await succeededIntent();
    const { dispute } = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-ledgerdown' });
    stack.ledger.failNext = 1000;
    await stack.service.resolveDispute(dispute.id, 'lost');
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'dispute_ledger_unknown'", [id])).rows[0].n) > 0 ? true : undefined), 30_000, 'escalado');
    expect((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status).toBe('open');
    stack.ledger.failNext = 0;
    await waitFor(async () => ((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status === 'lost' ? true : undefined), 30_000, 'disputa perdida');
    expect(stack.ledger.postedCount(`${dispute.id}:chargeback`)).toBe(1);
  });

  it('ganada: no se mueve dinero y se emite dispute.won', async () => {
    const id = await succeededIntent();
    const before = stack.ledger.totalBalance();
    const { dispute } = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-2' });
    await stack.service.resolveDispute(dispute.id, 'won');
    await waitFor(async () => ((await disputesRepo.byId(stack.deps.pool, dispute.id))?.status === 'won' ? true : undefined), 15_000, 'disputa ganada');
    expect(stack.ledger.totalBalance()).toBe(before);
    expect(stack.ledger.postedCount(`${dispute.id}:chargeback`)).toBe(0);
    expect((await eventsOf(stack, dispute.id)).map((e) => e.type)).toEqual(['dispute.opened', 'dispute.won']);
  });

  it('abrir dos veces la misma disputa no duplica; otra disputa abierta sobre el mismo cobro se rechaza; un cobro no exitoso no se disputa', async () => {
    const id = await succeededIntent();
    const first = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-3' });
    const again = await stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-3' });
    expect(again.created).toBe(false);
    expect(again.dispute.id).toBe(first.dispute.id);
    await expect(stack.service.openDispute({ paymentIntentId: id, openedKey: 'prov-evt-4' })).rejects.toMatchObject({ code: 'invalid_state_transition' });
    stack.risk.mode = 'deny';
    const failed = (await stack.service.createIntent(MC, 'test', key(), QR)).body.id as string;
    stack.risk.mode = 'allow';
    await expect(stack.service.openDispute({ paymentIntentId: failed, openedKey: 'x' })).rejects.toMatchObject({ code: 'invalid_state_transition' });
    expect((await eventsOf(stack, first.dispute.id)).filter((e) => e.type === 'dispute.opened')).toHaveLength(1);
  });
});
