/**
 * Fallos que el banco simulado provoca A PROPÓSITO. El filtro de errores sabe cómo mostrarlos en el cable:
 * ninguno es un error del servicio.
 */

/** Respuesta de error DEFINITIVA con cuerpo propio (`application/problem+json` con `code` del banco). Solo estas se pueden tomar como «no pasó nada». */
export class BankProblem extends Error {
  constructor(
    readonly status: 404 | 409 | 503,
    readonly code: 'charge_not_found' | 'refund_not_found' | 'transfer_not_found' | 'card_authorization_not_found' | 'invalid_state' | 'bank_unavailable' | 'qr_not_registered' | 'qr_conflict',
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'BankProblem';
  }
}

/**
 * La orden SE EJECUTÓ pero la respuesta no llega. `hang`: el banco no contesta (el cliente vence por su propio timeout; pasados
 * `MOCKBANK_HANG_MS` el banco corta); `reset`: la conexión se resetea al instante.
 */
export class BankSocketCut extends Error {
  constructor(readonly how: 'hang' | 'reset') {
    super('socket cortado');
    this.name = 'BankSocketCut';
  }
}

/** La orden SE EJECUTÓ pero un «proxy» intermedio contesta 502 con HTML (no es el cuerpo de error del banco). */
export class BankProxyHtml extends Error {
  constructor() {
    super('proxy 502');
    this.name = 'BankProxyHtml';
  }
}
