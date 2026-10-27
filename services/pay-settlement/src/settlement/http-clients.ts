import { serviceHeaders } from '@pay/service-auth';
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
    return { status: response.status, json, text };
  } catch {
    return null;
  }
}

function problemCode(reply: Reply): string | undefined {
  const body = reply.json as { code?: unknown } | null;
  return body && typeof body.code === 'string' ? body.code : undefined;
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

  private async call(method: 'GET' | 'POST', path: string, options: { body?: unknown; key?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...serviceHeaders(SELF, { 'idempotency-key': options.key }), accept: 'application/json' };
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
    const code = problemCode(reply);
    if (reply.status === 422 && code === 'insufficient_funds') throw new LedgerRejectedError('insufficient_funds');
    if (reply.status === 422) throw new LedgerRejectedError('validation_failed', problemDetail(reply));
    if (reply.status === 409) throw new LedgerRejectedError('invalid_state_transition', problemDetail(reply));
    throw new LedgerUnavailableError(`respuesta inesperada del ledger (${reply.status})`);
  }

  async createTransaction(input: { businessRef: string; attempt: number; legs: readonly LedgerLeg[] }, idempotencyKey: string): Promise<void> {
    const reply = await this.call('POST', '/transactions', {
      key: idempotencyKey,
      body: { business_ref: input.businessRef, attempt: input.attempt, currency: 'BOB', legs: input.legs },
    });
    if (reply.status !== 200 && reply.status !== 201) this.reject(reply);
  }

  async createHold(
    input: { businessRef: string; attempt: number; debitAccount: string; creditAccount: string; amountMinor: number; expiresInSeconds: number },
    idempotencyKey: string,
  ): Promise<LedgerHold> {
    const reply = await this.call('POST', '/holds', {
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

  async getHold(holdId: string): Promise<LedgerHold | undefined> {
    const reply = await this.call('GET', `/holds/${encodeURIComponent(holdId)}`);
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) this.reject(reply);
    return holdOf(reply);
  }

  async postHold(holdId: string, idempotencyKey: string): Promise<LedgerHold> {
    const reply = await this.call('POST', `/holds/${encodeURIComponent(holdId)}/post`, { key: idempotencyKey, body: {} });
    if (reply.status !== 200) this.reject(reply);
    return holdOf(reply);
  }

  async voidHold(holdId: string, idempotencyKey: string): Promise<LedgerHold> {
    const reply = await this.call('POST', `/holds/${encodeURIComponent(holdId)}/void`, { key: idempotencyKey, body: {} });
    if (reply.status !== 200) this.reject(reply);
    return holdOf(reply);
  }

  async getBalance(account: string): Promise<LedgerBalance | undefined> {
    const reply = await this.call('GET', `/balances?account=${encodeURIComponent(account)}`);
    if (reply.status === 404) return undefined;
    if (reply.status !== 200) this.reject(reply);
    const body = reply.json as Partial<LedgerBalance> | null;
    if (!body || typeof body.balance_minor !== 'number' || (body.nature !== 'credit' && body.nature !== 'debit')) throw new LedgerUnavailableError('saldo ilegible');
    return { balance_minor: body.balance_minor, nature: body.nature, pending_debits_minor: body.pending_debits_minor ?? 0 };
  }

  async listStatement(account: string, window: { from?: string; to?: string }): Promise<LedgerStatementEntry[]> {
    const entries: LedgerStatementEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ account, limit: '100' });
      if (window.from) query.set('from', window.from);
      if (window.to) query.set('to', window.to);
      if (cursor) query.set('starting_after', cursor);
      const reply = await this.call('GET', `/statements?${query.toString()}`);
      if (reply.status === 404) return entries;
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

/** Cliente HTTP de `internal-connectors-v1.yaml` (extractos) y de la orden de transferencia (PROPUESTA: `POST /transfers`). */
export class HttpConnectorsClient implements ConnectorsPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
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
        headers: { ...serviceHeaders(SELF, { 'idempotency-key': idempotencyKey }), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ payout_id: order.payoutId, merchant_id: order.merchantId, amount_minor: order.amountMinor, currency: order.currency }),
      },
      this.timeoutMs,
    );
    return transferOutcome(reply);
  }

  async queryTransfer(reference: string): Promise<RailOutcome> {
    const reply = await send(
      `${this.baseUrl}/transfers/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { ...serviceHeaders(SELF), accept: 'application/json' } },
      this.timeoutMs,
    );
    return transferOutcome(reply);
  }
}

function transferOutcome(reply: Reply | null): RailOutcome {
  // Sin respuesta o 5xx distinto de 502: no sabemos si el banco ejecutó la orden.
  if (!reply || (reply.status >= 500 && reply.status !== 502) || reply.status === 429) throw new RailAmbiguousError();
  // 502 `connector_unavailable` es «sin efecto» por contrato: es seguro anular la retención.
  if (reply.status === 502) throw new RailUnavailableError();
  if (reply.status === 422) return { state: 'failed', code: 'rail_rejected' };
  const body = reply.json as { status?: string; reference?: string; failure_code?: string } | null;
  if (reply.status !== 200 && reply.status !== 201) throw new RailAmbiguousError(`respuesta inesperada del conector (${reply.status})`);
  if (body?.status === 'paid' && body.reference) return { state: 'paid', reference: body.reference };
  if (body?.status === 'in_transit' && body.reference) return { state: 'in_transit', reference: body.reference };
  if (body?.status === 'failed') return { state: 'failed', code: body.failure_code ?? 'rail_rejected' };
  throw new RailAmbiguousError('respuesta ilegible del conector');
}
