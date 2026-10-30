import { ledgerOfCapture, publicApi } from '../lib/flow.ts';
import { seedMerchant, waitForEdgeToKnow } from '../lib/seed.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * Capa sandbox completa (D-26, propuesta #8 de P4): los 11 servicios REALES más `pay-mockbank` (servicio 12, banco simulado), con `pay-connectors`
 * hablándole por HTTP (`MOCKBANK_URL`) en lugar de usar su banco en memoria. No es el banco real: es un doble declarado, cuyas reglas
 * (escenario por centavos) están en docs/trabajo/ola-2/P4/ESCENARIOS.md. E1/E2 NO dependen de esto (corren con el banco en memoria).
 *
 * Qué prueba (correcto / límite / inválido):
 * - correcto: un cobro de Bs 100,00 recorre el borde, el conector y el banco simulado y termina `succeeded` con 97,00/3,00 en el ledger real;
 *   el banco registró el cobro (extracto de `collections`) y toda respuesta suya lleva `X-Pay-Mode: sandbox`.
 * - límite: el escenario «rechazado» (…01) termina `failed` en el intento y no asienta nada; el «duplicado» (…03) deja UN asiento.
 * - inválido: el banco niega una identidad ajena y un modo `live` (403), también con la cabecera de sandbox.
 */
describe('Capa sandbox — pay-mockbank como banco del conector mock', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, mockbank: true });
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  const bank = (path: string, opts: { from?: string; payMode?: 'test' | 'live' | null } = {}) =>
    stack.callAs(opts.from ?? 'pay-connectors', 'pay-mockbank', 'GET', path, { payMode: opts.payMode === undefined ? 'test' : opts.payMode });
  const collections = async () => {
    const res = await bank(`/sandbox/statement?account=collections&from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`);
    expect(res.status).toBe(200);
    return (res.json as { data: { our_reference: string | null; direction: string; amount_minor: number }[] }).data;
  };

  it('el stack incluye al banco simulado, sano, y toda respuesta suya lleva X-Pay-Mode: sandbox', async () => {
    expect(stack.services['pay-mockbank']).toMatchObject({ started: true, healthy: true, error: undefined });
    const probe = await bank('/sandbox/probe');
    expect(probe.status).toBe(200);
    expect(probe.headers.get('x-pay-mode')).toBe('sandbox');
    const health = await stack.call('pay-mockbank', 'GET', '/health/ready');
    expect(health.status).toBe(200);
    expect(health.headers.get('x-pay-mode')).toBe('sandbox');
  });

  it('INVÁLIDO: el banco niega una identidad ajena y un modo live, y la negativa también lleva X-Pay-Mode: sandbox', async () => {
    const stranger = await bank('/sandbox/probe', { from: 'pay-edge' });
    expect(stranger.status).toBe(403);
    expect(stranger.headers.get('x-pay-mode')).toBe('sandbox');
    expect((await bank('/sandbox/probe', { payMode: 'live' })).status).toBe(403);
    expect((await bank('/sandbox/probe', { payMode: null })).status).toBe(403);
  });

  it('CORRECTO: un cobro QR de Bs 100,00 pasa por pay-mockbank, queda succeeded y el ledger real deja 97,00 en pending y 3,00 en fees', async () => {
    const merchant = await seedMerchant(stack, { label: 'COMERCIO MOCKBANK (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const api = publicApi(stack, merchant);
    const created = await api.createQrIntent(10_000, 'mockbank-intent-0001-key');
    expect(created.status).toBe(201);
    const settled = await api.settle(created.intent.id);
    expect({ status: settled.status, error: settled.last_error }).toEqual({ status: 'succeeded', error: null });
    const ledger = await ledgerOfCapture(stack, merchant.merchantId, created.intent.id);
    expect(ledger).toMatchObject({ pending: 9_700, fees: 300, debits: 10_000, credits: 10_000, captureLinesOnPending: 1 });
    // El banco SIMULADO (no el banco en memoria del conector) registró el cobro: una línea de crédito por Bs 100,00 en la cuenta de cobros.
    expect((await collections()).filter((l) => l.direction === 'credit' && l.amount_minor === 10_000)).toHaveLength(1);
  });

  it('LÍMITE: rechazado (…01) termina failed y no asienta nada; duplicado (…03) deja UN asiento y UNA línea en el extracto', async () => {
    const merchant = await seedMerchant(stack, { label: 'COMERCIO MOCKBANK 2 (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const api = publicApi(stack, merchant);

    const declined = await api.createQrIntent(10_001, 'mockbank-declined-0001');
    expect(declined.status).toBe(201);
    const failed = await api.settle(declined.intent.id);
    expect(failed.status).toBe('failed');
    expect(failed.last_error?.code).toBe('payment_declined');
    expect(await ledgerOfCapture(stack, merchant.merchantId, declined.intent.id)).toMatchObject({ pending: 0, debits: 0, credits: 0, captureLinesOnPending: 0 });

    const duplicated = await api.createQrIntent(10_003, 'mockbank-duplicate-0001');
    expect(duplicated.status).toBe(201);
    const done = await api.settle(duplicated.intent.id);
    expect({ status: done.status, error: done.last_error }).toEqual({ status: 'succeeded', error: null });
    expect(await ledgerOfCapture(stack, merchant.merchantId, duplicated.intent.id)).toMatchObject({ debits: 10_003, credits: 10_003, captureLinesOnPending: 1 });
    expect((await collections()).filter((l) => l.direction === 'credit' && l.amount_minor === 10_003)).toHaveLength(1);
  });
});
