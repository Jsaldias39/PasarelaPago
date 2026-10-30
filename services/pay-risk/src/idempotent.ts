import { ProblemError, type ProblemDetails } from '@pay/problem';

/**
 * El almacén de idempotencia guarda un error de negocio (< 500) como resultado y lo devuelve igual en las repeticiones.
 * Esto lo vuelve a lanzar para que salga por el filtro como RFC 9457 con su estado original, nunca como un 2xx.
 */
export function rethrowStoredProblem(result: { status: number; body: unknown }): void {
  if (result.status < 400) return;
  const stored = result.body as ProblemDetails;
  throw new ProblemError(stored.code, { ...(stored.detail !== undefined && { detail: stored.detail }), ...(stored.errors !== undefined && { errors: stored.errors }) });
}
