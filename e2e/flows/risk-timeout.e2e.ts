import { publicApi } from '../lib/flow.ts';
import { seedMerchant, waitForEdgeToKnow } from '../lib/seed.ts';
import { startStack, stopStack, type Stack } from '../stack.ts';

/**
 * REPRODUCTOR (P3 · pay-payments, con P5 · pay-risk) — un resultado AMBIGUO del riesgo no es un fallo (CLAUDE.md regla 11).
 *
 * Defecto que reproduce (ARNES.md § Hallazgo 9): `pay-payments` llama a `pay-risk` con `RISK_TIMEOUT_MS` (300 ms por defecto) y, si vence, reintenta con
 * la MISMA clave de idempotencia (`<pi>:risk`). Mientras la primera evaluación sigue en curso en `pay-risk`, el reintento recibe
 * `409 idempotency_request_in_progress`. `services/pay-payments/src/temporal/activities.ts` (`assessRisk`, `isRejection(error)`) lo trata como un rechazo
 * definitivo de negocio (`ApplicationFailure.nonRetryable('RiskRejected')`): el workflow muere y el intento queda en `processing` PARA SIEMPRE (no
 * llega a `failed` ni a `succeeded`). Un 409 «en curso» significa «todavía no sé»: hay que reintentar con la misma clave hasta que responda.
 *
 * Esta prueba fuerza la ventana con un `RISK_TIMEOUT_MS` más corto que la evaluación (40 ms; la evaluación real tarda 60 a 300 ms). Esperado cuando P3 lo
 * corrija: los cobros terminan `succeeded` (o, como mínimo, en un estado TERMINAL con razón; nunca `processing` indefinido). HOY FALLA: queda en `processing`.
 * No está en la suite por defecto (`yarn e2e:pending`); pasa a `flows/` cuando P3 corrija `assessRisk`. Es un reproductor, no un test del arnés.
 */
describe('REPRODUCTOR — timeout del cliente de riesgo + 409 idempotency_request_in_progress', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack({ tolerateFailures: false, warmUp: false, envOverrides: { 'pay-payments': { RISK_TIMEOUT_MS: '40' } } });
  });
  afterAll(async () => {
    if (stack) expect((await stopStack(stack, { keepLogs: true })).leftoverPids).toEqual([]);
  });

  it('un cobro cuya primera evaluación de riesgo vence en el cliente NO queda en processing para siempre', async () => {
    const merchant = await seedMerchant(stack, { label: 'COMERCIO RIESGO-TIMEOUT (SINTÉTICO)' });
    expect((await waitForEdgeToKnow(stack, merchant)).ok).toBe(true);
    const api = publicApi(stack, merchant);
    const created = await Promise.all([1, 2, 3, 4].map((n) => api.createQrIntent(10_000, `risk-timeout-${n}-key-0001`)));
    expect(created.map((c) => c.status)).toEqual([201, 201, 201, 201]);
    const settled = await Promise.all(created.map((c) => api.settle(c.intent.id, 30_000)));
    expect(settled.map((s) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  });
});
