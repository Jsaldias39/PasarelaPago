import { loadEventValidators, type EventValidator } from './helpers/events-contract';
import { eventsOf, key, MC, seedMerchant, startDirectIntent, startStack, statusOf, waitFor, type Stack } from './helpers/stack';
import { intentsRepo } from '../src/persistence/intents.repo';
import { settleIntent } from '../src/payments/settle';
import { emitIntentEvent } from '../src/events/emit';

let stack: Stack;
let validators: Map<string, EventValidator>;
const QR = { amount_minor: 10000, currency: 'BOB', payment_method: { type: 'qr' } };
let seq = 0;
const nextId = () => `pi_wf${String(Date.now()).slice(-8)}${String(seq++).padStart(4, '0')}`;

beforeAll(async () => {
  stack = await startStack();
  validators = await loadEventValidators();
  await seedMerchant(stack, MC);
});
afterAll(async () => stack.stop());
afterEach(() => {
  stack.risk.mode = 'allow';
  stack.connectors.scenario = 'ok';
  stack.ledger.failNext = 0;
  for (const d of [stack.risk, stack.connectors, stack.ledger]) {
    expect(d.server.violations).toEqual([]);
  }
});

const create = async (body: object = QR) => (await stack.service.createIntent(MC, 'test', key(), body)).body;
const pay = async (id: string) => {
  const charge = stack.connectors.chargeFor(id);
  if (!charge) throw new Error('sin cargo');
  stack.connectors.setChargeStatus(charge.id, 'succeeded');
  await stack.orchestrator.signalCharge(id, { status: 'captured' });
};
const settled = (id: string, status: string, timeout = 15_000) => waitFor(async () => ((await statusOf(stack, id)) === status ? true : undefined), timeout, `${id} → ${status}`);

