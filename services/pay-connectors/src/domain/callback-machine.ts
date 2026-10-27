import type { ProviderStatus } from './connector';

/**
 * Máquina de estados del cobro frente a un callback ya autenticado.
 *
 * PROCEDENCIA: adaptado de `mdavila-2001/mantra-core-health-api`, `src/modules/payments/services/payment-callback-machine.ts`
 * (origin/dev @ 4e64353a). Allí el vocabulario eran conceptos de transacción de gateway (PROCESSING/AUTHORIZED/CAPTURED/SETTLED);
 * acá es el del proveedor del contrato de eventos. La idea no cambia: no se decide «qué estado escribir» sino **qué significa el
 * evento** respecto del estado ya conocido, porque un proveedor reintenta y reordena entregas legítimas.
 *
 * - `aplicar`: avance legítimo.
 * - `duplicado`: reentrega del mismo hecho; no muta nada.
 * - `obsoleto`: hecho anterior ya superado (`authorized` después de `captured`); se ignora sin retroceder.
 * - `contradiccion`: incompatible con un estado terminal (`failed` después de `captured`, `captured` después de `expired`…);
 *   no se sobrescribe y queda para conciliación humana.
 */
export type Decision = 'aplicar' | 'duplicado' | 'obsoleto' | 'contradiccion';

/** Orden del camino de éxito. `failed`, `canceled` y `expired` son otras ramas: su choque con `captured` es una contradicción. */
const CYCLE_ORDER: Readonly<Partial<Record<ProviderStatus, number>>> = { pending: 0, authorized: 1, captured: 2 };

/** Transiciones admitidas. Lo que no está acá no se escribe. */
const TRANSITIONS: Readonly<Record<ProviderStatus, readonly ProviderStatus[]>> = {
  pending: ['authorized', 'captured', 'failed', 'canceled', 'expired'],
  authorized: ['captured', 'failed', 'canceled', 'expired'],
  // Capturado es terminal para este callback: liquidar lo informa la conciliación, no el callback.
  captured: [],
  failed: [],
  canceled: [],
  expired: [],
};

export function decideCallback(actual: ProviderStatus, target: ProviderStatus): Decision {
  if (actual === target) return 'duplicado';
  if (TRANSITIONS[actual].includes(target)) return 'aplicar';
  const rangeActual = CYCLE_ORDER[actual];
  const rangeTarget = CYCLE_ORDER[target];
  if (rangeActual !== undefined && rangeTarget !== undefined && rangeTarget < rangeActual) return 'obsoleto';
  return 'contradiccion';
}

/** Resultado público (`CallbackResult.result` del contrato). */
export function callbackResultOf(decision: Decision): 'applied' | 'duplicate' | 'stale' | 'contradiction' {
  return { aplicar: 'applied', duplicado: 'duplicate', obsoleto: 'stale', contradiccion: 'contradiction' }[decision] as 'applied' | 'duplicate' | 'stale' | 'contradiction';
}
