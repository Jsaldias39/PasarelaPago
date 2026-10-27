import type { Rail } from './dto';
import type { PayMode } from './mode';

/** Pata de un asiento del ledger. */
export interface LedgerLeg {
  readonly debit_account: string;
  readonly credit_account: string;
  readonly amount_minor: number;
  readonly code: 'charge' | 'fee' | 'refund' | 'payout' | 'release' | 'wallet_transfer' | 'mandate' | 'adjustment';
}

export interface LedgerHold {
  readonly id: string;
  readonly status: 'pending' | 'posted' | 'voided' | 'expired';
  readonly amount_minor: number;
}

export interface LedgerBalance {
  /** Valor absoluto; ver `nature`. */
  readonly balance_minor: number;
  readonly nature: 'credit' | 'debit';
  readonly pending_debits_minor: number;
}

export interface LedgerStatementEntry {
  readonly business_ref: string;
  readonly direction: 'debit' | 'credit';
  readonly counterparty_account: string;
  readonly amount_minor: number;
  readonly code: string;
  readonly posted_at: string;
}

/**
 * Lo que pay-settlement necesita de pay-ledger (`contracts/openapi/internal-ledger-v1.yaml`). Es el contrato contra el que se
 * escriben los dobles de las pruebas. Toda llamada lleva el modo (`X-Pay-Mode`, D-28): el ledger separa por modo cuentas, asientos y retenciones. Todas las operaciones de escritura son idempotentes por `(business_ref, attempt)` en el ledger.
 *
 * @throws LedgerRejectedError cuando el ledger rechaza por una razón de negocio; LedgerUnavailableError cuando no se sabe qué pasó.
 */
export interface LedgerPort {
  /** `true` solo en el cliente HTTP real. Un doble no lo declara y `PAY_MODE=live` se niega a arrancar con él (`deployment.ts`). */
  readonly isReal?: boolean;
  createTransaction(mode: PayMode, input: { businessRef: string; attempt: number; legs: readonly LedgerLeg[] }, idempotencyKey: string): Promise<void>;
  createHold(
    mode: PayMode,
    input: { businessRef: string; attempt: number; debitAccount: string; creditAccount: string; amountMinor: number; expiresInSeconds: number },
    idempotencyKey: string,
  ): Promise<LedgerHold>;
  getHold(mode: PayMode, holdId: string): Promise<LedgerHold | undefined>;
  postHold(mode: PayMode, holdId: string, idempotencyKey: string): Promise<LedgerHold>;
  voidHold(mode: PayMode, holdId: string, idempotencyKey: string): Promise<LedgerHold>;
  /** `undefined` si el ledger todavía no conoce la cuenta EN ESE MODO (nunca tuvo movimientos): equivale a saldo 0. */
  getBalance(mode: PayMode, account: string): Promise<LedgerBalance | undefined>;
  /** Todas las líneas de la cuenta en `[from, to)`, de la más nueva a la más vieja; recorre las páginas. */
  listStatement(mode: PayMode, account: string, window: { from?: string; to?: string }): Promise<LedgerStatementEntry[]>;
}
export const LEDGER_PORT = Symbol('LEDGER_PORT');

export type RailOutcome =
  | { readonly state: 'paid'; readonly reference: string }
  | { readonly state: 'in_transit'; readonly reference: string }
  | { readonly state: 'failed'; readonly code: string }
  /** El riel afirma que NO tiene esa orden (solo lo dice una consulta). */
  | { readonly state: 'not_found' };

export interface PayoutOrder {
  readonly payoutId: string;
  /** Modo del pago (D-28): viaja al conector en `X-Pay-Mode`. */
  readonly mode: PayMode;
  /** `business_ref` de la transferencia (`po_x:payout`) y `attempt`: juntos son la idempotencia y la referencia de consulta del conector. */
  readonly businessRef: string;
  readonly attempt: number;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: 'BOB';
}

/**
 * Riel por el que sale un pago. `send` es idempotente por `payoutId`: repetir la orden no paga dos veces.
 *
 * @throws RailUnavailableError si la orden NO se ejecutó; RailAmbiguousError si no se sabe.
 */
export interface PayoutRail {
  readonly code: Rail;
  /** `true` si el riel es un doble y no movió dinero real. */
  readonly simulated: boolean;
  send(order: PayoutOrder): Promise<RailOutcome>;
  /**
   * Consulta AUTORITATIVA del estado de una orden ya enviada (la referencia sale de la propia orden). Es lo que resuelve un `send`
   * ambiguo. `not_found` solo si el riel prueba que no hay registro; cualquier otra duda lanza RailAmbiguousError.
   */
  query(order: PayoutOrder): Promise<RailOutcome>;
}
export const PAYOUT_RAILS = Symbol('PAYOUT_RAILS');

/** Línea de extracto normalizada (contrato `StatementLine` de pay-connectors). */
export interface StatementLine {
  readonly provider_reference: string;
  readonly our_reference: string | null;
  readonly direction: 'credit' | 'debit';
  readonly amount_minor: number;
  readonly value_date: string;
  readonly booked_at: string | null;
}

export type StatementFormat = 'json' | 'camt053' | 'csv';

export interface StatementDocument {
  readonly format: StatementFormat;
  /** `json`: las líneas ya normalizadas; `camt053` y `csv`: el texto tal como lo entregó el conector. */
  readonly lines?: readonly StatementLine[];
  readonly text?: string;
}

/** Lo que pay-settlement necesita de pay-connectors (`internal-connectors-v1.yaml`: extractos y transferencias salientes). */
export interface ConnectorsPort {
  /** `true` solo en el cliente HTTP real (ver `LedgerPort.isReal`). */
  readonly isReal?: boolean;
  getStatement(input: { connector: string; from: string; to: string; format: StatementFormat }): Promise<StatementDocument>;
  /** `POST /transfers`: ordena una transferencia saliente (idempotente por `business_ref` + `attempt`). */
  createTransfer(order: PayoutOrder, idempotencyKey: string): Promise<RailOutcome>;
  /** `GET /transfers/{business_ref:attempt}`: consulta autoritativa. */
  queryTransfer(order: PayoutOrder): Promise<RailOutcome>;
}
export const CONNECTORS_PORT = Symbol('CONNECTORS_PORT');

export interface OperatorIdentity {
  /** Identificador de la persona (`sub`); nunca su nombre. */
  readonly sub: string;
  readonly roles: readonly string[];
}

/** Verifica la credencial de la persona operadora. Devuelve `null` si no es válida (por el motivo que sea). */
export interface OperatorVerifier {
  verify(authorization: string | undefined): Promise<OperatorIdentity | null>;
}
export const OPERATOR_VERIFIER = Symbol('OPERATOR_VERIFIER');
