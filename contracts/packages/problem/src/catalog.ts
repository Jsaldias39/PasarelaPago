/** Entrada del catálogo: el estado HTTP y el título que acompañan a un `code` estable. */
export interface ProblemSpec {
  readonly status: number;
  readonly title: string;
}

/**
 * Catálogo de códigos de error que el cliente distingue. Los `code` son contrato (REQ del plan,
 * regla 96.4): se agregan, no se renombran ni se reutilizan. El texto de `title` no es contrato.
 */
export const PROBLEM_CATALOG = {
  // Autenticación y autorización
  unauthorized: { status: 401, title: 'Falta una credencial válida' },
  forbidden: { status: 403, title: 'No tenés permiso para esta operación' },
  merchant_suspended: { status: 403, title: 'El comercio está suspendido' },
  resource_not_found: { status: 404, title: 'No existe el recurso' },
  // Forma de la petición
  validation_failed: { status: 422, title: 'La petición no es válida' },
  idempotency_key_required: { status: 400, title: 'Falta la cabecera Idempotency-Key' },
  idempotency_key_reused: { status: 422, title: 'La Idempotency-Key ya se usó con otra petición' },
  idempotency_request_in_progress: { status: 409, title: 'La petición con esta Idempotency-Key sigue en curso' },
  rate_limited: { status: 429, title: 'Demasiadas peticiones' },
  // Dinero y estados
  insufficient_funds: { status: 422, title: 'Fondos insuficientes' },
  fee_exceeds_amount: { status: 422, title: 'La comisión supera el importe' },
  invalid_state_transition: { status: 409, title: 'La operación no es válida en el estado actual' },
  transfer_not_found: { status: 404, title: 'No existe la transferencia' },
  // Dependencias
  risk_unavailable: { status: 503, title: 'El control de riesgo no está disponible' },
  connector_unavailable: { status: 502, title: 'El proveedor de pago no está disponible' },
  ledger_unavailable: { status: 503, title: 'El libro mayor no está disponible' },
  internal_error: { status: 500, title: 'Error interno' },
} as const satisfies Record<string, ProblemSpec>;

/** Códigos de error conocidos. */
export type ProblemCode = keyof typeof PROBLEM_CATALOG;
