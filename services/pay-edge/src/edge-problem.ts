import { PROBLEM_CATALOG, problem, type ProblemCode } from '@pay/problem';

/** Errores que pay-edge produce por su cuenta, con estado, cabeceras y cuerpo RFC 9457 ya resueltos (todos del catálogo de `@pay/problem`). */
export class EdgeProblemError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(String(body.code));
    this.name = 'EdgeProblemError';
  }
}

export interface FailOptions {
  readonly detail?: string;
  readonly errors?: readonly { field: string; code: string; message?: string }[];
  readonly headers?: Readonly<Record<string, string>>;
}

/** Error del catálogo (`unauthorized`, `rate_limited`, `upstream_*`…), con estado, cabeceras y cuerpo RFC 9457 listos para lanzar. */
export function fail(code: ProblemCode, options: FailOptions = {}): EdgeProblemError {
  const body = problem(code, { ...(options.detail && { detail: options.detail }), ...(options.errors && { errors: options.errors }) });
  return new EdgeProblemError(PROBLEM_CATALOG[code].status, { ...body }, options.headers);
}
