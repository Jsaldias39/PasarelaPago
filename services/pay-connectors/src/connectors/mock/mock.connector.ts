import { signedHeaders, verify, WebhookVerificationError } from '@pay/webhook-signature';
import type {
  Connector,
  Method,
  ProbeResult,
  ProviderChargeRequest,
  ProviderChargeResult,
  ProviderEvent,
  ProviderRefundRequest,
  ProviderRefundResult,
  ProviderRefundStatusResult,
  ProviderStatus,
  ProviderStatusResult,
  ProviderTransferRequest,
  ProviderTransferResult,
  StatementLine,
  VerifyCallbackInput,
  VerifyCallbackResult,
} from '../../domain/connector';
import { ConnectorRejectedError } from '../../domain/connector';
import { namespaceOf, ScopedSecretProvider, type SecretProvider } from '../../domain/secrets';
import { SimulatedBank, type ScheduledCallback } from './simulated-bank';

/** Genera el payload del QR de un cobro. En producción es el cliente HTTP de `pay-qr`; en pruebas, un doble declarado. */
export interface QrPort {
  issue(input: { chargeId: string; paymentIntentId: string; merchantId: string; amountMinor: bigint; expiresAt: Date }): Promise<{ payload: string; expiresAt: Date }>;
}

const EMV_PAYLOAD = /^000201.*6304[0-9A-F]{4}$/;
const SECRET_NAME = `${namespaceOf('mock')}WEBHOOK_SECRET`;

export interface MockConnectorOptions {
  readonly bank: SimulatedBank;
  readonly secrets: SecretProvider;
  readonly qr: QrPort;
  /** Código bajo el que se registra. Por defecto `mock`; las pruebas de ruteo registran un segundo simulador como `mercantil_qr` (DOBLE declarado). */
  readonly code?: 'mock' | 'mercantil_qr' | 'mercantil_card';
}

/**
 * [DOBLE] Adaptador del simulador. Cumple la interfaz `Connector` igual que lo haría el de un banco real; el contrato de
 * callbacks de pruebas firma con Standard Webhooks (lo fija el contrato OpenAPI para `mock`).
 */
export class MockConnector implements Connector {
  readonly code: 'mock' | 'mercantil_qr' | 'mercantil_card';
  readonly mode = 'sandbox' as const;
  readonly methods: readonly Method[] = ['qr', 'card', 'bank_transfer'];
  private readonly secrets: SecretProvider;

  constructor(private readonly options: MockConnectorOptions) {
    this.code = options.code ?? 'mock';
    this.secrets = new ScopedSecretProvider(options.secrets, namespaceOf('mock'));
  }

  async createCharge(request: ProviderChargeRequest, now: Date): Promise<ProviderChargeResult> {
    const result = this.options.bank.charge(request, now);
    if (result.status === 'failed') return { providerReference: result.providerReference, status: 'failed', failureCode: result.failureCode };
    if (request.method === 'qr') {
      const qr = await this.options.qr.issue({ chargeId: request.reference, paymentIntentId: request.paymentIntentId, merchantId: request.merchantId, amountMinor: request.amountMinor, expiresAt: request.expiresAt });
      // Lo que devuelve pay-qr se valida: si no parece un payload EMV, es un fallo interno, no algo que mostrarle al pagador.
      if (!EMV_PAYLOAD.test(qr.payload)) throw new ConnectorRejectedError('internal_error', 'payload de QR inválido');
      return { providerReference: result.providerReference, status: result.status, nextAction: { type: 'display_qr', payload: qr.payload, expires_at: qr.expiresAt.toISOString() } };
    }
    if (request.method === 'card') return { providerReference: result.providerReference, status: result.status, nextAction: { type: 'redirect_to_card_form', url: `https://sandbox.invalid/pay/${result.providerReference}` } };
    return { providerReference: result.providerReference, status: result.status, nextAction: { type: 'bank_transfer_instructions', reference: request.reference } };
  }

  async getStatus(reference: string, now: Date): Promise<ProviderStatusResult> {
    return this.options.bank.status(reference, now);
  }

