import type { PayMode } from './mode';

/**
 * `mode` en los datos de `settlement.batch.closed` y `reconciliation.exception.opened` (D-28). El AsyncAPI de hoy NO lo declara en esos dos
 * (sí en `payout.*`, que lo llevan siempre) y sus datos son `additionalProperties: false`, así que por defecto NO se emite. Cuando el
 * contrato lo admita se enciende con `EVENTS_CARRY_MODE=true`, sin tocar código: cada evento ya conoce el modo de su corte o corrida.
 */
let enabled = false;

export function setEventsCarryMode(on: boolean): void {
  enabled = on;
}

export function eventModeField(mode: PayMode | null | undefined): { mode?: PayMode } {
  return enabled && mode ? { mode } : {};
}
