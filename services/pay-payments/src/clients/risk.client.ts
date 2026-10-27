import { HttpClient, UpstreamRejection, problemCode } from './upstream';

export type RiskDecision = 'allow' | 'review' | 'deny';

export interface RiskAssessment {
  readonly id: string;
  readonly decision: RiskDecision;
  readonly reason_code: string;
  readonly rule_version: number;
  readonly screened: boolean;
}

export interface RiskRequest {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: 'qr' | 'card' | 'bank_transfer' | 'wallet';
  /** Huella opaca del pagador; nunca datos personales. */
  readonly payerFingerprint?: string;
}

/** Cliente de `internal/risk/v1` (contracts/openapi/internal-risk-v1.yaml). */
export class RiskClient {
  constructor(private readonly http: HttpClient) {}

  /**
   * @throws UpstreamError si el servicio de riesgo no responde (red, timeout, 5xx, breaker abierto): la política
   *   fail-closed vive en quien llama (P3.H2.M2).
   * @throws UpstreamRejection ante un 4xx (petición inválida: es un bug nuestro, no un «deny»).
   */
  async assess(request: RiskRequest): Promise<RiskAssessment> {
    const response = await this.http.request<RiskAssessment>({
      method: 'POST',
      path: '/assessments',
      idempotencyKey: `${request.paymentIntentId}:risk`,
      body: {
        merchant_id: request.merchantId,
        payment_intent_id: request.paymentIntentId,
        amount_minor: request.amountMinor,
        currency: request.currency,
        method: request.method,
        ...(request.payerFingerprint ? { payer_fingerprint: request.payerFingerprint } : {}),
      },
    });
    if (response.status === 200 || response.status === 201) return response.body;
    throw new UpstreamRejection('pay-risk', response.status, problemCode(response.body));
  }
}
