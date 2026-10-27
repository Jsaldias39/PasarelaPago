/** Entrada del catálogo: el estado HTTP y el título que acompañan a un `code` estable. */
export interface ProblemSpec {
    readonly status: number;
    readonly title: string;
}
/**
 * Catálogo de códigos de error que el cliente distingue. Los `code` son contrato (REQ del plan,
 * regla 96.4): se agregan, no se renombran ni se reutilizan. El texto de `title` no es contrato.
 */
export declare const PROBLEM_CATALOG: {
    readonly unauthorized: {
        readonly status: 401;
        readonly title: "Falta una credencial válida";
    };
    readonly forbidden: {
        readonly status: 403;
        readonly title: "No tenés permiso para esta operación";
    };
    readonly merchant_suspended: {
        readonly status: 403;
        readonly title: "El comercio está suspendido";
    };
    readonly resource_not_found: {
        readonly status: 404;
        readonly title: "No existe el recurso";
    };
    readonly validation_failed: {
        readonly status: 422;
        readonly title: "La petición no es válida";
    };
    readonly idempotency_key_required: {
        readonly status: 400;
        readonly title: "Falta la cabecera Idempotency-Key";
    };
    readonly idempotency_key_reused: {
        readonly status: 422;
        readonly title: "La Idempotency-Key ya se usó con otra petición";
    };
    readonly idempotency_request_in_progress: {
        readonly status: 409;
        readonly title: "La petición con esta Idempotency-Key sigue en curso";
    };
    readonly rate_limited: {
        readonly status: 429;
        readonly title: "Demasiadas peticiones";
    };
    readonly insufficient_funds: {
        readonly status: 422;
        readonly title: "Fondos insuficientes";
    };
    readonly fee_exceeds_amount: {
        readonly status: 422;
        readonly title: "La comisión supera el importe";
    };
    readonly invalid_state_transition: {
        readonly status: 409;
        readonly title: "La operación no es válida en el estado actual";
    };
    readonly risk_unavailable: {
        readonly status: 503;
        readonly title: "El control de riesgo no está disponible";
    };
    readonly connector_unavailable: {
        readonly status: 502;
        readonly title: "El proveedor de pago no está disponible";
    };
    readonly ledger_unavailable: {
        readonly status: 503;
        readonly title: "El libro mayor no está disponible";
    };
    readonly internal_error: {
        readonly status: 500;
        readonly title: "Error interno";
    };
};
/** Códigos de error conocidos. */
export type ProblemCode = keyof typeof PROBLEM_CATALOG;
