import { createHash } from 'node:crypto';
import type { PayMode } from '../../src/settlement/mode';
import { LedgerRejectedError, LedgerUnavailableError, RailAmbiguousError, RailUnavailableError } from '../../src/settlement/errors';
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
} from '../../src/settlement/ports';

/**
 * [DOBLE] de pay-ledger (regla 65): cumple el contrato `LedgerPort` con las reglas que importan del ledger real —partida doble,
 * cuentas sin saldo negativo, `(business_ref, attempt)` idempotente, retenciones en dos fases con vencimiento—, en memoria.
 * NO prueba al ledger real (eso lo hace `ledger-real.spec.ts` contra el pay-ledger de verdad); prueba el código de pay-settlement
 * frente a todo lo que el contrato permite que pase, incluidas las caídas inyectadas con `failNext`.
 */
interface Failure {
  readonly op: string;
  readonly error: Error;
  times: number;
  /** `true` = la operación SÍ se aplicó y luego falló la respuesta (el caso que más daño hace). */
  readonly applyFirst: boolean;
}

interface StoredTx {
  readonly attempt: number;
  readonly status: 'posted' | 'rejected';
  readonly hash: string;
}

interface StoredHold extends LedgerHold {
  readonly businessRef: string;
  readonly attempt: number;
  readonly debit: string;
  readonly credit: string;
  readonly expiresAt: Date;
  resolvedBy?: string;
}

// Como el ledger real: las cuentas acreedoras no quedan en negativo (`pending` incluida) y la deuda del comercio no se puede pagar de más.
const LIMITED = /^(merchant:mc_[a-z0-9]+:(pending|available)|user:.+:wallet|schedule:md_[a-z0-9]+:reserve)$/;
const DEBT = /^merchant:mc_[a-z0-9]+:debt$/;

/** Todo lo que el ledger guarda de UN modo: el real separa por modo cuentas, asientos y retenciones (D-28). */
class ModeState {
  readonly net = new Map<string, number>();
  readonly pendingDebits = new Map<string, number>();
  readonly entries: (LedgerStatementEntry & { account: string })[] = [];
  readonly txs = new Map<string, StoredTx[]>();
  readonly holds = new Map<string, StoredHold>();
  readonly replays = new Map<string, LedgerHold>();
}

export class FakeLedger implements LedgerPort {
  private readonly states = new Map<PayMode, ModeState>();
  /** Cada llamada con su modo: las pruebas de modo comprueban que TODA llamada lo lleva. */
  readonly calls: { op: string; args: unknown; mode: PayMode }[] = [];
  private readonly failures: Failure[] = [];
  now: () => Date = () => new Date();
  private rejectOnce = false;

  /** Estado de un modo (se crea al primer uso). */
  state(mode: PayMode): ModeState {
    let state = this.states.get(mode);
    if (!state) {
      state = new ModeState();
      this.states.set(mode, state);
    }
    return state;
  }

  // Las pruebas de siempre (anteriores a D-28) viven en `test`: estos accesos son los de ese modo.
  get net(): Map<string, number> {
    return this.state('test').net;
  }
  get pendingDebits(): Map<string, number> {
    return this.state('test').pendingDebits;
  }
  get entries(): (LedgerStatementEntry & { account: string })[] {
    return this.state('test').entries;
  }

  count(op: string, mode?: PayMode): number {
    return this.calls.filter((c) => c.op === op && (mode === undefined || c.mode === mode)).length;
  }

  /** El ledger rechaza de verdad el próximo asiento por saldo (queda en su historial: el reintento exige `attempt + 1`). */
  rejectNextTransaction(): void {
    this.rejectOnce = true;
  }

  /** La próxima(s) `times` llamadas a `op` fallan con `error`. Con `applyFirst` la operación se aplica antes de fallar. */
  failNext(op: string, error: Error = new LedgerUnavailableError(), times = 1, applyFirst = false): void {
    this.failures.push({ op, error, times, applyFirst });
  }

  private take(op: string): Failure | undefined {
    const f = this.failures.find((x) => x.op === op && x.times > 0);
    if (f) f.times -= 1;
    return f;
  }

  private async guarded<T>(op: string, mode: PayMode, args: unknown, run: () => T): Promise<T> {
    this.calls.push({ op, args, mode });
    const failure = this.take(op);
    if (failure && !failure.applyFirst) throw failure.error;
    const result = run();
    if (failure) throw failure.error;
    return result;
  }

