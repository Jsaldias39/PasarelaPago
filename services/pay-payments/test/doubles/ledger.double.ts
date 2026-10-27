import { createHash } from 'node:crypto';
import { CONTRACTS } from './contracts';
import { DoubleServer, problem, type DoubleRequest, type DoubleResponse } from './server';

interface Leg { debit_account: string; credit_account: string; amount_minor: number; code?: string }
interface TxAttempt { id: string; attempt: number; status: 'posted' | 'rejected'; content: string; currency: string; legs: Leg[] }
interface HoldRecord {
  id: string;
  business_ref: string;
  attempt: number;
  status: 'pending' | 'posted' | 'voided' | 'expired' | 'rejected';
  debit_account: string;
  credit_account: string;
  amount_minor: number;
  posted_amount_minor: number | null;
  currency: string;
  content: string;
  expires_at: string;
  created_at: string;
}

const CONSTRAINED = /^(merchant:[^:]+:available|user:[^:]+:wallet)$/;
const sha = (s: string, n = 14) => createHash('sha1').update(s).digest('hex').slice(0, n);

/**
 * [DOBLE] de pay-ledger (P2): implementa `internal-ledger-v1` incluida la regla de TigerBeetle H-1 que el contrato hace cumplir:
 *  - mismo `business_ref` + `attempt` con el mismo contenido ⇒ mismo resultado (`exists` / el mismo rechazo);
 *  - otro contenido ⇒ 422 `idempotency_key_reused`;
 *  - `attempt` nuevo tras un intento ACEPTADO, o con salto ⇒ 409 `invalid_state_transition` (no mueve dinero);
 *  - `merchant:*:available` y `user:*:wallet` no pueden quedar en negativo ⇒ 422 `insufficient_funds`.
 */
export class LedgerDouble {
  /** Saldo neto (créditos − débitos) por cuenta. */
  readonly balances = new Map<string, number>();
  readonly txs = new Map<string, TxAttempt[]>();
  readonly holds = new Map<string, HoldRecord>();
  private readonly holdsByRef = new Map<string, HoldRecord[]>();
  private readonly resolutions = new Map<string, HoldRecord>();
  /** Respuestas 503 pendientes: simula la caída del ledger. */
  failNext = 0;
  latencyMs = 0;
  readonly server: DoubleServer;

  constructor() {
    this.server = new DoubleServer(CONTRACTS.ledger, (req) => this.handle(req));
  }

  start = () => this.server.start();
  stop = () => this.server.stop();

