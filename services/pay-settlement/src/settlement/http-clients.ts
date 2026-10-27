import { serviceHeaders } from '@pay/service-auth';
import type { PayMode } from './mode';
import { LedgerRejectedError, LedgerUnavailableError, RailAmbiguousError, RailUnavailableError, StatementUnavailableError } from './errors';
import type {
  ConnectorsPort,
  LedgerBalance,
  LedgerHold,
  LedgerLeg,
  LedgerPort,
  LedgerStatementEntry,
  PayoutOrder,
  RailOutcome,
  StatementDocument,
  StatementFormat,
  StatementLine,
} from './ports';

const SELF = 'pay-settlement';

interface Reply {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  /** `true` solo si el cuerpo es `application/problem+json`: un 4xx/5xx de un proxy intermedio NO es una respuesta del servicio. */
  readonly isProblem: boolean;
}

/** `fetch` con tiempo máximo. Un fallo de red o un tiempo agotado se informa como `null`: el resultado de la llamada es desconocido. */
async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Reply | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* no era JSON (extracto CSV/XML, o un cuerpo de error ajeno) */
    }
    const isProblem = (response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/problem+json');
    return { status: response.status, json, text, isProblem };
  } catch {
    return null;
  }
}

function problemCode(reply: Reply): string | undefined {
  const body = reply.json as { code?: unknown } | null;
  return body && typeof body.code === 'string' ? body.code : undefined;
}

/** «No existe» solo lo prueba el servicio: `404` `application/problem+json` con `code: resource_not_found`. Un 404 de un proxy no prueba nada. */
function isNotFound(reply: Reply): boolean {
  return reply.status === 404 && reply.isProblem && problemCode(reply) === 'resource_not_found';
}

function problemDetail(reply: Reply): string | undefined {
  const body = reply.json as { detail?: unknown } | null;
  return body && typeof body.detail === 'string' ? body.detail : undefined;
}

