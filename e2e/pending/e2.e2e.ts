import { connectorEvents } from '../lib/events.ts';
import { ledgerOfCapture, publicApi } from '../lib/flow.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E2 — callback duplicado (…03), fuera de orden (…04) y perdido que resuelve la consulta de estado (…05), por la API pública.
 * Los escenarios los fija el simulador `mock` por los centavos del importe. En cada uno: el intento termina `succeeded` UNA vez, el
 * ledger asienta la captura UNA vez (una línea de crédito sobre el pending del comercio) y débitos = créditos.
 * Para el perdido, pay-payments consulta el estado cada STATUS_INQUIRY_MS (por defecto 30 s; el arnés lo baja a 1 s).
 *
 * Hoy vive en e2e/pending (`yarn e2e:pending`); pasa a e2e/flows con `git mv e2e/pending/*.e2e.ts e2e/flows/`. Lo bloquea D-29/D-30 en P3 y P5, igual que E1 (el intento termina `failed/risk_denied`).
 * Ya probado por separado y contra el conector REAL: flows/connector-callbacks.e2e.ts (los tres escenarios hasta el evento del bus).
 */
describe('E2 — callbacks duplicados, fuera de orden y perdidos, de punta a punta', () => {
  let stack: Stack;
  const api = (merchant: SeededMerchant) => publicApi(stack, merchant);

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, envOverrides: { 'pay-payments': { STATUS_INQUIRY_MS: '1000' } } });
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  const scenario = async (cents: string) => {
    const merchant = await seedMerchant(stack, { label: `COMERCIO E2-${cents} (SINTÉTICO)` });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const client = api(merchant);
    const created = await client.createQrIntent(10_000 + Number(cents), `e2-${cents}-intent-0001-key`);
    expect(created.status).toBe(201);
    const settled = await client.settle(created.intent.id);
    expect({ status: settled.status, error: settled.last_error }).toEqual({ status: 'succeeded', error: null });
    const ledger = await ledgerOfCapture(stack, merchant.merchantId, created.intent.id);
    // Una sola captura: el neto del intento, la comisión del intento, y la partida doble cierra por el bruto.
    expect(ledger).toMatchObject({ pending: created.intent.net_minor, fees: expect.any(Number), debits: created.intent.amount_minor, credits: created.intent.amount_minor, captureLinesOnPending: 1 });
    return { intentId: created.intent.id, merchant };
  };

  it('DUPLICADO (…03): el mismo callback ×3 deja UN solo asiento y UN evento del conector', async () => {
    const { intentId } = await scenario('03');
    const events = await connectorEvents(stack, intentId);
    expect(events.filter((e) => e.data.status === 'captured')).toHaveLength(1);
  });

  it('FUERA DE ORDEN (…04): captured y después authorized — el intento no retrocede y el asiento es uno', async () => {
    const { intentId, merchant } = await scenario('04');
    expect((await api(merchant).getIntent(intentId)).status).toBe('succeeded');
    expect((await connectorEvents(stack, intentId)).filter((e) => e.data.status === 'captured')).toHaveLength(1);
  });

  it('PERDIDO (…05): nunca llega el callback; la consulta de estado de pay-payments revela captured y el asiento es uno', async () => {
    const { intentId } = await scenario('05');
    const events = await connectorEvents(stack, intentId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data.observed_via).not.toBe('callback');
  });
});
