import { HttpClient, UpstreamError, UpstreamRejection, problemCode } from './upstream';

export type ConnectorName = 'mock' | 'mercantil_qr' | 'mercantil_card' | 'bank_transfer';
export type ChargeStatusValue = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'expired' | 'canceled';

export type NextAction =
  | { type: 'display_qr'; payload: string; expires_at?: string }
  | { type: 'bank_transfer_instructions'; reference: string }
  | { type: 'redirect_to_card_form'; url: string };

export interface Charge {
  readonly id: string;
  readonly payment_intent_id: string;
  readonly connector: ConnectorName;
  readonly mode: 'sandbox' | 'live';
  readonly method: 'qr' | 'card' | 'bank_transfer';
  readonly amount_minor: number;
  readonly status: ChargeStatusValue;
  readonly next_action?: NextAction;
  readonly failure_code?: string | null;
}

export interface ChargeStatus {
  readonly charge_id: string;
  readonly status: ChargeStatusValue;
  readonly failure_code?: string | null;
  readonly stale?: boolean;
}

export interface ConnectorRefund {
  readonly id: string;
  readonly charge_id: string;
  readonly amount_minor: number;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly failure_code?: string | null;
}

/**
 * Resultado de una orden al conector. `ok:false` es SIEMPRE una respuesta definitiva que el contrato declara (4xx con su
 * cuerpo, o `502 connector_unavailable`, que garantiza que no se envió nada al proveedor). Todo lo demás (timeout, corte, otro
 * 5xx, un 4xx sin el cuerpo exacto) es AMBIGUO y sale como `UpstreamError`: no prueba que no se ejecutó.
 */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly code: string };

export interface ChargeRequest {
  readonly paymentIntentId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: 'qr' | 'card' | 'bank_transfer';
  readonly cardToken?: string;
  readonly expiresAt: string;
  readonly description?: string;
}

/** Cliente de `internal/connectors/v1`. Los errores de negocio (4xx) vuelven como `{ok:false}`; la caída, como `UpstreamError`. */
export class ConnectorsClient {
  constructor(private readonly http: HttpClient) {}

  async createCharge(request: ChargeRequest): Promise<Outcome<Charge>> {
    const response = await this.definitive502(() => this.http.request<Charge>({
      method: 'POST',
      path: '/charges',
      idempotencyKey: `${request.paymentIntentId}:charge`,
      body: {
        payment_intent_id: request.paymentIntentId,
        merchant_id: request.merchantId,
        amount_minor: request.amountMinor,
        currency: request.currency,
        method: request.method,
        ...(request.cardToken ? { card_token: request.cardToken } : {}),
        expires_at: request.expiresAt,
        ...(request.description ? { description: request.description } : {}),
      },
    }));
    return response.kind === 'definitive' ? response.outcome : this.outcome(response.status, response.body, [200, 201], [400, 403, 409, 422]);
  }

  async getChargeStatus(chargeId: string): Promise<ChargeStatus> {
    const response = await this.http.request<ChargeStatus>({ method: 'GET', path: `/charges/${chargeId}/status` });
    if (response.status === 200) return response.body;
    throw new UpstreamRejection('pay-connectors', response.status, problemCode(response.body));
  }

  /** `{ok:false, status:409}` = el cargo ya no se puede cancelar (ya se pagó o terminó): el único rechazo que no es un error nuestro. */
  async cancelCharge(chargeId: string, key: string): Promise<Outcome<Charge>> {
    const response = await this.http.request<Charge>({ method: 'POST', path: `/charges/${chargeId}/cancel`, idempotencyKey: key });
    return this.outcome(response.status, response.body, [200], [409]);
  }

  async createRefund(chargeId: string, amountMinor: number, key: string, reason?: string): Promise<Outcome<ConnectorRefund>> {
    const response = await this.definitive502(() => this.http.request<ConnectorRefund>({
      method: 'POST',
      path: `/charges/${chargeId}/refunds`,
      idempotencyKey: key,
      body: { amount_minor: amountMinor, ...(reason ? { reason } : {}) },
    }));
    return response.kind === 'definitive' ? response.outcome : this.outcome(response.status, response.body, [200, 201], [400, 403, 404, 409, 422]);
  }

  /** `502 connector_unavailable` con su cuerpo exacto: el conector garantiza que no se envió nada. Cualquier otro 5xx se relanza. */
  private async definitive502<R extends { status: number; body: unknown }>(call: () => Promise<R>): Promise<(R & { kind: 'response' }) | { kind: 'definitive'; outcome: { ok: false; status: number; code: string } }> {
    try {
      return { ...(await call()), kind: 'response' as const };
    } catch (error) {
      if (error instanceof Error && error.name === 'UpstreamError') {
        const upstream = error as UpstreamError;
        if (upstream.status === 502 && upstream.problemCode === 'connector_unavailable') return { kind: 'definitive', outcome: { ok: false, status: 502, code: 'connector_unavailable' } };
      }
      throw error;
    }
  }

  /** Un 4xx que el contrato NO declara para esta operación es un error de integración nuestro, no un rechazo de negocio. */
  private outcome<T>(status: number, body: unknown, success: number[], declared: number[]): Outcome<T> {
    if (success.includes(status)) return { ok: true, value: body as T };
    const code = problemCode(body);
    if (declared.includes(status) && code !== undefined) return { ok: false, status, code };
    throw new UpstreamRejection('pay-connectors', status, code);
  }
}
