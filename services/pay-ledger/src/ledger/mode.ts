import { ProblemError } from '@pay/problem';

/** Modo de la CLAVE que hizo la petición pública (D-28). No es el del despliegue (`PAY_MODE=sandbox|live`, D-26). */
export type PayMode = 'test' | 'live';
export const PAY_MODES: readonly PayMode[] = ['test', 'live'];

/** Modo de DESPLIEGUE (`PAY_MODE`, D-26). Una clave `test` solo opera contra un despliegue `sandbox`; una `live`, contra uno `live`. */
export type DeploymentMode = 'sandbox' | 'live';
export const KEY_MODE_OF: Readonly<Record<DeploymentMode, PayMode>> = { sandbox: 'test', live: 'live' };

/**
 * `X-Pay-Mode` lo fija `pay-edge` desde el registro de la clave y llega por la cabecera: nunca sale del cuerpo, de la consulta ni de un
 * valor por defecto. Ausente, repetido o distinto de `test|live` ⇒ `403 forbidden` sin decir cuál fue el problema; nunca se cae en `live`.
 * Además tiene que corresponder al despliegue (`PAY_MODE`): una clave `test` contra un ledger `live` (o al revés) es `403`, igual de mudo.
 */
export function requirePayMode(header: string | string[] | undefined, deployment: DeploymentMode): PayMode {
  if (header === 'test' || header === 'live') {
    if (header === KEY_MODE_OF[deployment]) return header;
    throw new ProblemError('forbidden', { detail: 'El modo de la clave no corresponde a este despliegue' });
  }
  throw new ProblemError('forbidden', { detail: 'Falta el modo de la operación o no es válido' });
}
