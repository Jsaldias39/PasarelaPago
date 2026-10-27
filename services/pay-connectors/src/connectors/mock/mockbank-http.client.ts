import { serviceHeaders } from '@pay/service-auth';
import {
  ConnectorAmbiguousError,
  ConnectorRejectedError,
  ConnectorTimeoutError,
  ConnectorUnavailableError,
  type Method,
  type ProbeResult,
  type ProviderRefundResult,
  type ProviderRefundStatusResult,
  type ProviderStatus,
  type ProviderTransferResult,
  type StatementLine,
  type TransferStatus,
} from '../../domain/connector';
import type { MockBankPort } from './bank.port';

interface BankProblem {
  readonly code?: string;
}

type Outcome = { readonly status: number; readonly json: unknown; readonly problem?: BankProblem; readonly proxyHtml: boolean };

/** Códigos de red que prueban que la conexión NUNCA se estableció: no se envió nada, es seguro reintentar o pasar a otro conector. */
const NEVER_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_VALUE']);

/**
 * [DOBLE] Cliente de `pay-mockbank` (el banco simulado de la capa sandbox, D-26) detrás de la interfaz del banco del conector `mock`.
 * El contrato es `services/pay-mockbank/openapi/mockbank-v1.proposal.yaml` (PROPUESTA, ficticio: no es la API de ningún banco real).
 *
 * REGLA 11 (un resultado ambiguo no es un fallo): solo son «no se ejecutó» los cuerpos EXACTOS del contrato — `503 bank_unavailable` y la
 * conexión que ni siquiera se estableció. Un timeout, una conexión cortada, un 502 con HTML o cualquier 5xx pudieron ejecutar la orden.
 */
