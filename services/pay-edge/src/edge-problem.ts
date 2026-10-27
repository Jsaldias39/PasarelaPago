import { PROBLEM_CATALOG, problem, type ProblemCode } from '@pay/problem';

/**
 * Errores que pay-edge produce por su cuenta, con estado, cabeceras y cuerpo RFC 9457 ya resueltos.
 *
 * `upstream_*` no están en el catálogo de `@pay/problem` (ver docs/trabajo/ola-1/P1/PROPUESTAS.md, propuesta 2): el borde
 * los arma acá hasta que el catálogo y `public-v1.yaml` los declaren. El `code` sigue la misma regla `^[a-z][a-z0-9_]*$`.
 */
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

const EXTRA = {
  upstream_error: { status: 502, title: 'El servicio de destino respondió algo inválido' },
  upstream_unavailable: { status: 503, title: 'El servicio de destino no está disponible' },
  upstream_timeout: { status: 504, title: 'El servicio de destino no respondió a tiempo' },
} as const;

export type EdgeExtraCode = keyof typeof EXTRA;

export interface FailOptions {
  readonly detail?: string;
  readonly errors?: readonly { field: string; code: string; message?: string }[];
  readonly headers?: Readonly<Record<string, string>>;
}

/** Error del catálogo (`unauthorized`, `rate_limited`…) o de los extra del borde, listo para lanzar. */
export function fail(code: ProblemCode | EdgeExtraCode, options: FailOptions = {}): EdgeProblemError {
  if (code in EXTRA) {
    const spec = EXTRA[code as EdgeExtraCode];
    return new EdgeProblemError(
      spec.status,
      { type: `urn:alovida:pay:problem:${code}`, title: spec.title, status: spec.status, code, ...(options.detail && { detail: options.detail }) },
      options.headers,
    );
  }
  const body = problem(code as ProblemCode, { ...(options.detail && { detail: options.detail }), ...(options.errors && { errors: options.errors }) });
  return new EdgeProblemError(PROBLEM_CATALOG[code as ProblemCode].status, { ...body }, options.headers);
}
