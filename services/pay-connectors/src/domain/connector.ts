/**
 * Interfaz única de los adaptadores de proveedor (patrón de Hyperswitch y Kill Bill: el núcleo no conoce a ningún proveedor).
 * Agregar un adaptador es registrar una clase; el núcleo (cobros, callbacks, ruteo, poller, salud) no cambia.
 */
export type ConnectorCode = 'mock' | 'mercantil_qr' | 'mercantil_card' | 'bank_transfer';
export type Method = 'qr' | 'card' | 'bank_transfer';
export type Mode = 'sandbox' | 'live';
/** Vocabulario del proveedor (el de los eventos). El estado público del cobro se deriva en `status-map.ts`. */
export type ProviderStatus = 'pending' | 'authorized' | 'captured' | 'failed' | 'canceled' | 'expired';

export type NextAction =
  | { type: 'display_qr'; payload: string; expires_at?: string }
  | { type: 'bank_transfer_instructions'; reference: string }
  | { type: 'redirect_to_card_form'; url: string };

export interface ProviderChargeRequest {
  /** Id del cobro (`ch_…`). Es la clave de idempotencia del lado del proveedor: repetirla NO crea otro cobro. */
  readonly reference: string;
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: 'BOB';
  readonly method: Method;
  readonly expiresAt: Date;
  readonly cardToken?: string;
  readonly description?: string;
}

export interface ProviderChargeResult {
  readonly providerReference: string;
  readonly status: ProviderStatus;
  readonly nextAction?: NextAction;
  readonly failureCode?: string;
}

export interface ProviderStatusResult {
  readonly status: ProviderStatus;
  readonly failureCode?: string;
  readonly occurredAt: Date;
}

export interface ProviderRefundRequest {
  /** Id del reembolso (`cr_…`), clave de idempotencia del proveedor. */
  readonly reference: string;
  readonly chargeReference: string;
  readonly amountMinor: bigint;
}

export interface ProviderRefundResult {
  readonly providerReference: string;
  readonly status: 'pending' | 'captured' | 'failed';
  readonly failureCode?: string;
}

/** Un hecho que informa el proveedor (por callback) o que descubre el poller. */
export interface ProviderEvent {
  /** Id del evento en el proveedor; con el conector forma la clave de deduplicación. */
  readonly providerEventId: string;
  /** Nuestro id del cobro (`ch_…`), el que mandamos como `reference`. */
  readonly chargeReference: string;
  readonly status: ProviderStatus;
  readonly occurredAt: Date;
  readonly failureCode?: string;
  readonly amountMinor?: bigint;
}

export interface VerifyCallbackInput {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Los bytes EXACTOS recibidos: la firma se calcula sobre ellos. */
  readonly rawBody: Buffer;
  readonly now: Date;
}

/**
 * `ok:false` no dice por qué (a quien llama no se le explica qué falló de la autenticación). Con `malformed: true` la
 * autenticación SÍ pasó pero el cuerpo no se pudo interpretar: se responde 400 en vez de 401.
 */
export type VerifyCallbackResult =
  | { readonly ok: true; readonly events: readonly ProviderEvent[] }
  | { readonly ok: false; readonly malformed?: boolean };

export interface StatementLine {
  readonly providerReference: string;
  readonly ourReference: string | null;
  readonly direction: 'credit' | 'debit';
  readonly amountMinor: bigint;
  readonly currency: 'BOB';
  readonly valueDate: string;
  readonly bookedAt?: Date;
  readonly description?: string | null;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly reason?: 'timeout' | 'error_rate' | 'unreachable' | 'auth_failed';
}

/** El proveedor no recibió el pedido o está caído: es seguro probar con otro conector (no se creó nada). */
export class ConnectorUnavailableError extends Error {
  constructor(readonly reason: 'unreachable' | 'auth_failed' | 'error_rate' = 'unreachable') {
    super(`Conector no disponible: ${reason}`);
    this.name = 'ConnectorUnavailableError';
  }
}

/** No se sabe si el proveedor creó el cobro. NO se prueba con otro conector (podría duplicarse): se reintenta con la misma referencia. */
export class ConnectorTimeoutError extends Error {
  constructor() {
    super('El conector no respondió a tiempo');
    this.name = 'ConnectorTimeoutError';
  }
}

/** El proveedor rechazó el pedido de forma definitiva. `code` ya está mapeado a un código estable; nunca es el mensaje crudo del proveedor. */
export class ConnectorRejectedError extends Error {
  constructor(readonly code: 'validation_failed' | 'invalid_state_transition' | 'internal_error', readonly detail?: string) {
    super(`Rechazado por el conector: ${code}`);
    this.name = 'ConnectorRejectedError';
  }
}

export interface Connector {
  readonly code: ConnectorCode;
  readonly mode: Mode;
  readonly methods: readonly Method[];
  /** Idempotente por `request.reference`. */
  createCharge(request: ProviderChargeRequest, now: Date): Promise<ProviderChargeResult>;
  getStatus(reference: string, now: Date): Promise<ProviderStatusResult>;
  cancel(reference: string, now: Date): Promise<{ status: ProviderStatus }>;
  /** Idempotente por `request.reference`. */
  refund(request: ProviderRefundRequest, now: Date): Promise<ProviderRefundResult>;
  verifyCallback(input: VerifyCallbackInput): Promise<VerifyCallbackResult>;
  fetchStatement(range: { from: Date; to: Date }): Promise<readonly StatementLine[]>;
  probe(now: Date): Promise<ProbeResult>;
}
