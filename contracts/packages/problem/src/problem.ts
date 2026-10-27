import { PROBLEM_CATALOG, type ProblemCode } from './catalog';

/** Tipo de contenido de un error RFC 9457. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Error de un campo de la petición. */
export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message?: string;
}

/** Cuerpo de un error RFC 9457 con el `code` estable de la pasarela. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail?: string;
  readonly instance?: string;
  readonly request_id?: string;
  readonly errors?: readonly FieldError[];
}

/** Datos opcionales al construir un error. */
export interface ProblemOptions {
  /** Explicación de esta ocurrencia. Nunca incluyas datos personales ni de tarjeta. */
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  readonly errors?: readonly FieldError[];
}

/**
 * Construye el cuerpo RFC 9457 de un código del catálogo.
 *
 * @param code - Código estable.
 * @param options - Detalle de esta ocurrencia.
 * @returns El cuerpo listo para serializar con {@link PROBLEM_CONTENT_TYPE}.
 */
export function problem(code: ProblemCode, options: ProblemOptions = {}): ProblemDetails {
  const spec = PROBLEM_CATALOG[code];
  return {
    type: `urn:alovida:pay:problem:${code}`,
    title: spec.title,
    status: spec.status,
    code,
    ...(options.detail !== undefined && { detail: options.detail }),
    ...(options.instance !== undefined && { instance: options.instance }),
    ...(options.requestId !== undefined && { request_id: options.requestId }),
    ...(options.errors !== undefined && { errors: options.errors }),
  };
}

/** Error de dominio que se traduce a un {@link ProblemDetails}. */
export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly status: number;

  constructor(
    code: ProblemCode,
    private readonly options: ProblemOptions = {},
  ) {
    super(options.detail ?? PROBLEM_CATALOG[code].title);
    this.name = 'ProblemError';
    this.code = code;
    this.status = PROBLEM_CATALOG[code].status;
  }

  /** Cuerpo RFC 9457 de este error. */
  toProblem(): ProblemDetails {
    return problem(this.code, this.options);
  }
}

/**
 * Indica si un valor tiene la forma de un {@link ProblemDetails} de la pasarela.
 *
 * @param value - Valor desconocido (por ejemplo, un cuerpo de respuesta).
 */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'number' &&
    typeof v.code === 'string' &&
    v.code in PROBLEM_CATALOG
  );
}
