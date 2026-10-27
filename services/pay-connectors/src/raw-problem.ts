/**
 * Problema RFC 9457 con un `code` que el catálogo de `@pay/problem` todavía no tiene. Hoy: `bad_request` (400) para un callback
 * cuya autenticación pasó pero cuyo cuerpo no se puede interpretar. Propuesta de código al catálogo: docs/trabajo/ola-1/P4/PROPUESTAS.md.
 */
export class RawProblemError extends Error {
  readonly body: { type: string; title: string; status: number; code: string; detail?: string };

  constructor(status: number, code: string, title: string, detail?: string) {
    super(code);
    this.body = { type: `urn:alovida:pay:problem:${code}`, title, status, code, ...(detail !== undefined && { detail }) };
  }
}

export const badRequest = (detail: string): RawProblemError => new RawProblemError(400, 'bad_request', 'Petición mal formada', detail);
