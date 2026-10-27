import { startStack, stopStack, type Stack } from '../stack.ts';
import { connectorEvents } from '../lib/events.ts';
import { until } from '../lib/wait.ts';

/**
 * E2 a nivel del conector REAL (pay-connectors + pay-qr, sin pay-payments): callback duplicado, fuera de orden y perdido que solo
 * revela la consulta de estado. Los escenarios los fija el simulador `mock` por los centavos del importe (README de pay-connectors).
 * El llamador es un [DOBLE] de pay-payments (identidad `x-service-id: pay-payments`); la versión de punta a punta por el borde es
 * `e2e/pending/e2.e2e.ts`.
 */
const MERCHANT = 'mc_e2ecallbacks1';

describe('E2 (conector real) — callbacks duplicados, fuera de orden y perdidos', () => {
  let stack: Stack;
  let seq = 0;

  const charge = async (cents: string) => {
    seq += 1;
    const paymentIntentId = `pi_e2e${cents}${String(seq).padStart(3, '0')}${Math.random().toString(36).slice(2, 8)}`;
    const res = await stack.callAs('pay-payments', 'pay-connectors', 'POST', '/charges', {
      merchantId: MERCHANT,
      headers: { 'idempotency-key': `e2e-${paymentIntentId}-0001` },
      json: { payment_intent_id: paymentIntentId, merchant_id: MERCHANT, amount_minor: 10_000 + Number(cents), currency: 'BOB', method: 'qr', expires_at: new Date(Date.now() + 600_000).toISOString() },
    });
    expect(res.status).toBe(201);
    return { paymentIntentId, id: (res.json as { id: string }).id, nextAction: (res.json as { next_action?: { type: string; payload: string } }).next_action };
  };
  const state = async (id: string, refresh = false) => {
    const res = await stack.callAs('pay-payments', 'pay-connectors', 'GET', `/charges/${id}/status${refresh ? '?refresh=true' : ''}`, {});
    expect(res.status).toBe(200);
    return res.json as { status: string; stale: boolean };
  };
  /** El bombeo del simulador procesa en orden: cuando llega el evento de un cobro posterior, los callbacks anteriores ya se procesaron. */
  const drained = async () => {
    const marker = await charge('00');
    await until('el cobro marcador se capturó', () => connectorEvents(stack, marker.paymentIntentId), (events) => events.length >= 1);
  };

  beforeAll(async () => {
    stack = await startStack({ only: ['pay-qr', 'pay-connectors'] });
    expect(stack.services['pay-connectors'].healthy).toBe(true);
  });
  afterAll(async () => {
    const report = await stopStack(stack);
    expect(report.leftoverPids).toEqual([]);
  });

  it('CORRECTO (…00): el callback llega, el cobro queda succeeded y se publica UN evento captured', async () => {
    const { paymentIntentId, id, nextAction } = await charge('00');
    expect(nextAction?.type).toBe('display_qr');
    expect(nextAction?.payload).toMatch(/^000201.*6304[0-9A-F]{4}$/);
    const events = await until('evento captured', () => connectorEvents(stack, paymentIntentId), (e) => e.length >= 1);
    expect(events.map((e) => e.data.status)).toEqual(['captured']);
    expect((await state(id)).status).toBe('succeeded');
  });

  it('DUPLICADO (…03): el mismo callback ×3 produce UN solo evento y UN solo cambio de estado', async () => {
    const { paymentIntentId, id } = await charge('03');
    await until('cobro succeeded', () => state(id), (s) => s.status === 'succeeded');
    await drained();
    const events = await connectorEvents(stack, paymentIntentId);
    expect(events.map((e) => e.data.status)).toEqual(['captured']);
    expect(new Set(events.map((e) => e.data.provider_event_id)).size).toBe(1);
  });

  it('FUERA DE ORDEN (…04): captured y después authorized — el estado no retrocede y no se publica nada posterior a captured', async () => {
    const { paymentIntentId, id } = await charge('04');
    await until('cobro succeeded', () => state(id), (s) => s.status === 'succeeded');
    await drained();
    const events = await connectorEvents(stack, paymentIntentId);
    const statuses = events.map((e) => e.data.status);
    expect(statuses.at(-1)).toBe('captured');
    expect(statuses.filter((s) => s === 'captured')).toHaveLength(1);
    expect((await state(id)).status).toBe('succeeded');
  });

  it('PERDIDO (…05): nunca llega el callback; la consulta de estado (explícita o la del poller del conector) revela captured y se publica UN evento, también al repetirla', async () => {
    const { paymentIntentId, id } = await charge('05');
    // El arnés fija POLLER_MIN_AGE_MS=1000 y POLLER_INTERVAL_MS=500: el poller puede adelantarse a la consulta explícita; da igual quién gane,
    // lo que se afirma es que el estado se resuelve sin callback y que el efecto es único.
    const refreshed = await state(id, true);
    expect(refreshed).toMatchObject({ status: 'succeeded', stale: false });
    const events = await until('evento por consulta', () => connectorEvents(stack, paymentIntentId), (e) => e.length >= 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ status: 'captured', observed_via: expect.not.stringMatching(/^callback$/) });

    await state(id, true);
    await drained();
    expect(await connectorEvents(stack, paymentIntentId)).toHaveLength(1);
  });

  it('INVÁLIDO: un callback sin firma no tiene efecto (401) y un servicio ajeno no puede crear cobros (403)', async () => {
    const callback = await stack.call('pay-connectors', 'POST', '/callbacks/mock', { json: { id: 'evt_forged', status: 'captured' } });
    expect(callback.status).toBe(401);
    const stranger = await stack.callAs('pay-edge', 'pay-connectors', 'POST', '/charges', { headers: { 'idempotency-key': 'e2e-stranger-0001' }, json: {} });
    expect(stranger.status).toBe(403);
  });
});
