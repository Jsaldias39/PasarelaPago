import { HttpClient, UpstreamRejection, problemCode } from './upstream';

export interface Leg {
  readonly debit_account: string;
  readonly credit_account: string;
  readonly amount_minor: number;
  readonly code?: 'charge' | 'fee' | 'refund' | 'payout' | 'release' | 'wallet_transfer' | 'mandate' | 'adjustment';
}

export interface Transaction {
  readonly id: string;
  readonly result: 'created' | 'exists';
  readonly business_ref: string;
  readonly attempt: number;
  readonly status: 'posted' | 'rejected';
  readonly reject_code?: 'insufficient_funds' | 'validation_failed' | null;
}

export interface Hold {
  readonly id: string;
  readonly result: 'created' | 'exists';
  readonly business_ref: string;
  readonly attempt: number;
  readonly status: 'pending' | 'posted' | 'voided' | 'expired';
}

export type LedgerResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** Rechazo de negocio, definitivo para este `attempt` (H-TB1): reintentar exige `attempt + 1`. */
  | { readonly kind: 'rejected'; readonly code: 'insufficient_funds' | 'validation_failed' }
  /** 409 `invalid_state_transition`: el `business_ref` ya tiene un intento aceptado, o la retención ya se resolvió. */
  | { readonly kind: 'conflict' };

/** Cliente de `internal/ledger/v1`. El id de cada pata lo deriva el servidor de `business_ref` + `attempt` (H-TB1). */
export class LedgerClient {
  constructor(private readonly http: HttpClient) {}

  async createTransaction(input: { businessRef: string; attempt: number; currency: string; legs: readonly Leg[] }): Promise<LedgerResult<Transaction>> {
    const response = await this.http.request<Transaction>({
      method: 'POST',
      path: '/transactions',
      idempotencyKey: `${input.businessRef}:${input.attempt}`,
      body: { business_ref: input.businessRef, attempt: input.attempt, currency: input.currency, legs: input.legs },
    });
    if (response.status === 200 || response.status === 201) {
      if (response.body.status === 'rejected') return { kind: 'rejected', code: response.body.reject_code ?? 'validation_failed' };
      return { kind: 'ok', value: response.body };
    }
    return this.failure(response.status, response.body);
  }

  async createHold(input: { businessRef: string; attempt: number; debitAccount: string; creditAccount: string; amountMinor: number; currency: string; expiresInSeconds: number }): Promise<LedgerResult<Hold>> {
    const response = await this.http.request<Hold>({
      method: 'POST',
      path: '/holds',
      idempotencyKey: `${input.businessRef}:${input.attempt}`,
      body: {
        business_ref: input.businessRef,
        attempt: input.attempt,
        debit_account: input.debitAccount,
        credit_account: input.creditAccount,
        amount_minor: input.amountMinor,
        currency: input.currency,
        expires_in_seconds: input.expiresInSeconds,
      },
    });
    if (response.status === 200 || response.status === 201) return { kind: 'ok', value: response.body };
    return this.failure(response.status, response.body);
  }

  async postHold(holdId: string, key: string): Promise<LedgerResult<Hold>> {
    const response = await this.http.request<Hold>({ method: 'POST', path: `/holds/${holdId}/post`, idempotencyKey: key, body: {} });
    if (response.status === 200) return { kind: 'ok', value: response.body };
    return this.failure(response.status, response.body);
  }

  async voidHold(holdId: string, key: string): Promise<LedgerResult<Hold>> {
    const response = await this.http.request<Hold>({ method: 'POST', path: `/holds/${holdId}/void`, idempotencyKey: key, body: {} });
    if (response.status === 200) return { kind: 'ok', value: response.body };
    return this.failure(response.status, response.body);
  }

  async getHold(holdId: string): Promise<Hold> {
    const response = await this.http.request<Hold>({ method: 'GET', path: `/holds/${holdId}` });
    if (response.status === 200) return response.body;
    throw new UpstreamRejection('pay-ledger', response.status, problemCode(response.body));
  }

  private failure(status: number, body: unknown): LedgerResult<never> {
    const code = problemCode(body);
    if (status === 409) return { kind: 'conflict' };
    if (status === 422 && (code === 'insufficient_funds' || code === 'validation_failed')) return { kind: 'rejected', code };
    throw new UpstreamRejection('pay-ledger', status, code);
  }
}