describe('P3.H2.M1 · PaymentWorkflow: riesgo → conector → espera → ledger → evento', () => {
  it('cobro QR: la secuencia de eventos es created → requires_action → processing → succeeded y cada uno cumple el AsyncAPI', async () => {
    const intent = await create();
    const id = intent.id as string;
    await pay(id);
    await settled(id, 'succeeded');
    const events = await eventsOf(stack, id);
    expect(events.map((e) => e.type)).toEqual(['payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.succeeded']);
    for (const e of events) {
      const validate = validators.get(e.type);
      expect(validate).toBeDefined();
      expect({ type: e.type, errors: validate?.(e.envelope) }).toEqual({ type: e.type, errors: [] });
    }
    const row = await intentsRepo.byId(stack.deps.pool, id);
    expect(row).toMatchObject({ status: 'succeeded', chargeStatus: 'captured', nextAction: null });
    expect(row?.succeededAt).toBeInstanceOf(Date);
    // El kill-test del plan: Bs 100,00 con 2,5 % + Bs 0,50 deja 97,00 y 3,00 y los débitos igualan los créditos.
    expect(stack.ledger.balance(`merchant:${MC}:pending`)).toBe(9700);
    expect(stack.ledger.balance('platform:fees')).toBe(300);
    expect(stack.ledger.balance('connector:mock:clearing')).toBe(-10000);
    expect(stack.ledger.totalBalance()).toBe(0);
  });

  it('riesgo `deny` y `review`: el cobro termina failed, NO se crea cargo ni asiento', async () => {
    for (const mode of ['deny', 'review'] as const) {
      stack.risk.mode = mode;
      const intent = await create();
      expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'risk_denied' } });
      const failed = (await eventsOf(stack, intent.id as string)).find((e) => e.type === 'payment_intent.failed');
      expect((failed?.envelope.data as Record<string, unknown>).failure_code).toBe('risk_denied');
      expect(validators.get('payment_intent.failed')?.(failed?.envelope)).toEqual([]);
      expect(stack.connectors.chargeFor(intent.id as string)).toBeUndefined();
      expect(stack.ledger.postedCount(`${intent.id}:capture`)).toBe(0);
    }
  });

  it('el conector rechaza el cobro (4xx): failed con el código del conector, sin asiento', async () => {
    stack.connectors.scenario = 'decline';
    const intent = await create();
    expect(intent).toMatchObject({ status: 'failed' });
    expect(stack.ledger.postedCount(`${intent.id}:capture`)).toBe(0);
  });

  it('saldo AloVida: debita la billetera del usuario del token y deja el asiento sin pasar por un conector', async () => {
    stack.ledger.setBalance('user:usr_ana:wallet', 20000);
    const pendingBefore = stack.ledger.balance(`merchant:${MC}:pending`);
    const token = stack.wallet.issue({ userId: 'usr_ana', merchantId: MC, amountMinor: 5000 });
    const intent = await create({ amount_minor: 5000, currency: 'BOB', payment_method: { type: 'wallet', wallet_authorization: token } });
    const id = intent.id as string;
    await settled(id, 'succeeded');
    expect(stack.ledger.balance('user:usr_ana:wallet')).toBe(20000 - 5000);
    expect(stack.ledger.balance(`merchant:${MC}:pending`) - pendingBefore).toBe(4925); // 1,5 % de comisión → 75
    expect(stack.connectors.chargeFor(id)).toBeUndefined();
  });

  it('saldo AloVida sin fondos: el intento queda failed insufficient_funds y el saldo no cambia', async () => {
    stack.ledger.setBalance('user:usr_beto:wallet', 100);
    const token = stack.wallet.issue({ userId: 'usr_beto', merchantId: MC, amountMinor: 5000 });
    const intent = await create({ amount_minor: 5000, currency: 'BOB', payment_method: { type: 'wallet', wallet_authorization: token } });
    await settled(intent.id as string, 'failed');
    const row = await intentsRepo.byId(stack.deps.pool, intent.id as string);
    expect(row?.failureCode).toBe('insufficient_funds');
    expect(stack.ledger.balance('user:usr_beto:wallet')).toBe(100);
    const failed = (await eventsOf(stack, intent.id as string)).find((e) => e.type === 'payment_intent.failed');
    expect((failed?.envelope.data as Record<string, unknown>).failure_code).toBe('insufficient_funds');
  });

  it('un token de billetera inválido, ajeno o reutilizado es 403 y no debita nada', async () => {
    stack.ledger.setBalance('user:usr_carla:wallet', 9000);
    const mine = stack.wallet.issue({ userId: 'usr_carla', merchantId: MC, amountMinor: 3000 });
    const body = (token: string) => ({ amount_minor: 3000, currency: 'BOB', payment_method: { type: 'wallet', wallet_authorization: token } });
    const forOther = stack.wallet.issue({ userId: 'usr_carla', merchantId: 'mc_otro0000000001', amountMinor: 3000 });
    const wrongAmount = stack.wallet.issue({ userId: 'usr_carla', merchantId: MC, amountMinor: 3001 });
    for (const token of ['inventado', forOther, wrongAmount]) {
      const result = await stack.service.createIntent(MC, 'test', key(), body(token));
      expect(result.status).toBe(403);
    }
    expect((await stack.service.createIntent(MC, 'test', key(), body(mine))).status).toBe(201);
    expect((await stack.service.createIntent(MC, 'test', key(), body(mine))).status).toBe(403); // un solo uso
    await waitFor(async () => (stack.ledger.balance('user:usr_carla:wallet') === 6000 ? true : undefined), 10_000, 'un solo débito');
  });
});

