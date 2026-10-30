import { publicApi } from '../lib/flow.ts';
import { fundWallet } from '../lib/p5-schedules.ts';
import { refundApi, refundLedger, refundRows } from '../lib/refund-flow.ts';
import { seedMerchant, waitForEdgeToKnow } from '../lib/seed.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * REGRESIÓN del hallazgo 13 (corregido en pay-connectors, ola 3, P4; era un reproductor en pending/) — E3, fallo DEFINITIVO del conector de punta a punta. Reproductor del hallazgo 13 de docs/trabajo/ola-2/P1/ARNES.md.
 *
 * Contrato que se espera (workflows.ts `RefundWorkflow` y connectors.client.ts `definitive502`): con el banco caído, `pay-connectors` responde `502 connector_unavailable`
 * (sin efecto garantizado); `pay-payments` lo toma como rechazo DEFINITIVO, anula la retención del ledger y deja el reembolso `failed`.
 *
 * Lo que pasa hoy: el reembolso se queda `pending` con la retención viva mientras el banco esté caído. Causa (reproducida y medida, ver evidencia/e3-hallazgo-fallo-definitivo.txt):
 *  1. `pay-payments` `HttpClient.request` (clients/http.ts) reintenta TODO error de la dependencia, también el `502` con su cuerpo exacto `connector_unavailable`, a los 50 ms y con la misma `Idempotency-Key`.
 *  2. `pay-connectors` `RefundsService.send` no baja la marca `may_have_reached_provider` (monótona a propósito): el segundo envío con el banco aún caído ya no es «sin efecto» sino AMBIGUO (500).
 *  3. Lo que ve `definitive502` es el último error (500), no el 502 definitivo: el fallo se trata como ambiguo (regla 11) y la retención NO se anula.
 * Es seguro en dinero (nada se anula ni se da por fallido por ambigüedad) pero el fallo definitivo nunca se reconoce: el comercio queda con el importe retenido hasta que el banco vuelva.
 */
describe('E3 pendiente — fallo definitivo del conector (502 connector_unavailable) deja el reembolso failed y la retención anulada', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({
      tolerateFailures: false,
      mockbank: true,
      envOverrides: { 'pay-payments': { REFUND_WAIT_MS: '3000', STATUS_INQUIRY_MS: '1000', ACTIVITY_MAX_ATTEMPTS: '2', ACTIVITY_INITIAL_MS: '200', ACTIVITY_MAX_MS: '500', ACTIVITY_SLOW_RETRY_MS: '1000' } },
    });
  }, 600_000);
  afterAll(async () => {
    if (stack) {
      await stack.callAs('pay-mockbank', 'pay-mockbank', 'PUT', '/sandbox/admin/down', { json: { down: false } }).catch(() => undefined);
      expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
    }
  });

  it('con el banco caído el reembolso termina failed (connector_unavailable), la retención queda anulada y el disponible vuelve entero', async () => {
    const merchant = await seedMerchant(stack, { label: 'COMERCIO E3 DEFINITIVO (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const api = publicApi(stack, merchant);
    const created = await api.createQrIntent(10_000, 'e3-pend-intent-0001');
    expect((await api.settle(created.intent.id)).status).toBe('succeeded');
    await fundWallet(stack, merchant.merchantId, 20_000, 'refund_opening');
    const available = `merchant:${merchant.merchantId}:available`;
    const ledger = refundLedger(stack);
    const refunds = refundApi(stack, merchant);

    expect((await stack.callAs('pay-mockbank', 'pay-mockbank', 'PUT', '/sandbox/admin/down', { json: { down: true } })).status).toBe(200);
    const refund = await refunds.create(created.intent.id, 4_000, 'e3-pend-refund-0001');
    expect(refund.status).toBe(201);
    const outcome = await refunds.settle(refund.body.id, 30_000); // FALLA HOY: sigue `pending` (ver el encabezado)
    expect(outcome).toMatchObject({ status: 'failed', failure_code: 'connector_unavailable' });

    const rows = await refundRows(stack, refund.body.id);
    expect(await ledger.hold(rows.payment[0]!.ledger_hold_id!)).toMatchObject({ status: 'voided' });
    expect(await ledger.balance(available)).toEqual({ available: 20_000, pendingDebits: 0 });
    expect(await ledger.linesOfRef(available, `${refund.body.id}:refund`)).toEqual([]);
    expect(rows.bank).toEqual([]);
  });
});
