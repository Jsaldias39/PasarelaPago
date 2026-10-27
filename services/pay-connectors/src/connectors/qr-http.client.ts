import { serviceHeaders } from '@pay/service-auth';
import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError } from '../domain/connector';
import type { QrPort } from './mock/mock.connector';

/**
 * Cliente de `pay-qr` (contrato propuesto en docs/trabajo/ola-1/P4/propuesta/internal-qr-v1.yaml). Idempotente: la
 * `Idempotency-Key` es el id del cobro, así un reintento (por un timeout ambiguo) devuelve el MISMO QR.
 */
export class HttpQrClient implements QrPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async issue(input: { chargeId: string; paymentIntentId: string; merchantId: string; payMode: 'test' | 'live'; amountMinor: bigint; expiresAt: Date }): Promise<{ payload: string; expiresAt: Date }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/qr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `qr-${input.chargeId}`, ...serviceHeaders('pay-connectors', { 'x-pay-mode': input.payMode }) }, // D-28: el modo de la clave viaja a pay-qr
        body: JSON.stringify({
          kind: 'dynamic',
          merchant_id: input.merchantId,
          // El nombre y la ciudad del comercio los resuelve pay-merchants; hasta que exista ese contrato van valores fijos y declarados.
          merchant_name: 'ALOVIDA PAY',
          merchant_city: 'Santa Cruz',
          currency: 'BOB',
          amount_minor: Number(input.amountMinor),
          payment_intent_id: input.paymentIntentId,
          expires_at: input.expiresAt.toISOString(),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') throw new ConnectorTimeoutError();
      throw new ConnectorUnavailableError('unreachable');
    }
    if (response.status >= 500) throw new ConnectorUnavailableError('unreachable');
    if (response.status >= 400) throw new ConnectorRejectedError('internal_error', 'pay-qr rechazó el pedido');
    const body = (await response.json()) as { payload?: unknown; expires_at?: unknown };
    if (typeof body.payload !== 'string') throw new ConnectorRejectedError('internal_error', 'respuesta de pay-qr sin payload');
    return { payload: body.payload, expiresAt: typeof body.expires_at === 'string' ? new Date(body.expires_at) : input.expiresAt };
  }
}
