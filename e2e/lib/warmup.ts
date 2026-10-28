import { randomBytes } from 'node:crypto';
import type { Stack } from '../stack.ts';

export interface WarmUpReport {
  /** `pay-risk` evaluó una petición sintética de calentamiento (con cribado de comercio y de pagador contra el Watchman real). */
  readonly risk: { readonly attempted: boolean; readonly status: number | undefined; readonly ms: number | undefined };
}

/**
 * CALENTAMIENTO del camino de riesgo, declarado. `GET /health/ready` responde antes de que `pay-risk` haya hecho su PRIMERA evaluación (pool de base,
 * conexión a Watchman, compilación perezosa), y esa primera evaluación tarda decenas de ms de más. `pay-payments` le da 300 ms (`RISK_TIMEOUT_MS`) y
 * `pay-risk` cribará en 200 ms (`SCREENING_TIMEOUT_MS`): bajo carga (el arnés corre en una máquina compartida de 4 núcleos) la primera evaluación de un
 * intento real puede pasarse, y entonces se ven dos defectos de producto que NO son del arnés (ver ARNES.md § Hallazgos 9 y 10): el reintento recibe
 * `409 idempotency_request_in_progress` y `pay-payments` lo trata como rechazo definitivo (el intento queda `processing` para siempre), o `pay-risk`
 * guarda `deny` por «Watchman no pudo cribar» y el intento termina `risk_denied` con un comercio limpio.
 *
 * Este calentamiento NO arregla eso: baja la probabilidad de que la primera evaluación REAL de la prueba sea la lenta. La causa de fondo sigue abierta
 * y documentada; no se suben timeouts ni se reintentan pruebas. Es una petición sintética (comercio y pago inexistentes, nombres inventados) que no
 * toca a ningún otro servicio ni deja nada fuera de la base de `pay-risk`, que se vacía al apagar.
 */
export async function warmUp(stack: Stack): Promise<WarmUpReport> {
  if (!stack.services['pay-risk'].healthy) return { risk: { attempted: false, status: undefined, ms: undefined } };
  const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
  const started = Date.now();
  const res = await stack.callAs('pay-payments', 'pay-risk', 'POST', '/assessments', {
    headers: { 'idempotency-key': `warmup-${stack.runId}`, accept: 'application/json' },
    json: {
      merchant_id: id('mc'),
      payment_intent_id: id('pi'),
      amount_minor: 10_000,
      currency: 'BOB',
      method: 'qr',
      screening: { merchant_name: 'CALENTAMIENTO SINTETICO SRL', name: 'Persona Sintetica Calentamiento' },
    },
    timeoutMs: 10_000,
  }).catch(() => undefined);
  return { risk: { attempted: true, status: res?.status, ms: Date.now() - started } };
}
