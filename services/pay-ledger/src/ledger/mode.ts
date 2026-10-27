import { ProblemError } from '@pay/problem';

/** Modo de la CLAVE que hizo la petición pública (D-28). No es el del despliegue (`PAY_MODE=sandbox|live`, D-26). */
export type PayMode = 'test' | 'live';
export const PAY_MODES: readonly PayMode[] = ['test', 'live'];

/**
 * `X-Pay-Mode` lo fija `pay-edge` desde el registro de la clave y llega por la cabecera: nunca sale del cuerpo, de la consulta ni de un
 * valor por defecto. Ausente, repetido o distinto de `test|live` ⇒ `403 forbidden` sin decir cuál fue el problema; nunca se cae en `live`.
 */
export function requirePayMode(header: string | string[] | undefined): PayMode {
  if (typeof header === 'string' && (header === 'test' || header === 'live')) return header;
  throw new ProblemError('forbidden', { detail: 'Falta el modo de la operación o no es válido' });
}