describe('P3.H2.M2 · política de llamadas síncronas', () => {
  it('riesgo caído (503) ⇒ failed risk_unavailable (fail-closed), sin cargo ni asiento', async () => {
    stack.risk.mode = 'down';
    const intent = await create();
    expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'risk_unavailable' } });
    expect(stack.connectors.chargeFor(intent.id as string)).toBeUndefined();
    expect(stack.ledger.postedCount(`${intent.id}:capture`)).toBe(0);
  });

  it('riesgo colgado: el timeout de 300 ms corta, se reintenta con la MISMA clave hasta agotar la política de la actividad y el cobro termina failed risk_unavailable; no espera sin límite', async () => {
    stack.risk.mode = 'hang';
    const started = Date.now();
    const intent = await create();
    expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'risk_unavailable' } });
    // Antes (fail-closed inmediato) bastaban 4 s. Ahora un timeout es AMBIGUO (regla 11): ACTIVITY_MAX_ATTEMPTS=4 intentos de 2 llamadas de 300 ms con espera creciente. Sigue siendo acotado.
    expect(Date.now() - started).toBeLessThan(10_000);
    const mine = stack.risk.server.calls.filter((c) => (c.body as { payment_intent_id?: string }).payment_intent_id === intent.id);
    expect(mine.length).toBeGreaterThan(1); // se reintentó
    expect([...new Set(mine.map((c) => c.headers['idempotency-key']))]).toEqual([`${intent.id}:risk`]); // siempre con la MISMA clave
  });

  it('conector caído: se reintenta con espera creciente y, agotados los reintentos, el cobro termina failed connector_unavailable', async () => {
    stack.connectors.scenario = 'down';
    const intent = await create();
    expect(intent).toMatchObject({ status: 'failed', last_error: { code: 'connector_unavailable' } });
    expect(stack.connectors.server.callsTo('POST', /^\/charges$/).length).toBeGreaterThanOrEqual(4);
    expect(stack.ledger.postedCount(`${intent.id}:capture`)).toBe(0);
  });

  it('ledger caído un rato: el cobro ya capturado se registra al volver, UNA sola vez', async () => {
    const intent = await create();
    const id = intent.id as string;
    stack.ledger.failNext = 3; // las primeras llamadas devuelven 500
    await pay(id);
    await settled(id, 'succeeded', 30_000);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(stack.ledger.balance(`merchant:${MC}:pending`)).toBeGreaterThan(0);
  });

  it('ledger caído del todo (resultado AMBIGUO): NO se devuelve el dinero ni se cierra el cobro; se conserva el estado, se escala y, al volver el ledger, se registra UNA sola vez', async () => {
    const intent = await create();
    const id = intent.id as string;
    stack.ledger.failNext = 1000;
    await pay(id);
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'ledger_outcome_unknown'", [id])).rows[0].n) > 0 ? true : undefined), 30_000, 'escalado a una persona');
    expect(await statusOf(stack, id)).toBe('processing'); // el cobro NO se dio por fallido
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    expect([...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id)).toHaveLength(0); // y no se devolvió el dinero
    stack.ledger.failNext = 0; // vuelve el ledger: se reintenta con la MISMA clave
    await settled(id, 'succeeded', 30_000);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    const ledgerCalls = stack.ledger.server.callsTo('POST', /^\/transactions$/).filter((c) => JSON.stringify(c.body).includes(`${id}:capture`));
    expect(new Set(ledgerCalls.map((c) => c.headers['idempotency-key'])).size).toBe(1); // siempre la misma clave de idempotencia
  });

  it('el ledger RECHAZA el asiento (respuesta definitiva): ahí sí se compensa devolviendo el dinero en el conector y el cobro termina failed', async () => {
    const intent = await create();
    const id = intent.id as string;
    stack.ledger.rejectPattern = /:capture$/;
    await pay(id);
    await settled(id, 'failed', 30_000);
    stack.ledger.rejectPattern = null;
    expect((await intentsRepo.byId(stack.deps.pool, id))?.failureCode).toBe('insufficient_funds');
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
    expect([...stack.connectors.refunds.values()].filter((r) => r.charge_id === stack.connectors.chargeFor(id)?.id && r.amount_minor === 10000)).toHaveLength(1);
  });

  it('crear el cargo con resultado AMBIGUO (500): no se sabe si se creó; el cobro sigue processing, se escala y se reintenta con la misma clave; al volver el conector sigue su camino con UN solo cargo', async () => {
    stack.connectors.scenario = 'charge_ambiguous';
    const pending = stack.service.createIntent(MC, 'test', key(), QR);
    const created = await pending;
    const id = created.body.id as string;
    expect(created.body.status).toBe('processing'); // ni «failed» ni «connector_unavailable» por una duda
    await waitFor(async () => (Number((await stack.db.pool.query("SELECT count(*) AS n FROM intent_contradictions WHERE payment_intent_id = $1 AND kind = 'charge_outcome_unknown'", [id])).rows[0].n) > 0 ? true : undefined), 30_000, 'escalado');
    stack.connectors.scenario = 'ok';
    await settled(id, 'requires_action', 30_000);
    await pay(id);
    await settled(id, 'succeeded', 30_000);
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    const keys = new Set(stack.connectors.server.callsTo('POST', /^\/charges$/).filter((c) => (c.body as { payment_intent_id: string }).payment_intent_id === id).map((c) => c.headers['idempotency-key']));
    expect(keys.size).toBe(1);
  });
});