export class HttpMockBankClient implements MockBankPort {
  constructor(
    private readonly options: {
      readonly baseUrl: string;
      /** Cuenta del extracto que lee este cliente: `collections` (cobros QR/tarjeta) o `transfers` (depósitos del pagador). */
      readonly account: 'collections' | 'transfers';
      readonly timeoutMs?: number;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}

  // ───────────────────────── cobros ─────────────────────────

  async charge(input: { reference: string; amountMinor: bigint; method: Method; expiresAt: Date }): Promise<{ providerReference: string; status: ProviderStatus; failureCode?: string }> {
    const out = await this.call('POST', '/sandbox/charges', { reference: input.reference, amount_minor: Number(input.amountMinor), currency: 'BOB', method: input.method, expires_at: input.expiresAt.toISOString() });
    const body = this.okBody(out, [200, 201]);
    return { providerReference: str(body, 'bank_reference'), status: status(body), ...(typeof body.failure_code === 'string' ? { failureCode: body.failure_code } : {}) };
  }

  async status(reference: string): Promise<{ status: ProviderStatus; failureCode?: string; occurredAt: Date }> {
    const out = await this.call('GET', `/sandbox/charges/${encodeURIComponent(reference)}`);
    if (out.status === 404 && out.problem?.code === 'charge_not_found') throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    const body = this.okBody(out, [200]);
    return { status: status(body), ...(typeof body.failure_code === 'string' ? { failureCode: body.failure_code } : {}), occurredAt: new Date(str(body, 'occurred_at')) };
  }

  async cancel(reference: string): Promise<ProviderStatus> {
    const out = await this.call('POST', `/sandbox/charges/${encodeURIComponent(reference)}/cancel`, {});
    if (out.status === 404 && out.problem?.code === 'charge_not_found') throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    this.okBody(out, [200]);
    return 'canceled';
  }

  async registerQr(reference: string, payload: string): Promise<void> {
    const out = await this.call('PUT', `/sandbox/charges/${encodeURIComponent(reference)}/qr`, { payload });
    this.okBody(out, [200]);
  }

  // ───────────────────────── reembolsos ─────────────────────────

  async refund(input: { reference: string; chargeReference: string; amountMinor: bigint }): Promise<ProviderRefundResult> {
    const out = await this.call('POST', '/sandbox/refunds', { reference: input.reference, charge_reference: input.chargeReference, amount_minor: Number(input.amountMinor) });
    if (out.status === 404 && out.problem?.code === 'charge_not_found') throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    const body = this.okBody(out, [200, 201]);
    const result = str(body, 'status');
    if (result !== 'captured' && result !== 'failed') throw new ConnectorAmbiguousError('proxy_bad_gateway_html'); // respuesta que no es del contrato: no se sabe qué pasó
    return { providerReference: str(body, 'bank_reference'), status: result, ...(typeof body.failure_code === 'string' ? { failureCode: body.failure_code } : {}) };
  }

  async refundStatus(reference: string): Promise<ProviderRefundStatusResult> {
    const out = await this.call('GET', `/sandbox/refunds/${encodeURIComponent(reference)}`);
    if (out.status === 404 && out.problem?.code === 'refund_not_found') return { status: 'not_found' }; // el banco respondió de forma EXPLÍCITA que no lo tiene
    const body = this.okBody(out, [200]);
    return { status: 'captured', providerReference: str(body, 'bank_reference') };
  }

  // ───────────────────────── transferencias salientes ─────────────────────────

  async transfer(input: { reference: string; amountMinor: bigint; destinationRef?: string }): Promise<ProviderTransferResult> {
    const out = await this.call('POST', '/sandbox/transfers', { reference: input.reference, amount_minor: Number(input.amountMinor), destination_ref: input.destinationRef ?? 'dest_sandbox' });
    return transferOf(this.okBody(out, [200]));
  }

  async transferStatus(reference: string): Promise<ProviderTransferResult | { status: 'not_found' }> {
    const out = await this.call('GET', `/sandbox/transfers/${encodeURIComponent(reference)}`);
    if (out.status === 404 && out.problem?.code === 'transfer_not_found') return { status: 'not_found' };
    return transferOf(this.okBody(out, [200]));
  }

  // ───────────────────────── extracto y salud ─────────────────────────

  async statement(range: { from: Date; to: Date }): Promise<readonly StatementLine[]> {
    const query = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), format: 'json', account: this.options.account });
    const out = await this.call('GET', `/sandbox/statement?${query.toString()}`);
    const body = this.okBody(out, [200]);
    if (!Array.isArray(body.data)) throw new ConnectorAmbiguousError('proxy_bad_gateway_html');
    return (body.data as Array<Record<string, unknown>>).map((line) => ({
      providerReference: str(line, 'bank_reference'),
      ourReference: typeof line.our_reference === 'string' ? line.our_reference : null,
      direction: line.direction === 'debit' ? 'debit' : 'credit',
      amountMinor: BigInt(line.amount_minor as number),
      currency: 'BOB',
      valueDate: str(line, 'value_date'),
      bookedAt: new Date(str(line, 'booked_at')),
      description: null, // la glosa no sale de este servicio (puede traer datos personales)
    }));
  }

  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const out = await this.call('GET', '/sandbox/probe');
      const latencyMs = Math.max(1, Date.now() - started);
      if (out.status === 200) return { ok: true, latencyMs };
      return { ok: false, latencyMs, reason: out.status === 403 ? 'auth_failed' : out.status >= 500 ? 'error_rate' : 'unreachable' };
    } catch (error) {
      const latencyMs = Math.max(1, Date.now() - started);
      if (error instanceof ConnectorTimeoutError) return { ok: false, latencyMs, reason: 'timeout' };
      return { ok: false, latencyMs, reason: 'unreachable' };
    }
  }

  // ───────────────────────── transporte ─────────────────────────

  private async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<Outcome> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        // D-28: el banco simulado solo atiende claves `test`. El conector `mock` es de sandbox, su modo es siempre `test`.
        headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...serviceHeaders('pay-connectors', { 'x-pay-mode': 'test' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (error) {
      throw classify(error);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw classify(error); // la respuesta se cortó a la mitad: ambiguo
    }
    const type = response.headers.get('content-type') ?? '';
    let json: unknown;
    if (/json/.test(type)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const problem = typeof json === 'object' && json !== null && typeof (json as BankProblem).code === 'string' ? (json as BankProblem) : undefined;
    return { status: response.status, json, ...(problem && { problem }), proxyHtml: /html/.test(type) };
  }

  /** Interpreta una respuesta de error; devuelve el cuerpo si el estado es uno de los esperados. */
  private okBody(out: Outcome, expected: readonly number[]): Record<string, unknown> {
    if (expected.includes(out.status) && typeof out.json === 'object' && out.json !== null) return out.json as Record<string, unknown>;
    // Definitivos (cuerpo exacto del contrato):
    if (out.status === 503 && out.problem?.code === 'bank_unavailable') throw new ConnectorUnavailableError('unreachable');
    if (out.status === 403 && out.problem) throw new ConnectorUnavailableError('auth_failed'); // la compuerta de modo / identidad corta ANTES de cualquier efecto
    if (out.status === 409 && out.problem && (out.problem.code === 'invalid_state' || out.problem.code === 'qr_conflict')) throw new ConnectorRejectedError('invalid_state_transition');
    if (out.status === 422 && out.problem) throw new ConnectorRejectedError('validation_failed');
    if (out.status === 404 && out.problem?.code === 'charge_not_found') throw new ConnectorRejectedError('validation_failed', 'referencia desconocida');
    // Todo lo demás es AMBIGUO: un 502 con HTML de un proxy, cualquier 5xx, un 404 sin el cuerpo del contrato, un 2xx ilegible.
    if (out.proxyHtml || out.status === 502) throw new ConnectorAmbiguousError('proxy_bad_gateway_html');
    throw new ConnectorTimeoutError();
  }
}

function classify(error: unknown): Error {
  const name = (error as { name?: string }).name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ConnectorTimeoutError();
  const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
  if (code && NEVER_CONNECTED.has(code)) return new ConnectorUnavailableError('unreachable');
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return new ConnectorAmbiguousError('socket_reset');
  return new ConnectorTimeoutError(); // no se sabe: se trata como ambiguo, nunca como «no se envió»
}

function str(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new ConnectorAmbiguousError('proxy_bad_gateway_html'); // el cuerpo no cumple el contrato: no se sabe qué pasó
  return value;
}

const STATUSES = new Set<string>(['pending', 'authorized', 'captured', 'failed', 'canceled', 'expired']);
function status(body: Record<string, unknown>): ProviderStatus {
  const value = str(body, 'status');
  if (!STATUSES.has(value)) throw new ConnectorAmbiguousError('proxy_bad_gateway_html');
  return value as ProviderStatus;
}

function transferOf(body: Record<string, unknown>): ProviderTransferResult {
  const value = str(body, 'status');
  if (value !== 'paid' && value !== 'in_transit' && value !== 'failed') throw new ConnectorAmbiguousError('proxy_bad_gateway_html');
  return { providerReference: str(body, 'bank_reference'), status: value as TransferStatus, ...(typeof body.failure_code === 'string' ? { failureCode: body.failure_code } : {}) };
}