  balanceOf(account: string, mode: PayMode = 'test'): number {
    const state = this.state(mode);
    return (state.net.get(account) ?? 0) - (state.pendingDebits.get(account) ?? 0);
  }

  private move(state: ModeState, debit: string, credit: string, amount: number, businessRef: string, code: string, at: Date, hold = false): void {
    if (!hold) state.net.set(debit, (state.net.get(debit) ?? 0) - amount);
    state.net.set(credit, (state.net.get(credit) ?? 0) + amount);
    state.entries.push({ account: debit, business_ref: businessRef, direction: 'debit', counterparty_account: credit, amount_minor: amount, code, posted_at: at.toISOString() });
    state.entries.push({ account: credit, business_ref: businessRef, direction: 'credit', counterparty_account: debit, amount_minor: amount, code, posted_at: at.toISOString() });
  }

  /** Carga historia (un cobro ya asentado) sin pasar por el contrato: cuenta el dinero de entrada en el conector. */
  seedCharge(input: { merchant: string; net: number; fee: number; at: Date; ref: string; connector?: string; mode?: PayMode }): void {
    const state = this.state(input.mode ?? 'test');
    const clearing = `connector:${input.connector ?? 'mock'}:clearing`;
    this.move(state, clearing, `merchant:${input.merchant}:pending`, input.net, input.ref, 'charge', input.at);
    if (input.fee > 0) this.move(state, clearing, 'platform:fees', input.fee, input.ref, 'fee', input.at);
  }

  seedMovement(input: { debit: string; credit: string; amount: number; at: Date; ref: string; code: string; mode?: PayMode }): void {
    this.move(this.state(input.mode ?? 'test'), input.debit, input.credit, input.amount, input.ref, input.code, input.at);
  }

  private decide(history: StoredTx[], attempt: number, hash: string): 'new' | StoredTx {
    const same = history.find((h) => h.attempt === attempt);
    if (same) {
      if (same.hash !== hash) throw new LedgerRejectedError('validation_failed', 'idempotency_key_reused');
      return same;
    }
    if (history.some((h) => h.status !== 'rejected')) throw new LedgerRejectedError('invalid_state_transition', 'El business_ref ya tiene un intento aceptado');
    const expected = history.reduce((m, h) => Math.max(m, h.attempt), 0) + 1;
    if (attempt !== expected) throw new LedgerRejectedError('invalid_state_transition', `El siguiente attempt válido es ${expected}`);
    return 'new';
  }

  createTransaction(mode: PayMode, input: { businessRef: string; attempt: number; legs: readonly LedgerLeg[] }): Promise<void> {
    return this.guarded('createTransaction', mode, input, () => {
      const state = this.state(mode);
      if (input.legs.length === 0 || input.legs.some((l) => !Number.isInteger(l.amount_minor) || l.amount_minor < 1)) throw new LedgerRejectedError('validation_failed');
      const hash = createHash('sha256').update(JSON.stringify(input.legs)).digest('hex');
      const history = state.txs.get(input.businessRef) ?? [];
      const verdict = this.decide(history, input.attempt, hash);
      if (verdict !== 'new') {
        if (verdict.status === 'rejected') throw new LedgerRejectedError('insufficient_funds');
        return;
      }
      if (this.rejectOnce) {
        this.rejectOnce = false;
        history.push({ attempt: input.attempt, status: 'rejected', hash });
        state.txs.set(input.businessRef, history);
        throw new LedgerRejectedError('insufficient_funds');
      }
      // Todo o nada: se simula el saldo con las patas aplicadas en orden.
      const probe = new Map<string, number>();
      for (const leg of input.legs) {
        probe.set(leg.debit_account, (probe.get(leg.debit_account) ?? 0) - leg.amount_minor);
        probe.set(leg.credit_account, (probe.get(leg.credit_account) ?? 0) + leg.amount_minor);
      }
      const short = [...probe].some(([account, delta]) => (LIMITED.test(account) && this.balanceOf(account, mode) + delta < 0) || (DEBT.test(account) && this.balanceOf(account, mode) + delta > 0));
      if (short) {
        history.push({ attempt: input.attempt, status: 'rejected', hash });
        state.txs.set(input.businessRef, history);
        throw new LedgerRejectedError('insufficient_funds');
      }
      const at = this.now();
      for (const leg of input.legs) this.move(state, leg.debit_account, leg.credit_account, leg.amount_minor, input.businessRef, leg.code, at);
      history.push({ attempt: input.attempt, status: 'posted', hash });
      state.txs.set(input.businessRef, history);
    });
  }

