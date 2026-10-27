import type { PayMode } from './mode';

/**
 * `mode` en los datos de los eventos `ledger.*` (D-28). El AsyncAPI de hoy NO lo declara y los datos son `additionalProperties: false`, así
 * que por defecto NO se emite (un evento con un campo de más lo rechazaría el contrato). Cuando el contrato lo admita se enciende con
 * `EVENTS_CARRY_MODE=true`, sin tocar código: cada evento ya conoce el modo de su asiento o retención.
 */
let enabled = false;

export function setEventsCarryMode(on: boolean): void {
  enabled = on;
}

export function eventModeField(mode: PayMode): { mode?: PayMode } {
  return enabled ? { mode } : {};
}