  setBalance(account: string, minor: number): void {
    this.balances.set(account, minor);
  }
  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }
  /** Cuántas transacciones ACEPTADAS tiene el `business_ref` (el kill-test exige 1). */
  postedCount(businessRef: string): number {
    return (this.txs.get(businessRef) ?? []).filter((t) => t.status === 'posted').length;
  }
  postedLegs(businessRef: string): Leg[] {
    return (this.txs.get(businessRef) ?? []).find((t) => t.status === 'posted')?.legs ?? [];
  }
  /** Suma de todos los saldos: en partida doble cerrada siempre es 0 si los saldos iniciales se compensan. */
  totalBalance(): number {
    return [...this.balances.values()].reduce((a, b) => a + b, 0);
  }

  private pendingHeld(account: string): number {
    return [...this.holds.values()].filter((h) => h.status === 'pending' && h.debit_account === account).reduce((a, h) => a + h.amount_minor, 0);
  }

  private apply(legs: Leg[]): void {
    for (const l of legs) {
      this.balances.set(l.debit_account, this.balance(l.debit_account) - l.amount_minor);
      this.balances.set(l.credit_account, this.balance(l.credit_account) + l.amount_minor);
    }
  }

  private violates(legs: Leg[]): boolean {
    const net = new Map<string, number>();
    for (const l of legs) {
      net.set(l.debit_account, (net.get(l.debit_account) ?? 0) - l.amount_minor);
      net.set(l.credit_account, (net.get(l.credit_account) ?? 0) + l.amount_minor);
    }
    return [...net.entries()].some(([acct, delta]) => CONSTRAINED.test(acct) && this.balance(acct) - this.pendingHeld(acct) + delta < 0);
  }

  private txView(t: TxAttempt, ref: string, result: 'created' | 'exists') {
    return {
      id: t.id,
      object: 'transaction',
      result,
      business_ref: ref,
      attempt: t.attempt,
      status: t.status,
      reject_code: t.status === 'rejected' ? 'insufficient_funds' : null,
      currency: t.currency,
      legs: t.legs,
      created_at: new Date().toISOString(),
    };
  }

  private holdView(h: HoldRecord, result: 'created' | 'exists') {
    return {
      id: h.id,
      object: 'hold',
      result,
      business_ref: h.business_ref,
      attempt: h.attempt,
      status: h.status === 'rejected' ? 'voided' : h.status,
      debit_account: h.debit_account,
      credit_account: h.credit_account,
      amount_minor: h.amount_minor,
      posted_amount_minor: h.posted_amount_minor,
      currency: h.currency,
      expires_at: h.expires_at,
      created_at: h.created_at,
      resolved_at: h.status === 'posted' || h.status === 'voided' ? new Date().toISOString() : null,
    };
  }

  private async handle(req: DoubleRequest): Promise<DoubleResponse> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return problem('ledger_unavailable', 500); // el contrato declara la caída como 500 (propuesta: 503)
    }
    const out = this.route(req);
    return this.latencyMs ? { ...out, delayMs: this.latencyMs } : out;
  }

  private route(req: DoubleRequest): DoubleResponse {
    const { method, path } = req;
    if (method === 'POST' && path === '/transactions') return this.createTx(req.body as { business_ref: string; attempt: number; currency: string; legs: Leg[] });
    if (method === 'POST' && path === '/holds') return this.createHold(req.body as Record<string, unknown>);
    const hold = /^\/holds\/(hd_[a-z0-9]+)$/.exec(path);
    if (method === 'GET' && hold) {
      const h = this.holds.get(hold[1]);
      return h ? { status: 200, body: this.holdView(h, 'exists') } : problem('resource_not_found', 404);
    }
    const resolve = /^\/holds\/(hd_[a-z0-9]+)\/(post|void)$/.exec(path);
    if (method === 'POST' && resolve) return this.resolveHold(resolve[1], resolve[2] as 'post' | 'void', String(req.headers['idempotency-key']), req.body as { amount_minor?: number } | undefined);
    return problem('resource_not_found', 404);
  }

  private createTx(body: { business_ref: string; attempt: number; currency: string; legs: Leg[] }): DoubleResponse {
    const list = this.txs.get(body.business_ref) ?? [];
    this.txs.set(body.business_ref, list);
    const content = sha(JSON.stringify({ c: body.currency, l: body.legs }), 24);
    const same = list.find((t) => t.attempt === body.attempt);
    if (same) {
      if (same.content !== content) return problem('idempotency_key_reused', 422);
      return same.status === 'posted' ? { status: 200, body: this.txView(same, body.business_ref, 'exists') } : problem('insufficient_funds', 422);
    }
    if (list.some((t) => t.status === 'posted')) return problem('invalid_state_transition', 409);
    if (body.attempt !== (list.at(-1)?.attempt ?? 0) + 1) return problem('invalid_state_transition', 409);
    const rejected = this.violates(body.legs);
    const record: TxAttempt = { id: `tx_${sha(`${body.business_ref}:${body.attempt}`)}`, attempt: body.attempt, status: rejected ? 'rejected' : 'posted', content, currency: body.currency, legs: body.legs };
    list.push(record);
    if (rejected) return problem('insufficient_funds', 422);
    this.apply(body.legs);
    return { status: 201, body: this.txView(record, body.business_ref, 'created') };
  }

  private createHold(body: Record<string, unknown>): DoubleResponse {
    const ref = body.business_ref as string;
    const attempt = body.attempt as number;
    const list = this.holdsByRef.get(ref) ?? [];
    this.holdsByRef.set(ref, list);
    const content = sha(JSON.stringify([body.debit_account, body.credit_account, body.amount_minor, body.currency]), 24);
    const same = list.find((h) => h.attempt === attempt);
    if (same) {
      if (same.content !== content) return problem('idempotency_key_reused', 422);
      return same.status === 'rejected' ? problem('insufficient_funds', 422) : { status: 200, body: this.holdView(same, 'exists') };
    }
    if (list.some((h) => h.status !== 'rejected')) return problem('invalid_state_transition', 409);
    if (attempt !== (list.at(-1)?.attempt ?? 0) + 1) return problem('invalid_state_transition', 409);
    const debit = body.debit_account as string;
    const amount = body.amount_minor as number;
    const available = this.balance(debit) - this.pendingHeld(debit);
    const rejected = CONSTRAINED.test(debit) && available < amount;
    const record: HoldRecord = {
      id: `hd_${sha(`${ref}:${attempt}`)}`,
      business_ref: ref,
      attempt,
      status: rejected ? 'rejected' : 'pending',
      debit_account: debit,
      credit_account: body.credit_account as string,
      amount_minor: amount,
      posted_amount_minor: null,
      currency: body.currency as string,
      content,
      expires_at: new Date(Date.now() + (body.expires_in_seconds as number) * 1000).toISOString(),
      created_at: new Date().toISOString(),
    };
    list.push(record);
    this.holds.set(record.id, record);
    if (rejected) return problem('insufficient_funds', 422);
    return { status: 201, body: this.holdView(record, 'created') };
  }

  private resolveHold(id: string, action: 'post' | 'void', key: string, body?: { amount_minor?: number }): DoubleResponse {
    const memo = this.resolutions.get(`${id}:${action}:${key}`);
    if (memo) return { status: 200, body: this.holdView(memo, 'exists') };
    const hold = this.holds.get(id);
    if (!hold || hold.status === 'rejected') return problem('resource_not_found', 404);
    if (hold.status !== 'pending') return problem('invalid_state_transition', 409);
    if (action === 'post') {
      const amount = body?.amount_minor ?? hold.amount_minor;
      if (amount > hold.amount_minor) return problem('validation_failed', 422);
      hold.status = 'posted';
      hold.posted_amount_minor = amount;
      this.apply([{ debit_account: hold.debit_account, credit_account: hold.credit_account, amount_minor: amount }]);
    } else {
      hold.status = 'voided';
    }
    this.resolutions.set(`${id}:${action}:${key}`, hold);
    return { status: 200, body: this.holdView(hold, 'exists') };
  }
}
