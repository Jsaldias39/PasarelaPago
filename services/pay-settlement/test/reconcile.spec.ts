import type { LedgerStatementEntry, StatementLine } from '../src/settlement/ports';
import { type ReconcileInput, reconcile } from '../src/settlement/reconcile';

const period = { from: new Date('2026-10-19T04:00:00Z'), to: new Date('2026-10-26T04:00:00Z') };
const AT = '2026-10-20T14:30:00.000Z';

const stmt = (over: Partial<StatementLine> & { provider_reference: string }): StatementLine => ({ our_reference: null, direction: 'credit', amount_minor: 1000, value_date: '2026-10-20', booked_at: AT, ...over });
const led = (over: Partial<LedgerStatementEntry> & { business_ref: string }): LedgerStatementEntry => ({ direction: 'debit', counterparty_account: 'merchant:mc_abcdefghijk:pending', amount_minor: 1000, code: 'charge', posted_at: AT, ...over });
const run = (input: Partial<ReconcileInput>) => reconcile({ connector: 'mock', period, statement: [], ledger: [], payouts: new Map(), ...input });

const PI = (n: number) => `pi_abcdefghij${n.toString().padStart(2, '0')}:capture`;

describe('cruce extracto ↔ ledger (REQ-P2-6), función pura', () => {
  it('todo coincide: cobro con comisión (dos patas) contra una sola línea del banco por el bruto', () => {
    const result = run({
      statement: [stmt({ provider_reference: 'B1', our_reference: PI(1), amount_minor: 10000 })],
      ledger: [led({ business_ref: PI(1), amount_minor: 9700 }), led({ business_ref: PI(1), amount_minor: 300, counterparty_account: 'platform:fees', code: 'fee' })],
    });
    expect(result.exceptions).toEqual([]);
    expect(result.matched).toBe(1);
    expect(result.lines[0].outcome).toBe('matched');
  });

  it('un reembolso (crédito en la cuenta de compensación) y una línea de salida del banco netean contra el cobro', () => {
    const result = run({
      statement: [stmt({ provider_reference: 'B1', our_reference: PI(1), amount_minor: 10000 }), stmt({ provider_reference: 'B2', our_reference: PI(1), amount_minor: 4000, direction: 'debit' })],
      ledger: [led({ business_ref: PI(1), amount_minor: 10000 }), led({ business_ref: PI(1), amount_minor: 4000, direction: 'credit', code: 'refund' })],
    });
    expect(result.exceptions).toEqual([]);
    expect(result.matched).toBe(2);
  });

  it('amount_mismatch: la diferencia es extracto − ledger, con signo, y lleva comercio y payment intent', () => {
    const result = run({
      statement: [stmt({ provider_reference: 'B1', our_reference: PI(1), amount_minor: 9950 })],
      ledger: [led({ business_ref: PI(1), amount_minor: 10000 })],
    });
    expect(result.exceptions).toEqual([
      expect.objectContaining({ kind: 'amount_mismatch', businessRef: PI(1), providerReference: 'B1', statementAmountMinor: 9950, ledgerAmountMinor: 10000, differenceMinor: -50, merchantId: 'mc_abcdefghijk', paymentIntentId: 'pi_abcdefghij01' }),
    ]);
    expect(result.lines[0].outcome).toBe('exception');
    expect(result.matched).toBe(0);
  });

  it('missing_in_statement: el ledger cobró y el banco no lo trae', () => {
    const result = run({ ledger: [led({ business_ref: PI(2), amount_minor: 700 })] });
    expect(result.exceptions).toEqual([expect.objectContaining({ kind: 'missing_in_statement', businessRef: PI(2), statementAmountMinor: null, ledgerAmountMinor: 700, differenceMinor: -700, statementLineRef: `ledger:${PI(2)}` })]);
  });

  it('missing_in_ledger: el banco trae un cobro nuestro que el ledger no conoce', () => {
    const result = run({ statement: [stmt({ provider_reference: 'B3', our_reference: PI(3), amount_minor: 500 })] });
    expect(result.exceptions).toEqual([expect.objectContaining({ kind: 'missing_in_ledger', businessRef: PI(3), statementAmountMinor: 500, ledgerAmountMinor: null, differenceMinor: 500 })]);
  });

  it('unknown_reference: una línea sin nuestra referencia no se puede cruzar y no se adivina', () => {
    const result = run({ statement: [stmt({ provider_reference: 'B4', amount_minor: 250 })], ledger: [led({ business_ref: PI(1), amount_minor: 250 })] });
    expect(result.exceptions.map((e) => e.kind).sort()).toEqual(['missing_in_statement', 'unknown_reference']);
  });

  it('duplicate_in_statement: la segunda aparición no suma al cruce (el cobro igual cuadra) y se reporta', () => {
    const dup = stmt({ provider_reference: 'B5', our_reference: PI(1), amount_minor: 1000 });
    const result = run({ statement: [dup, { ...dup }], ledger: [led({ business_ref: PI(1), amount_minor: 1000 })] });
    expect(result.exceptions).toEqual([expect.objectContaining({ kind: 'duplicate_in_statement', providerReference: 'B5' })]);
    expect(result.matched).toBe(1);
  });

  it('límite de periodo: el instante `to` ya no es del periodo (se ignora), el instante `from` sí', () => {
    const result = run({
      statement: [
        stmt({ provider_reference: 'IN', our_reference: PI(1), booked_at: period.from.toISOString(), amount_minor: 1 }),
        stmt({ provider_reference: 'OUT', our_reference: PI(2), booked_at: period.to.toISOString(), amount_minor: 2 }),
        stmt({ provider_reference: 'OLD', our_reference: PI(3), booked_at: new Date(period.from.getTime() - 1).toISOString(), amount_minor: 3 }),
      ],
      ledger: [led({ business_ref: PI(1), amount_minor: 1 })],
    });
    expect(result.ignored).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.exceptions).toEqual([]);
  });

  it('sin booked_at se usa la fecha de valor a medianoche UTC', () => {
    const result = run({ statement: [stmt({ provider_reference: 'V1', our_reference: PI(1), booked_at: null, value_date: '2026-10-20', amount_minor: 5 })], ledger: [led({ business_ref: PI(1), amount_minor: 5 })] });
    expect(result.matched).toBe(1);
  });

  it('una línea fuera de periodo cuyo cobro SÍ está en el ledger del periodo se reporta como missing_in_statement (no se esconde el borde)', () => {
    const result = run({
      statement: [stmt({ provider_reference: 'LATE', our_reference: PI(1), booked_at: period.to.toISOString(), amount_minor: 100 })],
      ledger: [led({ business_ref: PI(1), amount_minor: 100 })],
    });
    expect(result.exceptions.map((e) => e.kind)).toEqual(['missing_in_statement']);
  });

  it('un cobro devuelto por completo en el mismo periodo (neto 0) no genera excepción aunque el banco no lo traiga', () => {
    const result = run({ ledger: [led({ business_ref: PI(1), amount_minor: 100 }), led({ business_ref: PI(1), amount_minor: 100, direction: 'credit', code: 'refund' })] });
    expect(result.exceptions).toEqual([]);
  });

  describe('salidas de dinero propias (payouts)', () => {
    const payout = 'po_abcdefghijklmnop';
    it('una salida con la referencia de un pago nuestro y el mismo monto cuadra, y confirma el pago si estaba en tránsito', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'T1', our_reference: `${payout}:payout`, direction: 'debit', amount_minor: 9000 })],
        payouts: new Map([[payout, { amountMinor: 9000, status: 'in_transit' as const }]]),
      });
      expect(result.exceptions).toEqual([]);
      expect(result.confirmedPayouts).toEqual([payout]);
    });

    it('un pago ya pagado cuadra sin volver a confirmarse', () => {
      const result = run({ statement: [stmt({ provider_reference: 'T1', our_reference: payout, direction: 'debit', amount_minor: 9000 })], payouts: new Map([[payout, { amountMinor: 9000, status: 'paid' as const }]]) });
      expect(result.exceptions).toEqual([]);
      expect(result.confirmedPayouts).toEqual([]);
    });

    it.each([
      ['otro monto', { direction: 'debit' as const, amount_minor: 8999 }, { amountMinor: 9000, status: 'in_transit' as const }, 'amount_mismatch'],
      ['sentido de crédito (entró plata)', { direction: 'credit' as const, amount_minor: 9000 }, { amountMinor: 9000, status: 'in_transit' as const }, 'amount_mismatch'],
      ['un pago que falló', { direction: 'debit' as const, amount_minor: 9000 }, { amountMinor: 9000, status: 'failed' as const }, 'amount_mismatch'],
      ['un pago que no existe', { direction: 'debit' as const, amount_minor: 9000 }, undefined, 'missing_in_ledger'],
    ])('%s ⇒ %s, y NO confirma nada', (_n, line, fact, kind) => {
      const result = run({ statement: [stmt({ provider_reference: 'T1', our_reference: `${payout}:payout`, ...line })], payouts: fact ? new Map([[payout, fact]]) : new Map() });
      expect(result.exceptions.map((e) => e.kind)).toEqual([kind]);
      expect(result.confirmedPayouts).toEqual([]);
    });
  });

  describe('dedupe_key: la misma diferencia es la misma excepción en cualquier corrida', () => {
    it('es estable entre corridas y distinta si cambia el monto', () => {
      const make = (amount: number) => run({ statement: [stmt({ provider_reference: 'B1', our_reference: PI(1), amount_minor: amount })], ledger: [led({ business_ref: PI(1), amount_minor: 1000 })] }).exceptions[0].dedupeKey;
      expect(make(900)).toBe(make(900));
      expect(make(900)).not.toBe(make(901));
      expect(make(900)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('propiedad (200 casos con semilla fija): extracto = ledger ⇒ cero excepciones; tocar UN monto ⇒ exactamente un amount_mismatch con esa diferencia', () => {
    let seed = 987654321n;
    const next = (limit: number): number => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return Number((seed >> 11n) % BigInt(limit));
    };
    for (let i = 0; i < 200; i += 1) {
      const count = 1 + next(12);
      const amounts = Array.from({ length: count }, () => 1 + next(5_000_000));
      const ledger = amounts.map((a, n) => led({ business_ref: PI(n), amount_minor: a }));
      const statement = amounts.map((a, n) => stmt({ provider_reference: `B${n}`, our_reference: PI(n), amount_minor: a }));
      expect(run({ ledger, statement }).exceptions).toEqual([]);
      const victim = next(count);
      const delta = 1 + next(500);
      const broken = statement.map((l, n) => (n === victim ? { ...l, amount_minor: l.amount_minor + delta } : l));
      const result = run({ ledger, statement: broken });
      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({ kind: 'amount_mismatch', businessRef: PI(victim), differenceMinor: delta });
    }
  });
});
