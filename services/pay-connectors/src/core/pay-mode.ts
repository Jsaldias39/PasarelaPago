import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import type { Mode } from '../domain/connector';

/** Modo de la CLAVE que hizo la petición pública (D-28). No es el del despliegue (`PAY_MODE=sandbox|live`, D-26) ni el del conector. */
export type PayMode = 'test' | 'live';

/** Modo de despliegue que corresponde a un modo de clave: una clave `test` solo opera en `sandbox`, una `live` solo en `live`. */
export const deploymentModeOf = (mode: PayMode): Mode => (mode === 'test' ? 'sandbox' : 'live');

const forbidden = () => new ProblemError('forbidden', { detail: 'El modo de la operación falta, no es válido o no corresponde a este despliegue' });

/**
 * `X-Pay-Mode` lo fija `pay-edge` desde el registro de la clave y llega por la cabecera: nunca del cuerpo, de la consulta, de un callback
 * ni de un valor por defecto. Ausente, repetido o distinto de `test|live` ⇒ `403 forbidden` sin decir cuál fue el problema; nunca se cae en `live`.
 */
export function parsePayMode(header: string | string[] | undefined): PayMode {
  if (header === 'test' || header === 'live') return header;
  throw forbidden();
}

/** Compuerta de modo de las rutas internas: valida la cabecera y que el modo de la petición coincida con el del DESPLIEGUE. */
@Injectable()
export class ModeGate {
  constructor(@Inject(SERVICE_CONFIG) private readonly config: ServiceConfig) {}

  /** Exige el modo. `live` contra un despliegue `sandbox` (o `test` contra uno `live`) ⇒ `403`, sin efecto. */
  require(header: string | string[] | undefined): PayMode {
    const mode = parsePayMode(header);
    if (deploymentModeOf(mode) !== this.config.mode) throw forbidden();
    return mode;
  }

  /** Para operaciones donde el contrato lo declara opcional (extractos, salud): si viene, se valida igual; si no, no hay modo. */
  optional(header: string | string[] | undefined): PayMode | undefined {
    return header === undefined ? undefined : this.require(header);
  }
}
