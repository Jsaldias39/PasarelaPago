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

describe('clave de cruce por payment_intent_id (ola 2, 4b): la preferida; la referencia propia, el respaldo; nunca se adivina', () => {
  const PIID = (n: number) => `pi_abcdefghij${n.toString().padStart(2, '0')}`;
  const CH = (n: number) => `ch_zyxwvutsrq${n.toString().padStart(2, '0')}`;

  describe('correcto', () => {
    it('una línea con payment_intent_id cruza con el `pi_…:capture` del ledger aunque su `our_reference` sea el `ch_…` del conector', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', our_reference: CH(1), payment_intent_id: PIID(1), amount_minor: 10000 })],
        ledger: [led({ business_ref: PI(1), amount_minor: 9700 }), led({ business_ref: PI(1), amount_minor: 300, counterparty_account: 'platform:fees', code: 'fee' })],
      });
      expect(result.exceptions).toEqual([]);
      expect(result.matched).toBe(1);
      expect(result.lines[0].outcome).toBe('matched');
    });

    it('con payment_intent_id Y un `our_reference` que es el mismo `pi_…:capture` también cruza (no hay contradicción)', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', our_reference: PI(1), payment_intent_id: PIID(1) })], ledger: [led({ business_ref: PI(1) })] });
      expect(result.exceptions).toEqual([]);
      expect(result.matched).toBe(1);
    });

    it('UNA sola excepción amount_mismatch por diferencia, con extracto − ledger con signo, comercio y payment intent; el cobro que cuadra no genera nada', () => {
      const result = run({
        statement: [
          stmt({ provider_reference: 'B1', our_reference: CH(1), payment_intent_id: PIID(1), amount_minor: 10000 }),
          stmt({ provider_reference: 'B2', our_reference: CH(2), payment_intent_id: PIID(2), amount_minor: 9909 }),
        ],
        ledger: [led({ business_ref: PI(1), amount_minor: 10000 }), led({ business_ref: PI(2), amount_minor: 10009 })],
      });
      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({ kind: 'amount_mismatch', businessRef: PI(2), providerReference: 'B2', statementAmountMinor: 9909, ledgerAmountMinor: 10009, differenceMinor: -100, merchantId: 'mc_abcdefghijk', paymentIntentId: PIID(2) });
      expect(result.matched).toBe(1);
      expect(result.lines.map((l) => l.outcome)).toEqual(['matched', 'exception']);
    });
  });

  describe('límite', () => {
    it('sin payment_intent_id (ausente o null) cae al respaldo: cruza por `our_reference` como antes', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', our_reference: PI(1) }), stmt({ provider_reference: 'B2', our_reference: PI(2), payment_intent_id: null })],
        ledger: [led({ business_ref: PI(1) }), led({ business_ref: PI(2) })],
      });
      expect(result.exceptions).toEqual([]);
      expect(result.matched).toBe(2);
    });

    it('una línea con payment_intent_id y otra del mismo cobro sin él suman a la MISMA clave (cobro y reembolso parcial), y una sola diferencia', () => {
      const ok = run({
        statement: [stmt({ provider_reference: 'B1', our_reference: CH(1), payment_intent_id: PIID(1), amount_minor: 10000 }), stmt({ provider_reference: 'B2', our_reference: PI(1), amount_minor: 4000, direction: 'debit' })],
        ledger: [led({ business_ref: PI(1), amount_minor: 10000 }), led({ business_ref: PI(1), amount_minor: 4000, direction: 'credit', code: 'refund' })],
      });
      expect(ok.exceptions).toEqual([]);
      expect(ok.matched).toBe(2);
      const off = run({
        statement: [stmt({ provider_reference: 'B1', our_reference: CH(1), payment_intent_id: PIID(1), amount_minor: 10000 }), stmt({ provider_reference: 'B2', our_reference: PI(1), amount_minor: 3900, direction: 'debit' })],
        ledger: [led({ business_ref: PI(1), amount_minor: 10000 }), led({ business_ref: PI(1), amount_minor: 4000, direction: 'credit', code: 'refund' })],
      });
      expect(off.exceptions.map((e) => [e.kind, e.differenceMinor])).toEqual([['amount_mismatch', 100]]);
      expect(off.lines.every((l) => l.outcome === 'exception')).toBe(true);
    });

    it('sin payment_intent_id ni `our_reference` sigue siendo `unknown_reference`; con payment_intent_id y SIN `our_reference` ya cruza', () => {
      const unknown = run({ statement: [stmt({ provider_reference: 'B1', amount_minor: 250 })], ledger: [] });
      expect(unknown.exceptions.map((e) => e.kind)).toEqual(['unknown_reference']);
      const keyed = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1) })], ledger: [led({ business_ref: PI(1) })] });
      expect(keyed.exceptions).toEqual([]);
      expect(keyed.matched).toBe(1);
    });

    it('la misma línea del banco dos veces sigue siendo `duplicate_in_statement` y no suma al cruce', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1) }), stmt({ provider_reference: 'B1', payment_intent_id: PIID(1) })],
        ledger: [led({ business_ref: PI(1) })],
      });
      expect(result.exceptions.map((e) => e.kind)).toEqual(['duplicate_in_statement']);
      expect(result.matched).toBe(1);
    });
  });

  describe('inválido: nunca asume', () => {
    it('un payment_intent_id que el ledger no conoce ⇒ `missing_in_ledger` por el importe del extracto; NO se cruza con otro cobro del mismo importe', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', our_reference: CH(9), payment_intent_id: PIID(9), amount_minor: 1000 })],
        ledger: [led({ business_ref: PI(1), amount_minor: 1000 })],
      });
      expect(result.exceptions.map((e) => [e.kind, e.businessRef])).toEqual([
        ['missing_in_ledger', PI(9)],
        ['missing_in_statement', PI(1)],
      ]);
      expect(result.exceptions[0]).toMatchObject({ statementAmountMinor: 1000, ledgerAmountMinor: null, merchantId: null, paymentIntentId: PIID(9) });
      expect(result.matched).toBe(0);
    });

    it('el payment_intent_id contradice a un `our_reference` con forma de business_ref de OTRO cobro ⇒ `unknown_reference`; no se cruza con ninguno de los dos', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', our_reference: PI(2), payment_intent_id: PIID(1) })],
        ledger: [led({ business_ref: PI(1) }), led({ business_ref: PI(2) })],
      });
      expect(result.exceptions.map((e) => e.kind).sort()).toEqual(['missing_in_statement', 'missing_in_statement', 'unknown_reference']);
      expect(result.matched).toBe(0);
      expect(result.lines[0].outcome).toBe('exception');
    });

    it('un cobro del ledger repartido entre varios comercios no se atribuye a ninguno: `unknown_reference`', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), amount_minor: 1000 })],
        ledger: [led({ business_ref: PI(1), amount_minor: 600 }), led({ business_ref: PI(1), amount_minor: 400, counterparty_account: 'merchant:mc_otrocomercio1:pending' })],
      });
      expect(result.exceptions.map((e) => e.kind)).toEqual(['unknown_reference']);
      expect(result.matched).toBe(0);
    });

    it('una línea con payment_intent_id fuera del periodo se ignora, igual que las demás', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), booked_at: '2026-11-30T10:00:00.000Z', value_date: '2026-11-30' })], ledger: [] });
      expect(result.exceptions).toEqual([]);
      expect(result.ignored).toBe(1);
    });
  });
});

