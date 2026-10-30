import type { Method, ProbeResult, ProviderRefundResult, ProviderRefundStatusResult, ProviderStatus, ProviderTransferResult, StatementLine } from '../../domain/connector';

type Maybe<T> = T | Promise<T>;

/**
 * El «banco» que está detrás del conector `mock`. Dos implementaciones, la misma interfaz:
 * - `SimulatedBank`: en memoria, dentro del proceso (pruebas unitarias y sandbox sin `pay-mockbank`).
 * - `HttpMockBankClient`: habla por HTTP con el servicio `pay-mockbank` (capa sandbox, D-26, P4.H4).
 * Las funciones pueden ser síncronas o asíncronas; el conector las espera con `await`.
 */
export interface MockBankPort {
  charge(input: { reference: string; amountMinor: bigint; method: Method; expiresAt: Date }, now: Date): Maybe<{ providerReference: string; status: ProviderStatus; failureCode?: string }>;
  status(reference: string, now: Date): Maybe<{ status: ProviderStatus; failureCode?: string; occurredAt: Date }>;
  cancel(reference: string, now: Date): Maybe<ProviderStatus>;
  refund(input: { reference: string; chargeReference: string; amountMinor: bigint }, now: Date): Maybe<ProviderRefundResult>;
  refundStatus(reference: string): Maybe<ProviderRefundStatusResult>;
  transfer(input: { reference: string; amountMinor: bigint; destinationRef?: string }, now: Date): Maybe<ProviderTransferResult>;
  transferStatus(reference: string, now: Date): Maybe<ProviderTransferResult | { status: 'not_found' }>;
  statement(range: { from: Date; to: Date }): Maybe<readonly StatementLine[]>;
  probe(): Maybe<ProbeResult>;
  /** Le dice al banco qué QR emitió la pasarela para el cobro (el pagador simulado lo busca por ese texto). Solo lo necesita un banco con pagador. */
  registerQr?(reference: string, payload: string): Maybe<void>;
}