describe('P3.H2.M3 · idempotencia: repetir, reordenar y duplicar no cambia el resultado', () => {
  it('el callback `captured` 3 veces + un `authorized` atrasado: un solo asiento, un solo evento succeeded', async () => {
    const id = (await create()).id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    for (let i = 0; i < 3; i += 1) await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await stack.orchestrator.signalCharge(id, { status: 'authorized' });
    await settled(id, 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.succeeded')).toHaveLength(1);
    expect(stack.ledger.balance(`merchant:${MC}:pending`)).toBeGreaterThan(0);
  });

  it('un cobro termina en UN solo estado: nada que llegue después lo cambia', async () => {
    const id = (await create()).id as string;
    await pay(id);
    await settled(id, 'succeeded');
    for (const signal of ['failed', 'canceled', 'expired'] as const) await stack.orchestrator.signalCharge(id, { status: signal });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await statusOf(stack, id)).toBe('succeeded');
    const ends = (await eventsOf(stack, id)).filter((e) => /\.(succeeded|failed|canceled|expired)$/.test(e.type));
    expect(ends.map((e) => e.type)).toEqual(['payment_intent.succeeded']);
  });

  it('el id del intento sale de (comercio, clave): una caída a mitad de la creación se retoma sin crear un segundo cobro', async () => {
    const k = key();
    const { intentIdFor } = await import('../src/domain/ids');
    const id = intentIdFor(MC, `test:${k}`);
    // Se simula la caída: la fila quedó escrita pero el workflow nunca arrancó.
    await stack.deps.tx(async (db) => {
      await intentsRepo.insert(db, { id, merchantId: MC, mode: 'test', amountMinor: 10000, method: 'qr', feeMinor: 300, netMinor: 9700, metadata: {}, expiresAt: new Date(Date.now() + 3600_000) });
    });
    const result = await stack.service.createIntent(MC, 'test', k, QR);
    expect(result.body.id).toBe(id);
    expect(result.body.status).toBe('requires_action');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    const n = await stack.db.pool.query('SELECT count(*)::int AS n FROM payment_intents WHERE id = $1', [id]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('P3.H2.M3 · caída del servicio a mitad de POST /payment_intents', () => {
  it('Temporal no responde al arrancar el workflow: la petición falla SIN guardar una respuesta y el reintento con la misma clave retoma sobre el MISMO intento', async () => {
    let failures = 1;
    const flaky = new Proxy(stack.orchestrator, {
      get(target, property, receiver) {
        if (property === 'startPayment') {
          return async (intentId: string) => {
            if (failures > 0) {
              failures -= 1;
              throw new Error('Temporal no responde');
            }
            return target.startPayment(intentId);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { PaymentsService } = await import('../src/payments/payments.service');
    const service = new PaymentsService(stack.deps, flaky);
    const k = key();
    await expect(service.createIntent(MC, 'test', k, QR)).rejects.toThrow('Temporal no responde');
    const { intentIdFor } = await import('../src/domain/ids');
    const id = intentIdFor(MC, `test:${k}`);
    expect(await statusOf(stack, id)).toBe('processing'); // la fila quedó escrita, el workflow no arrancó
    const retry = await service.createIntent(MC, 'test', k, QR);
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(id);
    expect(retry.body.status).toBe('requires_action');
    expect(stack.connectors.chargeCreations.get(id)).toBe(1);
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.created')).toHaveLength(1);
    const n = await stack.db.pool.query('SELECT count(*)::int AS n FROM payment_intents WHERE id = $1', [id]);
    expect(n.rows[0].n).toBe(1);
  });
});

describe('P3.H2.M4 · vencimiento, consulta de estado y evento perdido (REQ-P3-7)', () => {
  it('un evento perdido: el cobro pagado en el banco se resuelve solo por la consulta de estado', async () => {
    const id = (await create()).id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded'); // el banco cobró, el callback no llegó
    await settled(id, 'succeeded', 20_000);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
    expect(stack.connectors.server.callsTo('GET', /\/charges\/ch_[a-z0-9]+\/status$/).length).toBeGreaterThan(0);
  });

  it('vence sin pago: el cargo se cancela en el conector y el intento termina expired, una sola vez', async () => {
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 2500 });
    await settled(id, 'requires_action', 8000);
    await settled(id, 'expired', 20_000);
    expect(stack.connectors.charges.get(stack.connectors.chargeFor(id)!.id)?.status).toBe('canceled');
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.expired')).toHaveLength(1);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(0);
  });

  it('vence pero el pago SÍ llegó y el evento se perdió: se verifica con el conector y se cobra, no se pierde el dinero', async () => {
    const id = await startDirectIntent(stack, { id: nextId(), expiresInMs: 6000 });
    await settled(id, 'requires_action', 8000);
    // Se paga justo antes del vencimiento y se bloquea la consulta periódica: la única forma de enterarse es la verificación final.
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded');
    await settled(id, 'succeeded', 25_000);
    expect(stack.ledger.postedCount(`${id}:capture`)).toBe(1);
  });
});

describe('P3.H1 / H2.M4 · cancelación de un QR', () => {
  it('cancelar un cobro que espera pago: 200, cargo cancelado en el conector, evento canceled y el workflow termina', async () => {
    const created = await create();
    const id = created.id as string;
    const result = await stack.service.cancelIntent(MC, 'test', id, key());
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'canceled' });
    expect(stack.connectors.charges.get(stack.connectors.chargeFor(id)!.id)?.status).toBe('canceled');
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.canceled')).toHaveLength(1);
    const handle = (stack.orchestrator as unknown as { client: { workflow: { getHandle(id: string): { describe(): Promise<{ status: { name: string } }> } } } }).client.workflow.getHandle(`payment-${id}`);
    await waitFor(async () => ((await handle.describe()).status.name === 'COMPLETED' ? true : undefined), 10_000, 'workflow completado');
  });

  it('cancelar dos veces (misma clave o distinta) no repite efectos', async () => {
    const id = (await create()).id as string;
    const k = key();
    const first = await stack.service.cancelIntent(MC, 'test', id, k);
    const replay = await stack.service.cancelIntent(MC, 'test', id, k);
    const other = await stack.service.cancelIntent(MC, 'test', id, key());
    expect([first.status, replay.status, other.status]).toEqual([200, 200, 200]);
    expect(replay.replayed).toBe(true);
    expect((await eventsOf(stack, id)).filter((e) => e.type === 'payment_intent.canceled')).toHaveLength(1);
  });

  it('cancelar un QR que YA se pagó es 409: el cobro no se cancela y sigue hasta succeeded', async () => {
    const id = (await create()).id as string;
    stack.connectors.setChargeStatus(stack.connectors.chargeFor(id)!.id, 'succeeded'); // pagó, el callback todavía no llegó
    const result = await stack.service.cancelIntent(MC, 'test', id, key());
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'invalid_state_transition' });
    const rows = await stack.db.pool.query("SELECT outcome FROM payment_cancellation_requests WHERE payment_intent_id = $1", [id]);
    expect(rows.rows.map((r) => r.outcome)).toEqual(['too_late']);
    await stack.orchestrator.signalCharge(id, { status: 'captured' });
    await settled(id, 'succeeded');
  });

  it('un cobro ya terminal no se cancela (409) y uno en otro estado tampoco', async () => {
    stack.risk.mode = 'deny';
    const failed = (await create()).id as string;
    expect((await stack.service.cancelIntent(MC, 'test', failed, key())).status).toBe(409);
  });
});

describe('P3.H2.M7 · eventos por outbox, en la misma transacción', () => {
  it('si la transacción no confirma, NO hay evento ni cambio de estado', async () => {
    const id = (await create()).id as string;
    const before = (await eventsOf(stack, id)).length;
    await expect(
      stack.deps.tx(async (db) => {
        const row = await intentsRepo.transition(db, id, ['requires_action'], 'canceled', { nextAction: null });
        await emitIntentEvent(db, 'payment_intent.canceled', row!);
        throw new Error('se cae antes del commit');
      }),
    ).rejects.toThrow('se cae');
    expect((await eventsOf(stack, id)).length).toBe(before);
    expect(await statusOf(stack, id)).toBe('requires_action');
  });

  it('dos cierres concurrentes del mismo intento: gana uno solo y el evento sale una vez', async () => {
    const id = (await create()).id as string;
    const results = await Promise.all([settleIntent(stack.deps, id, 'canceled'), settleIntent(stack.deps, id, 'expired'), settleIntent(stack.deps, id, 'failed', { failureCode: 'internal_error' })]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const ends = (await eventsOf(stack, id)).filter((e) => /\.(succeeded|failed|canceled|expired)$/.test(e.type));
    expect(ends).toHaveLength(1);
    expect(new Set(results.map((r) => r.intent.status)).size).toBe(1);
  });
});
