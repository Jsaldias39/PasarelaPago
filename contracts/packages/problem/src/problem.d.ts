import { type ProblemCode } from './catalog';
/** Tipo de contenido de un error RFC 9457. */
export declare const PROBLEM_CONTENT_TYPE = "application/problem+json";
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
export declare function problem(code: ProblemCode, options?: ProblemOptions): ProblemDetails;
/** Error de dominio que se traduce a un {@link ProblemDetails}. */
export declare class ProblemError extends Error {
    private readonly options;
    readonly code: ProblemCode;
    readonly status: number;
    constructor(code: ProblemCode, options?: ProblemOptions);
    /** Cuerpo RFC 9457 de este error. */
    toProblem(): ProblemDetails;
}
/**
 * Indica si un valor tiene la forma de un {@link ProblemDetails} de la pasarela.
 *
 * @param value - Valor desconocido (por ejemplo, un cuerpo de respuesta).
 */
export declare function isProblemDetails(value: unknown): value is ProblemDetails;