  createHold(mode: PayMode, input: { businessRef: string; attempt: number; debitAccount: string; creditAccount: string; amountMinor: number; expiresInSeconds: number }): Promise<LedgerHold> {
    return this.guarded('createHold', mode, input, () => {
      const state = this.state(mode);
      const hash = createHash('sha256').update(JSON.stringify([input.debitAccount, input.creditAccount, input.amountMinor])).digest('hex');
      const key = `hold:${input.businessRef}`;
      const history = state.txs.get(key) ?? [];
      const verdict = this.decide(history, input.attempt, hash);
      const id = `hd_${createHash('sha256').update(`${mode}|${input.businessRef}|${input.attempt}`).digest('hex').slice(0, 20)}`;
      if (verdict !== 'new') {
        if (verdict.status === 'rejected') throw new LedgerRejectedError('insufficient_funds');
        return this.view(state, state.holds.get(id) as StoredHold);
      }
      if (LIMITED.test(input.debitAccount) && this.balanceOf(input.debitAccount, mode) < input.amountMinor) {
        history.push({ attempt: input.attempt, status: 'rejected', hash });
        state.txs.set(key, history);
        throw new LedgerRejectedError('insufficient_funds');
      }
      state.pendingDebits.set(input.debitAccount, (state.pendingDebits.get(input.debitAccount) ?? 0) + input.amountMinor);
      const hold: StoredHold = {
        id,
        status: 'pending',
        amount_minor: input.amountMinor,
        businessRef: input.businessRef,
        attempt: input.attempt,
        debit: input.debitAccount,
        credit: input.creditAccount,
        expiresAt: new Date(this.now().getTime() + input.expiresInSeconds * 1000),
      };
      state.holds.set(id, hold);
      history.push({ attempt: input.attempt, status: 'posted', hash });
      state.txs.set(key, history);
      return this.view(state, hold);
    });
  }

  private view(state: ModeState, hold: StoredHold): LedgerHold {
    if (hold.status === 'pending' && hold.expiresAt <= this.now()) this.expire(state, hold);
    return { id: hold.id, status: hold.status, amount_minor: hold.amount_minor };
  }

  private expire(state: ModeState, hold: StoredHold): void {
    (hold as { status: string }).status = 'expired';
    state.pendingDebits.set(hold.debit, (state.pendingDebits.get(hold.debit) ?? 0) - hold.amount_minor);
  }

  async getHold(mode: PayMode, holdId: string): Promise<LedgerHold | undefined> {
    this.calls.push({ op: 'getHold', args: holdId, mode });
    const state = this.state(mode);
    const hold = state.holds.get(holdId);
    return hold ? this.view(state, hold) : undefined;
  }

  private resolve(op: 'postHold' | 'voidHold', mode: PayMode, holdId: string, key: string): Promise<LedgerHold> {
    return this.guarded(op, mode, holdId, () => {
      const state = this.state(mode);
      const replay = state.replays.get(`${op}:${key}`);
      if (replay) return replay;
      const hold = state.holds.get(holdId);
      if (!hold) throw new LedgerRejectedError('validation_failed', 'no existe');
      const current = this.view(state, hold);
      if (current.status !== 'pending') throw new LedgerRejectedError('invalid_state_transition', `La retención ya está ${current.status}`);
      state.pendingDebits.set(hold.debit, (state.pendingDebits.get(hold.debit) ?? 0) - hold.amount_minor);
      if (op === 'postHold') {
        this.move(state, hold.debit, hold.credit, hold.amount_minor, hold.businessRef, 'payout', this.now());
        (hold as { status: string }).status = 'posted';
      } else {
        (hold as { status: string }).status = 'voided';
      }
      const result = this.view(state, hold);
      state.replays.set(`${op}:${key}`, result);
      return result;
    });
  }

