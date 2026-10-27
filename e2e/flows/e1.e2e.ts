import { ledgerOfCapture, publicApi } from '../lib/flow.ts';
import { MerchantReceiver } from '../lib/receiver.ts';
import { SYNTHETIC_PAYER_NAME, seedMerchant, waitForEdgeToKnow, type SeededMerchant } from '../lib/seed.ts';
import { waitFor } from '../lib/process.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * E1 — alta de comercio → clave sk_test_ → primer cobro QR → callback del conector mock → captured → ledger.
 * Bs 100,00 con 2,5 % + Bs 0,50: 97,00 en merchant:X:pending y 3,00 en platform:fees; débitos = créditos.
 *
 * Pasa con los 11 servicios reales (D-29/D-30/D-33): el alta es por la API real de pay-merchants (credencial de operador sintética), el cobro por la
 * API pública de pay-edge con `payer_name`, el cribado de comercio y pagador lo hace pay-risk con Watchman real, el callback lo firma el simulador `mock`
 * y entrega pay-connectors, pay-payments asienta en pay-ledger (TigerBeetle real) y cierra el intento. Los nombres sintéticos no puntúan en Watchman
 * (flows/synthetic-names.e2e.ts). Único doble del recorrido: la PRIMERA clave `sk_test_` se pide con la identidad de pay-edge (ver onboardMerchant).
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

    const created = await api.createQrIntent(GROSS, 'e1-intent-0001-key', SYNTHETIC_PAYER_NAME);
    expect(created.status).toBe(201);
    // D-29: el nombre del pagador es dato personal y no vuelve en ninguna respuesta.
    expect(JSON.stringify(created.intent)).not.toContain(SYNTHETIC_PAYER_NAME);
    expect(created.intent).toMatchObject({ amount_minor: GROSS, fee_minor: FEE, net_minor: NET });
    // El QR (`next_action`) no se afirma acá: lo asigna el conector DESPUÉS de crear el intento y el simulador aprueba en ~1 s, así que
    // un cobro rápido ya es `succeeded` (sin `next_action`) cuando se lo consulta. Su payload se prueba en connector-callbacks.e2e.ts.

    const replay = await api.createQrIntent(GROSS, 'e1-intent-0001-key', SYNTHETIC_PAYER_NAME);
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
    const delivered = [...receiver.accepted.values()].filter((a) => a.path === '/hook-e1').map((a) => JSON.parse(a.body) as { type: string; data: { object: { payment_intent_id: string; fee_minor: number; net_minor: number; ledger_transfer_id: string } } });
    const succeeded = delivered.filter((e) => e.type === 'payment_intent.succeeded' && e.data.object.payment_intent_id === created.intent.id);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.data.object).toMatchObject({ fee_minor: FEE, net_minor: NET, ledger_transfer_id: expect.stringMatching(/^tx_/) });
    // Ningún dato personal en lo que sale al comercio: ni el nombre del pagador ni la razón social.
    expect(delivered.map((e) => JSON.stringify(e)).join('')).not.toMatch(/Cliente Anonimo|TALLER MECANICO/);
  });

  it('CONTROL NEGATIVO (D-29/D-30): un comercio cuya razón social figura en las listas de sanciones NO cobra: el intento termina failed/risk_denied y el ledger no asienta nada', async () => {
    // Nombre de una EMPRESA de las listas OFAC de 2019 que trae el Watchman del Compose (puntúa ~0,81 al buscarla por su nombre exacto).
    const listed = await seedMerchant(stack, { label: 'COMERCIO LISTADO (SINTÉTICO)', legalName: 'J.A.J. BARBOSA Y CIA. S.C.S.' });
    expect((await waitForEdgeToKnow(stack, listed)).ok).toBe(true);
    const client = publicApi(stack, listed);
    const created = await client.createQrIntent(GROSS, 'e1-listed-intent-0001');
    expect(created.status).toBe(201);
    const settled = await client.settle(created.intent.id);
    expect({ status: settled.status, code: settled.last_error?.code }).toEqual({ status: 'failed', code: 'risk_denied' });
    const ledger = await ledgerOfCapture(stack, listed.merchantId, created.intent.id);
    expect(ledger).toMatchObject({ pending: 0, debits: 0, credits: 0, captureLinesOnPending: 0 });
  });
});
