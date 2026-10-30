import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';

/** Modo de la CLAVE que hizo la petición pública (D-28). No es el del despliegue (`PAY_MODE=sandbox|live`, D-26). */
export type PayMode = 'test' | 'live';

const forbidden = () => new ProblemError('forbidden', { detail: 'El modo de la operación falta, no es válido o no corresponde a este despliegue' });

/**
 * `X-Pay-Mode` lo fija `pay-edge` desde el registro de la clave y llega por la cabecera: nunca del cuerpo, de la consulta ni de un valor por
 * defecto. Ausente, repetido o distinto de `test|live` ⇒ `403 forbidden` sin decir cuál fue el problema; nunca se cae en `live`.
 */
export function parsePayMode(header: string | string[] | undefined): PayMode {
  if (header === 'test' || header === 'live') return header;
  throw forbidden();
}

/** Compuerta de modo de las rutas internas: valida la cabecera y que el modo coincida con el del DESPLIEGUE (`test` ↔ sandbox, `live` ↔ live). */
@Injectable()
export class ModeGate {
  constructor(@Inject(SERVICE_CONFIG) private readonly config: ServiceConfig) {}

  require(header: string | string[] | undefined): PayMode {
    const mode = parsePayMode(header);
    if ((mode === 'test' ? 'sandbox' : 'live') !== this.config.mode) throw forbidden();
    return mode;
  }
}
