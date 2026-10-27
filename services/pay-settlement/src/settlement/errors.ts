/** El ledger rechazó la operación por una razón de negocio (no es un fallo de red). */
export class LedgerRejectedError extends Error {
  constructor(
    readonly code: 'insufficient_funds' | 'validation_failed' | 'invalid_state_transition',
    readonly detail?: string,
  ) {
    super(`ledger rechazó: ${code}`);
    this.name = 'LedgerRejectedError';
  }
}

/** No se pudo hablar con el ledger (red, 5xx, tiempo agotado): el resultado de la llamada es desconocido. */
export class LedgerUnavailableError extends Error {
  constructor(message = 'ledger no disponible') {
    super(message);
    this.name = 'LedgerUnavailableError';
  }
}

/** El riel NO ejecutó la orden (por ejemplo, 502 `connector_unavailable`: «sin efecto»). Es seguro anular la retención. */
export class RailUnavailableError extends Error {
  constructor(message = 'riel no disponible') {
    super(message);
    this.name = 'RailUnavailableError';
  }
}

/** No se sabe si el riel ejecutó la orden (tiempo agotado, respuesta ilegible). NO se anula la retención: se reintenta la misma orden. */
export class RailAmbiguousError extends Error {
  constructor(message = 'resultado del riel desconocido') {
    super(message);
    this.name = 'RailAmbiguousError';
  }
}

/** El extracto no se pudo leer; no se asienta nada (`statement_malformed`). */
export class StatementMalformedError extends Error {
  constructor(
    readonly reason: string,
    readonly line?: number,
  ) {
    super(`extracto ilegible: ${reason}`);
    this.name = 'StatementMalformedError';
  }
}

/** No se pudo obtener el extracto del conector. */
export class StatementUnavailableError extends Error {
  constructor(message = 'extracto no disponible') {
    super(message);
    this.name = 'StatementUnavailableError';
  }
}
