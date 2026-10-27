import { Inject, Injectable, Logger } from '@nestjs/common';
import { SCHEDULE_SETTINGS, type ScheduleSettings } from '../settings';

/**
 * Cliente de pay-ledger (`contracts/openapi/internal-ledger-v1.yaml`). Clasifica cada respuesta en lo ÚNICO que importa para no
 * mover dinero dos veces (regla 11 del CLAUDE.md): qué es definitivo y qué es ambiguo.
 *
 *  - `ok`: el libro mayor aceptó (o ya había aceptado) la operación.
 *  - `rejected`: rechazo de negocio DEFINITIVO, solo si el cuerpo es el error exacto del contrato (`422 insufficient_funds`…).
 *  - `conflict`: `409 invalid_state_transition` o `422 idempotency_key_reused`; no se resuelve solo.
 *  - `ambiguous`: timeout, corte, 5xx, 404/403 o un cuerpo que no es el del contrato. NO prueba que no se ejecutó:
 *    se reintenta con las MISMAS claves, nunca se anula nada.
 */
export type LedgerResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'rejected'; code: 'insufficient_funds' | 'validation_failed' }
  | { kind: 'conflict'; code: 'invalid_state_transition' | 'idempotency_key_reused' }
  | { kind: 'ambiguous'; reason: string };

export interface LedgerHold {
  id: string;
  status: 'pending' | 'posted' | 'voided' | 'expired';
}

export interface LedgerTransaction {
  id: string;
  status: 'posted' | 'rejected';
  /** PROPUESTA (PR-09): ids `tf_…` de las transferencias del asiento, que `scheduled_payment.executed` exige. */
  transferIds: string[];
}

export interface HoldRequest {
  businessRef: string;
  attempt: number;
  debitAccount: string;
  creditAccount: string;
  amountMinor: number;
  expiresInSeconds: number;
}

export interface TransactionRequest {
  businessRef: string;
  attempt: number;
  legs: { debit_account: string; credit_account: string; amount_minor: number; code: string }[];
}

export interface LedgerClient {
  createHold(mode: string, key: string, request: HoldRequest): Promise<LedgerResult<LedgerHold>>;
  postHold(mode: string, key: string, holdId: string): Promise<LedgerResult<LedgerHold>>;
  getHold(mode: string, holdId: string): Promise<LedgerResult<LedgerHold>>;
  createTransaction(mode: string, key: string, request: TransactionRequest): Promise<LedgerResult<LedgerTransaction>>;
  balance(mode: string, account: string): Promise<LedgerResult<{ balanceMinor: number }>>;
}

export const LEDGER_CLIENT = Symbol('LEDGER_CLIENT');

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const HOLD_STATUSES = ['pending', 'posted', 'voided', 'expired'];

@Injectable()
export class HttpLedgerClient implements LedgerClient {
  private readonly logger = new Logger(HttpLedgerClient.name);

  constructor(@Inject(SCHEDULE_SETTINGS) private readonly settings: ScheduleSettings) {}

  private async call(method: string, path: string, mode: string, key: string | undefined, body?: unknown): Promise<{ status: number; json: unknown } | { error: string }> {
    try {
      const response = await fetch(`${this.settings.ledgerUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.settings.ledgerTimeoutMs),
        headers: {
          'x-service-id': 'pay-schedules',
          'x-pay-mode': mode,
          accept: 'application/json',
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(key !== undefined && { 'idempotency-key': key }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch (error) {
      // Solo la clase del error: ni la URL ni el cuerpo (ids de cuentas) van al log.
      this.logger.warn({ err: (error as { name?: string } | null)?.name ?? 'desconocido', path: path.split('?')[0].replace(/hd_[a-z0-9]+/, 'hd_*') }, 'El libro mayor no respondió');
      return { error: (error as { name?: string } | null)?.name ?? 'error' };
    }
  }

  private classify<T>(res: { status: number; json: unknown } | { error: string }, parse: (json: Record<string, unknown>) => T | null, okStatuses: number[]): LedgerResult<T> {
    if ('error' in res) return { kind: 'ambiguous', reason: `sin respuesta (${res.error})` };
    if (okStatuses.includes(res.status)) {
      const parsed = isRecord(res.json) ? parse(res.json) : null;
      return parsed === null ? { kind: 'ambiguous', reason: 'respuesta con forma inesperada' } : { kind: 'ok', value: parsed };
    }
    const code = isRecord(res.json) && typeof res.json.code === 'string' ? res.json.code : undefined;
    if (res.status === 422 && (code === 'insufficient_funds' || code === 'validation_failed')) return { kind: 'rejected', code };
    if (res.status === 422 && code === 'idempotency_key_reused') return { kind: 'conflict', code };
    if (res.status === 409 && code === 'invalid_state_transition') return { kind: 'conflict', code };
    return { kind: 'ambiguous', reason: `HTTP ${res.status}` };
  }

  private parseHold = (json: Record<string, unknown>): LedgerHold | null =>
    typeof json.id === 'string' && /^hd_[a-z0-9]{10,40}$/.test(json.id) && typeof json.status === 'string' && HOLD_STATUSES.includes(json.status) ? { id: json.id, status: json.status as LedgerHold['status'] } : null;

  async createHold(mode: string, key: string, r: HoldRequest): Promise<LedgerResult<LedgerHold>> {
    const res = await this.call('POST', '/holds', mode, key, {
      business_ref: r.businessRef,
      attempt: r.attempt,
      debit_account: r.debitAccount,
      credit_account: r.creditAccount,
      amount_minor: r.amountMinor,
      currency: 'BOB',
      expires_in_seconds: r.expiresInSeconds,
    });
    return this.classify(res, this.parseHold, [200, 201]);
  }

  async postHold(mode: string, key: string, holdId: string): Promise<LedgerResult<LedgerHold>> {
    return this.classify(await this.call('POST', `/holds/${holdId}/post`, mode, key), this.parseHold, [200]);
  }

  async getHold(mode: string, holdId: string): Promise<LedgerResult<LedgerHold>> {
    return this.classify(await this.call('GET', `/holds/${holdId}`, mode, undefined), this.parseHold, [200]);
  }

  async createTransaction(mode: string, key: string, r: TransactionRequest): Promise<LedgerResult<LedgerTransaction>> {
    const res = await this.call('POST', '/transactions', mode, key, { business_ref: r.businessRef, attempt: r.attempt, currency: 'BOB', legs: r.legs });
    return this.classify(
      res,
      (json) => {
        if (typeof json.id !== 'string' || (json.status !== 'posted' && json.status !== 'rejected')) return null;
        const ids = Array.isArray(json.transfer_ids) ? json.transfer_ids.filter((v): v is string => typeof v === 'string' && /^tf_[a-z0-9]{10,40}$/.test(v)) : [];
        return { id: json.id, status: json.status, transferIds: ids };
      },
      [200, 201],
    );
  }

  async balance(mode: string, account: string): Promise<LedgerResult<{ balanceMinor: number }>> {
    const res = await this.call('GET', `/balances?account=${encodeURIComponent(account)}`, mode, undefined);
    return this.classify(res, (json) => (typeof json.balance_minor === 'number' && Number.isSafeInteger(json.balance_minor) && json.balance_minor >= 0 ? { balanceMinor: json.balance_minor } : null), [200]);
  }
}
