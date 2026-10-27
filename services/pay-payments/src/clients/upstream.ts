import { HttpClient, UpstreamError, type HttpResponse } from './http';

/** Respuesta de negocio rechazada por la dependencia (4xx con Problem): un fallo de ESTA operación, no de la dependencia. */
export class UpstreamRejection extends Error {
  constructor(
    readonly upstream: string,
    readonly status: number,
    /** `code` estable del Problem (RFC 9457) si vino; nunca el mensaje crudo. */
    readonly code: string | undefined,
  ) {
    super(`${upstream} rechazó la operación (${status}${code ? ` ${code}` : ''})`);
    this.name = 'UpstreamRejection';
  }
}

export function problemCode(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : undefined;
}

export { HttpClient, UpstreamError };
export type { HttpResponse };
