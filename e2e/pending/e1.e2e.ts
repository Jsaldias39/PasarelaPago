import { ledgerOfCapture, publicApi } from '../lib/flow.ts';
import { MerchantReceiver } from '../lib/receiver.ts';
import { seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { waitFor } from '../lib/process.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E1 — alta de comercio → clave sk_test_ → primer cobro QR → callback del conector mock → captured → ledger.
 * Bs 100,00 con 2,5 % + Bs 0,50: 97,00 en merchant:X:pending y 3,00 en platform:fees; débitos = créditos.
 *
 * PENDIENTE (fuera de la suite por defecto: `yarn e2e:pending`). Bloquea hoy: D-29/D-30 en P3 y P5. Con el stack de sandbox, pay-payments no
 * manda el nombre del comercio a pay-risk y pay-risk contesta `review` (`screening_not_provided`), que pay-payments trata como `deny`:
 * el intento termina `failed/risk_denied`. Ver docs/trabajo/ola-2/P1/ARNES.md § Pendientes.
 * Lo que sí está probado hoy, por separado y contra los servicios reales: el tramo del ledger (flows/ledger-capture.e2e.ts) y el del
 * conector (flows/connector-callbacks.e2e.ts). El alta del comercio es la siembra [DOBLE] de pay-merchants (no hay API de operador).
 */
const GROSS = 10_000;
const FEE = 300;
const NET = GROSS - FEE;

describe('E1 — primer cobro QR de punta a punta', () => {
  let stack: Stack;
  let merchant: SeededMerchant;
  let receiver: MerchantReceiver;
  let api: ReturnType<typeof publicApi>;

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false });
    merchant = await seedMerchant(stack, { label: 'COMERCIO E1 (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    api = publicApi(stack, merchant);
    receiver = new MerchantReceiver({ port: stack.receiver.port, certFile: stack.receiver.certFile, keyFile: stack.receiver.keyFile });
    await receiver.listen();
  });
  afterAll(async () => {
    await receiver?.close();
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('el cobro de Bs 100 por QR pasa a succeeded, el ledger deja 97,00 en pending y 3,00 en fees (débitos = créditos), y el comercio recibe UN payment_intent.succeeded', async () => {
    const endpoint = await stack.call('pay-edge', 'POST', '/v1/webhook_endpoints', {
      headers: { authorization: `Bearer ${merchant.token}`, 'idempotency-key': 'e1-endpoint-0001' },
      json: { url: `https://127.0.0.1:${stack.receiver.port}/hook-e1`, enabled_events: ['payment_intent.succeeded'] },
    });
    expect(endpoint.status).toBe(201);
    receiver.route('/hook-e1', { secret: (endpoint.json as { secret: string }).secret, mode: 'up' });

    const created = await api.createQrIntent(GROSS, 'e1-intent-0001-key');
    expect(created.status).toBe(201);
    expect(created.intent).toMatchObject({ amount_minor: GROSS, fee_minor: FEE, net_minor: NET });
    // El QR (`next_action`) no se afirma acá: lo asigna el conector DESPUÉS de crear el intento y el simulador aprueba en ~1 s, así que
    // un cobro rápido ya es `succeeded` (sin `next_action`) cuando se lo consulta. Su payload se prueba en connector-callbacks.e2e.ts.

    const replay = await api.createQrIntent(GROSS, 'e1-intent-0001-key');
    expect(replay.intent.id).toBe(created.intent.id);

    // El callback lo firma y lo entrega el simulador (MockPumpService) a pay-connectors; el intento lo ve por JetStream.
    const settled = await api.settle(created.intent.id);
    expect({ status: settled.status, error: settled.last_error }).toEqual({ status: 'succeeded', error: null });
    expect(settled.succeeded_at).toBeTruthy();

    const ledger = await ledgerOfCapture(stack, merchant.merchantId, created.intent.id);
    expect(ledger).toMatchObject({ pending: NET, fees: FEE, debits: GROSS, credits: GROSS, captureLinesOnPending: 1 });

    const balance = await api.balance();
    expect(balance.status).toBe(200);
    expect(balance.body.pending_minor).toBe(NET);

    expect((await waitFor(async () => [...receiver.accepted.values()].some((a) => a.path === '/hook-e1'), 60_000)).ok).toBe(true);
    const delivered = [...receiver.accepted.values()].filter((a) => a.path === '/hook-e1').map((a) => JSON.parse(a.body) as { type: string; data: { object: { id: string } } });
    expect(delivered.filter((e) => e.type === 'payment_intent.succeeded' && e.data.object.id === created.intent.id)).toHaveLength(1);
  });
});
