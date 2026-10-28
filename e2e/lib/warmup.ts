import { randomBytes } from 'node:crypto';
import type { Stack } from '../stack.ts';

export interface WarmUpReport {
  /**
   * `pay-risk` evaluó peticiones sintéticas de calentamiento (cribado de comercio y de pagador contra el Watchman real) hasta obtener
   * `healthyStreak` seguidas con `screened: true` y `allow` (el cribado terminó DENTRO de su presupuesto de tiempo).
   */
  readonly risk: { readonly attempted: boolean; readonly ready: boolean; readonly attempts: number; readonly healthyStreak: number; readonly lastStatus: number | undefined; readonly lastDecision: string | undefined; readonly lastMs: number | undefined; readonly totalMs: number };
}

/** Evaluaciones sanas seguidas que se exigen antes de dar por caliente el camino de riesgo, y tope de espera. */
const REQUIRED_STREAK = 3;
const MAX_WAIT_MS = 90_000;

/**
 * CALENTAMIENTO del camino de riesgo, declarado, por CONDICIÓN (no por tiempo). `GET /health/ready` responde antes de que `pay-risk` haya hecho su
 * primera evaluación (pool de base, conexión a Watchman, compilación perezosa) y esa primera evaluación tarda ~300 ms (medido: 280 y 312 ms en dos
 * arranques en frío; `evidencia/2h-risk-primera-evaluacion.txt`). `pay-payments` le da 300 ms (`RISK_TIMEOUT_MS`) y `pay-risk` cribará en 200 ms
 * (`SCREENING_TIMEOUT_MS`, tope 250). El arnés corre en una máquina compartida de 4 núcleos con la carga muchas veces por encima de 10, donde Watchman
 * (que busca en memoria las listas OFAC) pasa de p50 30 ms / p90 65 ms a p50 100 ms / p90 383 ms (`evidencia/2h-watchman-latencia.txt`): cualquier evaluación puede
 * pasarse de tiempo. Eso destapa dos defectos de PRODUCTO que NO son del arnés y siguen abiertos (ver ARNES.md § Hallazgos 9 y 10): el reintento recibe
 * `409 idempotency_request_in_progress` y `pay-payments` lo trata como rechazo definitivo (el intento queda `processing` para siempre), o `pay-risk`
 * guarda `deny` por «Watchman no pudo cribar» y un comercio limpio termina `risk_denied`.
 *
 * Esto NO arregla eso: espera, por condición y con tope, a que el camino de riesgo conteste dentro del presupuesto varias veces seguidas ANTES de
 * que arranque la prueba. No sube timeouts ni reintenta pruebas. Las peticiones son sintéticas (comercio y pago inexistentes, nombres inventados que no
 * puntúan en Watchman), tocan solo `pay-risk` y su base se vacía al apagar. Si no llega a la racha dentro del tope, lo informa (`ready: false`) y la
 * prueba corre igual: no se oculta que el entorno estaba saturado.
 */
export async function warmUp(stack: Stack): Promise<WarmUpReport> {
  const empty: { -readonly [K in keyof WarmUpReport['risk']]: WarmUpReport['risk'][K] } = { attempted: false, ready: false, attempts: 0, healthyStreak: 0, lastStatus: undefined, lastDecision: undefined, lastMs: undefined, totalMs: 0 };
  if (!stack.services['pay-risk'].healthy) return { risk: empty };
  const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
  const started = Date.now();
  const report = { ...empty, attempted: true };
  while (Date.now() - started < MAX_WAIT_MS && report.healthyStreak < REQUIRED_STREAK) {
    const t0 = Date.now();
    const res = await stack
      .callAs('pay-payments', 'pay-risk', 'POST', '/assessments', {
        headers: { 'idempotency-key': `warmup-${stack.runId}-${report.attempts}`, accept: 'application/json' },
        json: { merchant_id: id('mc'), payment_intent_id: id('pi'), amount_minor: 10_000, currency: 'BOB', method: 'qr', screening: { merchant_name: 'CALENTAMIENTO SINTETICO SRL', name: 'Persona Sintetica Calentamiento' } },
        timeoutMs: 10_000,
      })
      .catch(() => undefined);
    const body = res?.json as { decision?: string; screened?: boolean } | undefined;
    report.attempts += 1;
    report.lastStatus = res?.status;
    report.lastDecision = body?.decision;
    report.lastMs = Date.now() - t0;
    const healthy = res?.status === 201 && body?.screened === true && body?.decision === 'allow';
    report.healthyStreak = healthy ? report.healthyStreak + 1 : 0;
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { risk: { ...report, ready: report.healthyStreak >= REQUIRED_STREAK, totalMs: Date.now() - started } };
}
