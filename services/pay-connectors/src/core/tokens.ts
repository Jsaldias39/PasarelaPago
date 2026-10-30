export const CLOCK = Symbol('CLOCK');
export const QR_PORT = Symbol('QR_PORT');
export const SECRETS = Symbol('SECRETS');
export const REGISTRY = Symbol('REGISTRY');
/** Pool pequeño y SEPARADO solo para los candados de envío: quien espera un candado nunca le quita conexiones al trabajo de los demás. */
export const LOCK_POOL = Symbol('LOCK_POOL');

/** Reloj inyectable: las pruebas lo mueven; el servicio usa el del sistema. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
