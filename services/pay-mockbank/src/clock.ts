/** Reloj inyectable: las pruebas lo mueven; en el proceso real es la hora del sistema. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export const systemClock: Clock = { now: () => new Date() };
