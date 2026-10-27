import { ProblemError } from '@pay/problem';

/**
 * Máquinas de estados de pay-payments (P3.H1.M3).
 *
 * `decideCallback` es la de `mantra-core-health-api` (`payment-callback-machine.ts`, origin/dev @ 4e64353a, MCH-011)
 * portada con los estados del cargo en el conector. Un proveedor reintenta y reordena entregas legítimas, así que un
 * `authorized` atrasado que llega después del `captured` NO puede hacer retroceder el cobro. Se decide qué *significa* el
 * evento respecto de lo ya sabido, no qué escribir:
 *
 *  - `aplicar`: avance legítimo.
 *  - `duplicado`: reentrega del mismo hecho; no muta nada.
 *  - `obsoleto`: entrega fuera de orden de un hecho ya superado; se ignora sin error.
 *  - `contradiccion`: el proveedor afirma algo incompatible con un estado terminal; NO se pisa, queda para conciliación humana.
 *
 * Cambios respecto del original: los estados son los del contrato de conectores (`pending|authorized|captured|failed|
 * canceled|expired`; se conserva `settled` para no cambiar la semántica ni el spec) y dos ramas terminales SIN dinero
 * (`failed`, `canceled`, `expired`) que se contradicen entre sí se tratan como `obsoleto`: no hay nada que conciliar.
 * No se porta `eventReference`: el evento del conector ya trae `provider_event_id`.
 */

export type DecisionCallback = 'aplicar' | 'duplicado' | 'obsoleto' | 'contradiccion';

export type ChargeState = 'pending' | 'authorized' | 'captured' | 'settled' | 'failed' | 'canceled' | 'expired';

/** Avance del camino de éxito. `failed`/`canceled`/`expired` son otra rama, no «menos» que `captured`. */
const CYCLE_ORDER: Readonly<Record<string, number>> = { pending: 0, authorized: 1, captured: 2, settled: 3 };

/** Transiciones admitidas. Lo que no está acá no se escribe. */
const CHARGE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ['authorized', 'captured', 'failed', 'canceled', 'expired'],
  authorized: ['captured', 'failed', 'canceled', 'expired'],
  captured: ['settled'], // lo informa la conciliación, no un callback
  settled: [],
  failed: [],
  canceled: [],
  expired: [],
};

const NO_MONEY_TERMINALS: ReadonlySet<string> = new Set(['failed', 'canceled', 'expired']);

/**
 * Clasifica un evento del conector ya verificado contra el estado conocido del cargo.
 *
 * @param actual - Estado del cargo que ya aplicamos.
 * @param target - Estado que informa el conector.
 */
export function decideCallback(actual: string, target: string): DecisionCallback {
  if (actual === target) return 'duplicado';
  if (CHARGE_TRANSITIONS[actual]?.includes(target)) return 'aplicar';

  const actualRank = CYCLE_ORDER[actual];
  const targetRank = CYCLE_ORDER[target];
  if (actualRank !== undefined && targetRank !== undefined && targetRank < actualRank) return 'obsoleto';
  // Dos finales sin dinero que no coinciden (por ejemplo `canceled` y luego `expired`): nada que conciliar.
  if (NO_MONEY_TERMINALS.has(actual) && NO_MONEY_TERMINALS.has(target)) return 'obsoleto';
  return 'contradiccion';
}

export type IntentStatus = 'requires_action' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'expired';

export const TERMINAL_STATUSES: ReadonlySet<IntentStatus> = new Set(['succeeded', 'failed', 'canceled', 'expired']);

/**
 * Ciclo de vida del intento: processing (riesgo + cargo) → requires_action (espera al pagador) → processing (confirmado,
 * registrando en el ledger) → terminal. Un cobro con saldo AloVida pasa directo de processing a succeeded.
 * Un terminal no cambia nunca: un cobro termina en UN solo estado (kill-test del carril).
 */
const INTENT_TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  processing: ['requires_action', 'succeeded', 'failed', 'canceled', 'expired'],
  requires_action: ['processing', 'succeeded', 'failed', 'canceled', 'expired'],
  succeeded: [],
  failed: [],
  canceled: [],
  expired: [],
};

export const isTerminal = (status: string): boolean => TERMINAL_STATUSES.has(status as IntentStatus);

export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  return INTENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** @throws ProblemError `invalid_state_transition` (409) si la transición no está admitida. */
export function assertTransition(from: IntentStatus, to: IntentStatus): void {
  if (!canTransition(from, to)) {
    throw new ProblemError('invalid_state_transition', { detail: `Un cobro ${from} no puede pasar a ${to}` });
  }
}

export interface ConnectorEventDecision {
  readonly decision: DecisionCallback;
  /** Por qué se decidió así; va al log y a la tabla de contradicciones, nunca a datos de personas. */
  readonly reason: string;
}

/**
 * Decisión final ante un evento `connector.transaction.status_changed` de tipo cargo.
 * Suma a `decideCallback` la mirada del intento: dinero capturado para un intento que ya terminó sin éxito
 * (vencido, cancelado, fallido) es siempre una contradicción, aunque el cargo todavía figure `pending`.
 */
export function decideConnectorEvent(input: { intentStatus: IntentStatus; chargeStatus: string; incoming: string }): ConnectorEventDecision {
  const byCharge = decideCallback(input.chargeStatus, input.incoming);
  if (input.incoming === 'captured' && isTerminal(input.intentStatus) && input.intentStatus !== 'succeeded' && byCharge !== 'duplicado') {
    return { decision: 'contradiccion', reason: `captured_for_${input.intentStatus}_intent` };
  }
  return { decision: byCharge, reason: `charge_${input.chargeStatus}_to_${input.incoming}` };
}