/** Cliente HTTP de `internal-ledger-v1.yaml`. */
export class HttpLedgerClient implements LedgerPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private async call(mode: PayMode, method: 'GET' | 'POST', path: string, options: { body?: unknown; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...serviceHeaders(SELF, { 'idempotency-key': options.key, 'x-pay-mode': mode }), accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const reply = await send(
      `${this.baseUrl}${path}`,
      { method, headers, ...(options.body !== undefined && { body: JSON.stringify(options.body) }) },
      this.timeoutMs,
    );
    if (!reply || reply.status >= 500 || reply.status === 429) throw new LedgerUnavailableError();
    return reply;
  }

  /** Traduce un 4xx de negocio a `LedgerRejectedError`; cualquier otro 4xx inesperado es un fallo nuestro (se trata como no disponible). */
  private reject(reply: Reply): never {
    // Un 409/422 sin cuerpo `application/problem+json` no vino del ledger (un proxy puede fabricarlo): no se decide nada con él.
    if (!reply.isProblem) throw new LedgerUnavailableError(`respuesta ajena al ledger (${reply.status})`);
    const code = problemCode(reply);
    if (reply.status === 422 && code === 'insufficient_funds') throw new LedgerRejectedError('insufficient_funds');
    if (reply.status === 422) throw new LedgerRejectedError('validation_failed', problemDetail(reply));
    if (reply.status === 409) throw new LedgerRejectedError('invalid_state_transition', problemDetail(reply));
    throw new LedgerUnavailableError(`respuesta inesperada del ledger (${reply.status})`);
  }

  async createTransaction(mode: PayMode, input: { businessRef: string; attempt: number; legs: readonly LedgerLeg[] }, idempotencyKey: string): Promise<void> {
    const reply = await this.call(mode, 'POST', '/transactions', {
      key: idempotencyKey,
      body: { business_ref: input.businessRef, attempt: input.attempt, currency: 'BOB', legs: input.legs },
    });
    if (reply.status !== 200 && reply.status !== 201) this.reject(reply);
  }

  async createHold(
    mode: PayMode,
    input: { businessRef: string; attempt: number; debitAccount: string; creditAccount: string; amountMinor: number; expiresInSeconds: number },
    idempotencyKey: string,
  ): Promise<LedgerHold> {
    const reply = await this.call(mode, 'POST', '/holds', {
      key: idempotencyKey,
      body: {
        business_ref: input.businessRef,
        attempt: input.attempt,
        debit_account: input.debitAccount,
        credit_account: input.creditAccount,
        amount_minor: input.amountMinor,
        currency: 'BOB',
        expires_in_seconds: input.expiresInSeconds,
      },
    });
    if (reply.status !== 200 && reply.status !== 201) this.reject(reply);
    return holdOf(reply);
  }

  async getHold(mode: PayMode, holdId: string): Promise<LedgerHold | undefined> {
    const reply = await this.call(mode, 'GET', `/holds/${encodeURIComponent(holdId)}`);
    if (isNotFound(reply)) return undefined;
    if (reply.status !== 200) this.reject(reply);
    return holdOf(reply);
  }

  async postHold(mode: PayMode, holdId: string, idempotencyKey: string): Promise<LedgerHold> {
    const reply = await this.call(mode, 'POST', `/holds/${encodeURIComponent(holdId)}/post`, { key: idempotencyKey, body: {} });
    if (reply.status !== 200) this.reject(reply);
    return holdOf(reply);
  }

  async voidHold(mode: PayMode, holdId: string, idempotencyKey: string): Promise<LedgerHold> {
    const reply = await this.call(mode, 'POST', `/holds/${encodeURIComponent(holdId)}/void`, { key: idempotencyKey, body: {} });
    if (reply.status !== 200) this.reject(reply);
    return holdOf(reply);
  }

  async getBalance(mode: PayMode, account: string): Promise<LedgerBalance | undefined> {
    const reply = await this.call(mode, 'GET', `/balances?account=${encodeURIComponent(account)}`);
    if (isNotFound(reply)) return undefined;
    if (reply.status !== 200) this.reject(reply);
    const body = reply.json as Partial<LedgerBalance> | null;
    if (!body || typeof body.balance_minor !== 'number' || (body.nature !== 'credit' && body.nature !== 'debit')) throw new LedgerUnavailableError('saldo ilegible');
    return { balance_minor: body.balance_minor, nature: body.nature, pending_debits_minor: body.pending_debits_minor ?? 0 };
  }

  async listStatement(mode: PayMode, account: string, window: { from?: string; to?: string }): Promise<LedgerStatementEntry[]> {
    const entries: LedgerStatementEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ account, limit: '100' });
      if (window.from) query.set('from', window.from);
      if (window.to) query.set('to', window.to);
      if (cursor) query.set('starting_after', cursor);
      const reply = await this.call(mode, 'GET', `/statements?${query.toString()}`);
      if (isNotFound(reply)) return entries;
      if (reply.status !== 200) this.reject(reply);
      const page = reply.json as { data?: LedgerStatementEntry[]; has_more?: boolean; next_cursor?: string | null } | null;
      if (!page || !Array.isArray(page.data)) throw new LedgerUnavailableError('extracto ilegible');
      for (const row of page.data) {
        entries.push({
          business_ref: row.business_ref,
          direction: row.direction,
          counterparty_account: row.counterparty_account,
          amount_minor: row.amount_minor,
          code: row.code,
          posted_at: row.posted_at,
        });
      }
      if (!page.has_more || !page.next_cursor) return entries;
      cursor = page.next_cursor;
    }
  }
}

function holdOf(reply: Reply): LedgerHold {
  const body = reply.json as Partial<LedgerHold> | null;
  if (!body || typeof body.id !== 'string' || typeof body.status !== 'string' || typeof body.amount_minor !== 'number') throw new LedgerUnavailableError('retención ilegible');
  return { id: body.id, status: body.status, amount_minor: body.amount_minor };
}

const ACCEPT: Record<StatementFormat, string> = { json: 'application/json', camt053: 'application/xml', csv: 'text/csv' };