describe('merchant_id de la línea (ola 2, 4c): verifica el comercio del cobro al que apunta el payment_intent_id', () => {
  const PIID = (n: number) => `pi_abcdefghij${n.toString().padStart(2, '0')}`;
  const OWNER = 'mc_abcdefghijk'; // el comercio por defecto de `led`
  const OTHER = 'mc_zyxwvutsrqp';

  describe('correcto', () => {
    it('merchant_id igual al comercio del asiento ⇒ cruza sin excepción', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), merchant_id: OWNER })], ledger: [led({ business_ref: PI(1) })] });
      expect(result.exceptions).toEqual([]);
      expect(result.matched).toBe(1);
    });

    it('con merchant_id igual y un importe distinto sigue siendo UNA sola amount_mismatch', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), merchant_id: OWNER, amount_minor: 900 })], ledger: [led({ business_ref: PI(1) })] });
      expect(result.exceptions.map((e) => e.kind)).toEqual(['amount_mismatch']);
    });
  });

  describe('límite', () => {
    it('sin merchant_id (ausente o null) el comportamiento es el de antes: cruza', () => {
      const result = run({
        statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1) }), stmt({ provider_reference: 'B2', payment_intent_id: PIID(2), merchant_id: null })],
        ledger: [led({ business_ref: PI(1) }), led({ business_ref: PI(2) })],
      });
      expect(result.exceptions).toEqual([]);
      expect(result.matched).toBe(2);
    });

    it('el merchant_id sin payment_intent_id también se verifica contra el asiento del respaldo (`our_reference`)', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', our_reference: PI(1), merchant_id: OTHER })], ledger: [led({ business_ref: PI(1) })] });
      expect(result.exceptions.map((e) => e.kind)).toEqual(['unknown_reference']);
    });

    it('dos líneas de la misma clave: una sin merchant_id y otra con el correcto cruzan; si una nombra a otro comercio, la clave entera es excepción', () => {
      const ok = run({
        statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), amount_minor: 600 }), stmt({ provider_reference: 'B2', payment_intent_id: PIID(1), merchant_id: OWNER, amount_minor: 400 })],
        ledger: [led({ business_ref: PI(1) })],
      });
      expect(ok.exceptions).toEqual([]);
      const bad = run({
        statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), amount_minor: 600 }), stmt({ provider_reference: 'B2', payment_intent_id: PIID(1), merchant_id: OTHER, amount_minor: 400 })],
        ledger: [led({ business_ref: PI(1) })],
      });
      expect(bad.exceptions.map((e) => e.kind)).toEqual(['unknown_reference']);
      expect(bad.lines.map((l) => l.outcome)).toEqual(['exception', 'exception']);
    });
  });

  describe('inválido: nunca asume', () => {
    it('merchant_id de OTRO comercio ⇒ `unknown_reference` (no amount_mismatch) aunque el importe coincida; nombra al comercio del asiento y al payment intent; no cuenta como cruzada', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), merchant_id: OTHER })], ledger: [led({ business_ref: PI(1) })] });
      expect(result.exceptions).toHaveLength(1);
      expect(result.exceptions[0]).toMatchObject({ kind: 'unknown_reference', businessRef: PI(1), providerReference: 'B1', statementAmountMinor: 1000, ledgerAmountMinor: 1000, differenceMinor: 0, merchantId: OWNER, paymentIntentId: PIID(1) });
      expect(result.matched).toBe(0);
      expect(result.lines[0].outcome).toBe('exception');
    });

    it('con otro comercio Y otro importe sigue siendo UNA sola excepción, `unknown_reference` (el dueño se decide antes que el importe)', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), merchant_id: OTHER, amount_minor: 900 })], ledger: [led({ business_ref: PI(1) })] });
      expect(result.exceptions.map((e) => e.kind)).toEqual(['unknown_reference']);
    });

    it('un payment_intent_id que el ledger no tiene sigue siendo `missing_in_ledger` aunque la línea traiga merchant_id (no hay asiento con quien comparar)', () => {
      const result = run({ statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(9), merchant_id: OTHER })], ledger: [] });
      expect(result.exceptions.map((e) => e.kind)).toEqual(['missing_in_ledger']);
    });

    it('la misma diferencia es la misma excepción en otra corrida (dedupe_key estable)', () => {
      const input = { statement: [stmt({ provider_reference: 'B1', payment_intent_id: PIID(1), merchant_id: OTHER })], ledger: [led({ business_ref: PI(1) })] };
      expect(run(input).exceptions[0].dedupeKey).toBe(run(input).exceptions[0].dedupeKey);
    });
  });
});