  async cancel(reference: string, now: Date): Promise<{ status: ProviderStatus }> {
    return { status: this.options.bank.cancel(reference, now) };
  }

  async refund(request: ProviderRefundRequest, now: Date): Promise<ProviderRefundResult> {
    return this.options.bank.refund(request, now);
  }

  async getRefund(reference: string): Promise<ProviderRefundStatusResult> {
    return this.options.bank.refundStatus(reference);
  }

  async createTransfer(request: ProviderTransferRequest, now: Date): Promise<ProviderTransferResult> {
    return this.options.bank.transfer(request, now);
  }

  async getTransfer(reference: string, now: Date): Promise<ProviderTransferResult | { readonly status: 'not_found' }> {
    return this.options.bank.transferStatus(reference, now);
  }

  async verifyCallback(input: VerifyCallbackInput): Promise<VerifyCallbackResult> {
    const secrets = await this.secrets.getSecrets(SECRET_NAME);
    if (secrets.length === 0) return { ok: false }; // fail-closed: sin secreto no se acepta nada
    try {
      verify({ headers: input.headers, payload: input.rawBody, secrets, now: Math.floor(input.now.getTime() / 1000) });
    } catch (error) {
      if (error instanceof WebhookVerificationError) return { ok: false };
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody.toString('utf8'));
    } catch {
      return { ok: false, malformed: true }; // firma válida, cuerpo ilegible
    }
    const event = parseEvent(body);
    return event ? { ok: true, events: [event] } : { ok: false, malformed: true };
  }

  async fetchStatement(range: { from: Date; to: Date }): Promise<readonly StatementLine[]> {
    return this.options.bank.statement(range);
  }

  async probe(): Promise<ProbeResult> {
    return this.options.bank.isDown() ? { ok: false, latencyMs: 1, reason: 'unreachable' } : { ok: true, latencyMs: 1 };
  }

  /**
   * Del lado del «banco»: arma el pedido firmado que el banco enviaría a `POST /callbacks/mock` para un evento programado.
   * Lo usan las pruebas y la capa sandbox para entregar callbacks reales por el endpoint real.
   */
  async signCallback(callback: ScheduledCallback, now: Date): Promise<{ headers: Record<string, string>; rawBody: Buffer }> {
    const secrets = await this.secrets.getSecrets(SECRET_NAME);
    const body = JSON.stringify({
      id: callback.eventId,
      type: 'charge.status',
      reference: callback.reference,
      status: callback.status,
      occurred_at: callback.occurredAt.toISOString(),
      amount_minor: Number(callback.amountMinor),
      ...(callback.failureCode ? { failure_code: callback.failureCode } : {}),
    });
    return { headers: signedHeaders({ id: callback.eventId, timestamp: Math.floor(now.getTime() / 1000), payload: body, secrets: [...secrets] }), rawBody: Buffer.from(body, 'utf8') };
  }
}

const STATUSES = new Set(['pending', 'authorized', 'captured', 'failed', 'canceled', 'expired']);

function parseEvent(body: unknown): ProviderEvent | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const occurred = typeof b.occurred_at === 'string' ? new Date(b.occurred_at) : null;
  if (typeof b.id !== 'string' || b.id.length === 0 || b.id.length > 200) return null;
  if (typeof b.reference !== 'string' || !/^ch_[a-z0-9]{10,40}$/.test(b.reference)) return null;
  if (typeof b.status !== 'string' || !STATUSES.has(b.status)) return null;
  if (!occurred || Number.isNaN(occurred.getTime())) return null;
  if (b.amount_minor !== undefined && !Number.isSafeInteger(b.amount_minor)) return null;
  return {
    providerEventId: b.id,
    chargeReference: b.reference,
    status: b.status as ProviderStatus,
    occurredAt: occurred,
    ...(typeof b.failure_code === 'string' ? { failureCode: b.failure_code } : {}),
    ...(typeof b.amount_minor === 'number' ? { amountMinor: BigInt(b.amount_minor) } : {}),
  };
}