/** Cliente HTTP de `internal-connectors-v1.yaml`: extractos y transferencias salientes (`POST /transfers`, `GET /transfers/{reference}`). */
export class HttpConnectorsClient implements ConnectorsPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly connector: 'mock' | 'mercantil_qr' | 'mercantil_card' | 'bank_transfer',
  ) {}

  async getStatement(input: { connector: string; from: string; to: string; format: StatementFormat }): Promise<StatementDocument> {
    const lines: StatementLine[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ connector: input.connector, from: input.from, to: input.to, limit: '100' });
      if (cursor) query.set('starting_after', cursor);
      const reply = await send(
        `${this.baseUrl}/statements?${query.toString()}`,
        { method: 'GET', headers: { ...serviceHeaders(SELF), accept: ACCEPT[input.format] } },
        this.timeoutMs,
      );
      if (!reply || reply.status >= 500 || reply.status === 429) throw new StatementUnavailableError();
      if (reply.status !== 200) throw new StatementUnavailableError(`el conector respondió ${reply.status}`);
      if (input.format !== 'json') return { format: input.format, text: reply.text };
      const page = reply.json as { data?: StatementLine[]; has_more?: boolean; next_cursor?: string | null } | null;
      if (!page || !Array.isArray(page.data)) return { format: 'json', text: reply.text }; // lo decide el parser: extracto ilegible
      lines.push(...page.data);
      if (!page.has_more || !page.next_cursor) return { format: 'json', lines };
      cursor = page.next_cursor;
    }
  }

  async createTransfer(order: PayoutOrder, idempotencyKey: string): Promise<RailOutcome> {
    const reply = await send(
      `${this.baseUrl}/transfers`,
      {
        method: 'POST',
        headers: { ...serviceHeaders(SELF, { 'idempotency-key': idempotencyKey, 'x-pay-mode': order.mode }), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          business_ref: order.businessRef,
          attempt: order.attempt,
          connector: this.connector,
          amount_minor: order.amountMinor,
          currency: order.currency,
          // Referencia opaca de la cuenta de liquidación (Q-22): el conector la resuelve; la pasarela no guarda números de cuenta.
          destination_ref: order.merchantId,
        }),
      },
      this.timeoutMs,
    );
    return transferOutcome(reply, 'create');
  }

  async queryTransfer(order: PayoutOrder): Promise<RailOutcome> {
    const reply = await send(`${this.baseUrl}/transfers/${order.businessRef}:${order.attempt}`, { method: 'GET', headers: { ...serviceHeaders(SELF, { 'x-pay-mode': order.mode }), accept: 'application/json' } }, this.timeoutMs);
    return transferOutcome(reply, 'query');
  }
}

const TRANSFER_ID = /^tr_[a-z0-9]{10,40}$/;

/**
 * Traduce la respuesta del conector a un resultado del riel. Regla de dinero (doble pago, CLAUDE.md #11): SOLO es definitivo lo que el
 * contrato declara definitivo:
 *  - `POST`: un `502` `application/problem+json` con `code: connector_unavailable` (no se envió nada al proveedor);
 *  - `GET`: un `404` `application/problem+json` con `code: transfer_not_found` (el conector consultó al proveedor y no hay registro);
 *  - una `Transfer` bien formada con `status: failed` y `failure_code` (prueba que NO se pagó).
 * Todo lo demás —502/503/504 de un proxy, 404 genérico, 4xx sin cuerpo problem+json, cuerpo ilegible, corte de conexión, tiempo
 * agotado— es AMBIGUO: puede que el banco ya haya pagado. Nunca se anula una retención por ambigüedad.
 */
function transferOutcome(reply: Reply | null, call: 'create' | 'query'): RailOutcome {
  if (!reply) throw new RailAmbiguousError('sin respuesta del conector');
  const code = problemCode(reply);
  if (call === 'create' && reply.isProblem && reply.status === 502 && code === 'connector_unavailable') throw new RailUnavailableError();
  if (call === 'query' && reply.isProblem && reply.status === 404 && code === 'transfer_not_found') return { state: 'not_found' };
  if (reply.status !== 200 && reply.status !== 201) throw new RailAmbiguousError(`respuesta no concluyente del conector (${reply.status})`);
  const body = reply.json as { id?: unknown; object?: unknown; reference?: unknown; status?: unknown; failure_code?: unknown } | null;
  if (!body || body.object !== 'transfer' || typeof body.id !== 'string' || !TRANSFER_ID.test(body.id) || typeof body.reference !== 'string') throw new RailAmbiguousError('respuesta ilegible del conector');
  if (body.status === 'paid') return { state: 'paid', reference: body.reference };
  if (body.status === 'pending' || body.status === 'in_transit') return { state: 'in_transit', reference: body.reference };
  // `failed` sin `failure_code` no prueba nada: se trata como ambiguo.
  if (body.status === 'failed' && typeof body.failure_code === 'string' && body.failure_code.length > 0) return { state: 'failed', code: body.failure_code };
  throw new RailAmbiguousError('estado de transferencia desconocido');
}
