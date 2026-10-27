"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProblemError = exports.PROBLEM_CONTENT_TYPE = void 0;
exports.problem = problem;
exports.isProblemDetails = isProblemDetails;
const catalog_1 = require("./catalog");
/** Tipo de contenido de un error RFC 9457. */
exports.PROBLEM_CONTENT_TYPE = 'application/problem+json';
/**
 * Construye el cuerpo RFC 9457 de un código del catálogo.
 *
 * @param code - Código estable.
 * @param options - Detalle de esta ocurrencia.
 * @returns El cuerpo listo para serializar con {@link PROBLEM_CONTENT_TYPE}.
 */
function problem(code, options = {}) {
    const spec = catalog_1.PROBLEM_CATALOG[code];
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
class ProblemError extends Error {
    options;
    code;
    status;
    constructor(code, options = {}) {
        super(options.detail ?? catalog_1.PROBLEM_CATALOG[code].title);
        this.options = options;
        this.name = 'ProblemError';
        this.code = code;
        this.status = catalog_1.PROBLEM_CATALOG[code].status;
    }
    /** Cuerpo RFC 9457 de este error. */
    toProblem() {
        return problem(this.code, this.options);
    }
}
exports.ProblemError = ProblemError;
/**
 * Indica si un valor tiene la forma de un {@link ProblemDetails} de la pasarela.
 *
 * @param value - Valor desconocido (por ejemplo, un cuerpo de respuesta).
 */
function isProblemDetails(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const v = value;
    return (typeof v.type === 'string' &&
        typeof v.title === 'string' &&
        typeof v.status === 'number' &&
        typeof v.code === 'string' &&
        v.code in catalog_1.PROBLEM_CATALOG);
}
//# sourceMappingURL=problem.js.map