  postHold(mode: PayMode, holdId: string, idempotencyKey: string): Promise<LedgerHold> {
    return this.resolve('postHold', mode, holdId, idempotencyKey);
  }

  voidHold(mode: PayMode, holdId: string, idempotencyKey: string): Promise<LedgerHold> {
    return this.resolve('voidHold', mode, holdId, idempotencyKey);
  }

  async getBalance(mode: PayMode, account: string): Promise<LedgerBalance | undefined> {
    this.calls.push({ op: 'getBalance', args: account, mode });
    const failure = this.take('getBalance');
    if (failure) throw failure.error;
    const state = this.state(mode);
    if (!state.net.has(account) && !state.pendingDebits.has(account)) return undefined;
    const value = this.balanceOf(account, mode);
    return { balance_minor: Math.abs(value), nature: value >= 0 ? 'credit' : 'debit', pending_debits_minor: state.pendingDebits.get(account) ?? 0 };
  }

  async listStatement(mode: PayMode, account: string, window: { from?: string; to?: string }): Promise<LedgerStatementEntry[]> {
    this.calls.push({ op: 'listStatement', args: { account, ...window }, mode });
    const failure = this.take('listStatement');
    if (failure) throw failure.error;
    return this.state(mode).entries
      .filter((e) => e.account === account)
      .filter((e) => (!window.from || e.posted_at >= window.from) && (!window.to || e.posted_at < window.to))
      .sort((a, b) => b.posted_at.localeCompare(a.posted_at))
      .map(({ account: _account, ...rest }) => rest);
  }
}

/**
 * [DOBLE] de pay-connectors: extractos configurables y órdenes de transferencia idempotentes por `payoutId`, con los escenarios del
 * contrato: pagado, en tránsito (con confirmación tardía), sin efecto (502 `connector_unavailable`), rechazo, y los AMBIGUOS: la orden
 * se ejecutó pero la respuesta se perdió (`ambiguous_executed`), o nunca llegó (`ambiguous_lost`).
 */
export type TransferScenario = 'paid' | 'in_transit' | 'unavailable' | 'rejected' | 'ambiguous_executed' | 'ambiguous_lost';

export class FakeConnectors implements ConnectorsPort {
  scenario: TransferScenario = 'paid';
  readonly statements = new Map<string, StatementDocument>();
  statementError?: Error;
  readonly orders: { order: PayoutOrder; key: string }[] = [];
  readonly executed = new Map<string, { reference: string; state: 'paid' | 'in_transit' }>();
  readonly statementRequests: { connector: string; from: string; to: string; format: StatementFormat }[] = [];

  async getStatement(input: { connector: string; from: string; to: string; format: StatementFormat }): Promise<StatementDocument> {
    this.statementRequests.push(input);
    if (this.statementError) throw this.statementError;
    return this.statements.get(input.connector) ?? { format: 'json', lines: [] };
  }

  async createTransfer(order: PayoutOrder, key: string): Promise<RailOutcome> {
    this.orders.push({ order, key });
    const reference = `tr_${order.payoutId}`;
    const already = this.executed.get(order.payoutId);
    if (already) return { state: already.state, reference: already.reference }; // idempotente: no paga dos veces
    switch (this.scenario) {
      case 'unavailable':
        throw new RailUnavailableError();
      case 'rejected':
        return { state: 'failed', code: 'rail_rejected' };
      case 'ambiguous_lost':
        throw new RailAmbiguousError();
      case 'ambiguous_executed':
        this.executed.set(order.payoutId, { reference, state: 'paid' });
        throw new RailAmbiguousError();
      case 'in_transit':
        this.executed.set(order.payoutId, { reference, state: 'in_transit' });
        return { state: 'in_transit', reference };
      default:
        this.executed.set(order.payoutId, { reference, state: 'paid' });
        return { state: 'paid', reference };
    }
  }

  async queryTransfer(order: PayoutOrder): Promise<RailOutcome> {
    const found = this.executed.get(order.payoutId);
    return found ? { state: found.state, reference: found.reference } : { state: 'not_found' };
  }

  /** El banco confirma tarde una transferencia que estaba en tránsito. */
  settle(payoutId: string): void {
    const found = this.executed.get(payoutId);
    if (found) this.executed.set(payoutId, { ...found, state: 'paid' });
  }

  get executedCount(): number {
    return this.executed.size;
  }
}
