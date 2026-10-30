import { isUsableSecret, signedHeaders, verify, WebhookVerificationError } from '@pay/webhook-signature';
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
import type { MockBankPort } from './bank.port';
import type { ScheduledCallback } from './simulated-bank';

/** Genera el payload del QR de un cobro. En producción es el cliente HTTP de `pay-qr`; en pruebas, un doble declarado. */
export interface QrPort {
  issue(input: { chargeId: string; paymentIntentId: string; merchantId: string; payMode: 'test' | 'live'; amountMinor: bigint; expiresAt: Date }): Promise<{ payload: string; expiresAt: Date }>;
}

const EMV_PAYLOAD = /^000201.*6304[0-9A-F]{4}$/;
const SECRET_NAME = `${namespaceOf('mock')}WEBHOOK_SECRET`;

export interface MockConnectorOptions {
  readonly bank: MockBankPort;
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
    const result = await this.options.bank.charge(request, now);
    if (result.status === 'failed') return { providerReference: result.providerReference, status: 'failed', failureCode: result.failureCode };
    if (request.method === 'qr') {
      const qr = await this.options.qr.issue({ chargeId: request.reference, paymentIntentId: request.paymentIntentId, merchantId: request.merchantId, payMode: request.payMode, amountMinor: request.amountMinor, expiresAt: request.expiresAt });
      // Lo que devuelve pay-qr se valida: si no parece un payload EMV, es un fallo interno, no algo que mostrarle al pagador.
      if (!EMV_PAYLOAD.test(qr.payload)) throw new ConnectorRejectedError('internal_error', 'payload de QR inválido');
      // Con un banco que tiene pagador (pay-mockbank), el QR emitido se le registra para que lo pueda pagar. Idempotente por cobro.
      await this.options.bank.registerQr?.(request.reference, qr.payload);
      return { providerReference: result.providerReference, status: result.status, nextAction: { type: 'display_qr', payload: qr.payload, expires_at: qr.expiresAt.toISOString() } };
    }
    if (request.method === 'card') return { providerReference: result.providerReference, status: result.status, nextAction: { type: 'redirect_to_card_form', url: `https://sandbox.invalid/pay/${result.providerReference}` } };
    return { providerReference: result.providerReference, status: result.status, nextAction: { type: 'bank_transfer_instructions', reference: request.reference } };
  }

  async getStatus(reference: string, now: Date): Promise<ProviderStatusResult> {
    return await this.options.bank.status(reference, now);
  }

  async cancel(reference: string, now: Date): Promise<{ status: ProviderStatus }> {
    return { status: await this.options.bank.cancel(reference, now) };
  }

  async refund(request: ProviderRefundRequest, now: Date): Promise<ProviderRefundResult> {
    return await this.options.bank.refund(request, now);
  }

  async getRefund(reference: string): Promise<ProviderRefundStatusResult> {
    return await this.options.bank.refundStatus(reference);
  }

  async createTransfer(request: ProviderTransferRequest, now: Date): Promise<ProviderTransferResult> {
    return await this.options.bank.transfer(request, now);
  }

  async getTransfer(reference: string, now: Date): Promise<ProviderTransferResult | { readonly status: 'not_found' }> {
    return await this.options.bank.transferStatus(reference, now);
  }

  async verifyCallback(input: VerifyCallbackInput): Promise<VerifyCallbackResult> {
    // S-18: un valor mal formado en el almacén (OpenBao) NO puede dar un 500 ni anular al secreto bueno de un par de rotación: se descarta el malo y se verifica con los demás.
    const secrets = (await this.secrets.getSecrets(SECRET_NAME)).filter(isUsableSecret);
    if (secrets.length === 0) return { ok: false }; // fail-closed: sin secreto utilizable no se acepta nada
    try {
      verify({ headers: input.headers, payload: input.rawBody, secrets, now: Math.floor(input.now.getTime() / 1000) });
    } catch (error) {
      if (error instanceof WebhookVerificationError || error instanceof RangeError) return { ok: false }; // fail-closed: nunca un 500 por la verificación
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
    return await this.options.bank.statement(range);
  }

  async probe(): Promise<ProbeResult> {
    return await this.options.bank.probe();
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
