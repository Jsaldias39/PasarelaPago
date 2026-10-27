export const CLOCK = Symbol('CLOCK');
export const QR_PORT = Symbol('QR_PORT');
export const SECRETS = Symbol('SECRETS');
export const REGISTRY = Symbol('REGISTRY');

/** Reloj inyectable: las pruebas lo mueven; el servicio usa el del sistema. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
