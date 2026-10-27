import { createHash } from 'node:crypto';
import type { LedgerStatementEntry, StatementLine } from './ports';

export type ExceptionKind = 'missing_in_ledger' | 'missing_in_statement' | 'amount_mismatch' | 'duplicate_in_statement' | 'unknown_reference';

export interface ExceptionDraft {
  readonly kind: ExceptionKind;
  readonly providerReference: string | null;
  readonly businessRef: string | null;
  readonly statementAmountMinor: number | null;
  readonly ledgerAmountMinor: number | null;
  /** Extracto menos ledger, con signo. */
  readonly differenceMinor: number;
  readonly statementLineRef: string;
  readonly merchantId: string | null;
  readonly paymentIntentId: string | null;
  readonly dedupeKey: string;
}

export interface LineOutcome {
  readonly line: StatementLine;
  readonly lineRef: string;
  readonly outcome: 'matched' | 'exception' | 'ignored';
}

export interface PayoutFact {
  readonly amountMinor: number;
  readonly status: 'pending' | 'in_transit' | 'paid' | 'failed';
}

export interface ReconcileInput {
  readonly connector: string;
  readonly period: { readonly from: Date; readonly to: Date };
  readonly statement: readonly StatementLine[];
  /** Líneas del ledger en la cuenta de compensación del conector, dentro del periodo. */
  readonly ledger: readonly LedgerStatementEntry[];
  /** Pagos propios (payout id → hecho), para las líneas del extracto que son salidas de dinero nuestras. */
  readonly payouts: ReadonlyMap<string, PayoutFact>;
}

export interface ReconcileResult {
  readonly lines: LineOutcome[];
  readonly exceptions: ExceptionDraft[];
  readonly matched: number;
  readonly ignored: number;
  /** Pagos en tránsito que el extracto prueba pagados (misma referencia, mismo monto). */
  readonly confirmedPayouts: string[];
}

const PAYMENT_INTENT = /^(pi_[a-z0-9]{10,40}):/;
const PAYOUT_REF = /^(po_[a-z0-9]{10,40})(?::payout)?$/;
/** Una referencia con la forma de un `business_ref` del ledger: `pi_…:operación`. */
const LEDGER_REF = /^(pi_[a-z0-9]{10,40}):[a-z_]{3,30}$/;
const MERCHANT_ACCOUNT = /^merchant:(mc_[a-z0-9]{10,40}):(?:pending|available)$/;

const signed = (line: StatementLine): number => (line.direction === 'credit' ? line.amount_minor : -line.amount_minor);

function dedupe(connector: string, kind: ExceptionKind, businessRef: string | null, providerReference: string | null, statement: number | null, ledger: number | null): string {
  return createHash('sha256').update(['recon', connector, kind, businessRef ?? '', providerReference ?? '', statement ?? '', ledger ?? ''].join('|')).digest('hex');
}

/**
 * Cruce del extracto del conector contra el ledger (REQ-P2-6). Función PURA: no toca el ledger ni la base. El ledger no se ajusta solo:
 * toda diferencia sale como borrador de excepción para que una persona la resuelva.
 *
 * Reglas:
 *  - La clave de cruce es, EN ESTE ORDEN: (1) el `payment_intent_id` de la línea, si el conector la emparejó ⇒ `pi_…:capture`, el `business_ref` del cobro en el
 *    ledger; (2) si no lo trae, la nuestra referencia (`our_reference` = `business_ref` del cobro) como respaldo. Nunca se adivina: una línea cuyo
 *    `payment_intent_id` contradice a una `our_reference` con forma de `business_ref` es `unknown_reference`; un `payment_intent_id` que el ledger de ESTE
 *    modo no conoce (inexistente, de otro modo) es `missing_in_ledger`; un cobro del ledger repartido entre varios comercios es `unknown_reference`.
 *    Por cada clave se compara el neto del extracto (créditos − débitos del banco) con el neto del ledger en la cuenta de compensación (débitos − créditos): lo que entró al banco.
 *  - Una línea sin nuestra referencia no se puede cruzar: `unknown_reference`. Una referencia que el ledger no tiene: `missing_in_ledger`.
 *  - Un cobro del ledger que el extracto no trae: `missing_in_statement`. Montos distintos: `amount_minor` con la diferencia con signo.
 *  - La misma `provider_reference` dos veces: la segunda es `duplicate_in_statement` y NO suma al cruce.
 *  - Una línea fuera del periodo (por fecha de asiento) se ignora y se cuenta; no genera excepción.
 *  - Las salidas con referencia de un pago nuestro (`po_…`) se cruzan contra `settlement_payouts`, no contra el ledger del conector.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { connector, period } = input;
  const label = `${connector}:${period.from.toISOString().slice(0, 10)}..${period.to.toISOString().slice(0, 10)}`;
  const outcomes: LineOutcome[] = [];
  const exceptions: ExceptionDraft[] = [];
  const confirmedPayouts: string[] = [];
  const seen = new Set<string>();

  const byRef = new Map<string, { net: number; refs: string[]; first: string }>();
  /** Clave con la que cada línea entró al cruce (la de `payment_intent_id` o la de `our_reference`). */
  const keyOf = new Map<StatementLine, string>();
  input.statement.forEach((line, index) => {
    const lineRef = `${label}#linea-${index + 1}`;
    const instant = line.booked_at ? new Date(line.booked_at) : new Date(`${line.value_date}T00:00:00Z`);
    if (instant < period.from || instant >= period.to) {
      outcomes.push({ line, lineRef, outcome: 'ignored' });
      return;
    }
    if (seen.has(line.provider_reference)) {
      exceptions.push({
        kind: 'duplicate_in_statement',
        providerReference: line.provider_reference,
        businessRef: line.our_reference,
        statementAmountMinor: line.amount_minor,
        ledgerAmountMinor: null,
        differenceMinor: signed(line),
        statementLineRef: lineRef,
        merchantId: null,
        paymentIntentId: null,
        dedupeKey: dedupe(connector, 'duplicate_in_statement', line.our_reference, line.provider_reference, line.amount_minor, null),
      });
      outcomes.push({ line, lineRef, outcome: 'exception' });
      return;
    }
    seen.add(line.provider_reference);

    const payoutMatch = line.our_reference ? PAYOUT_REF.exec(line.our_reference) : null;
    if (payoutMatch) {
      const payout = input.payouts.get(payoutMatch[1]);
      const expectedDirection = line.direction === 'debit';
      if (payout && expectedDirection && payout.amountMinor === line.amount_minor && payout.status !== 'failed') {
        if (payout.status === 'in_transit') confirmedPayouts.push(payoutMatch[1]);
        outcomes.push({ line, lineRef, outcome: 'matched' });
      } else {
        const kind: ExceptionKind = payout ? 'amount_mismatch' : 'missing_in_ledger';
        exceptions.push({
          kind,
          providerReference: line.provider_reference,
          businessRef: line.our_reference,
          statementAmountMinor: line.amount_minor,
          ledgerAmountMinor: payout ? payout.amountMinor : null,
          differenceMinor: payout ? line.amount_minor - payout.amountMinor : line.amount_minor,
          statementLineRef: lineRef,
          merchantId: null,
          paymentIntentId: null,
          dedupeKey: dedupe(connector, kind, line.our_reference, line.provider_reference, line.amount_minor, payout?.amountMinor ?? null),
        });
        outcomes.push({ line, lineRef, outcome: 'exception' });
      }
      return;
    }

    // Clave de cruce de la línea (ver arriba). Una contradicción entre las dos identificaciones no se resuelve a favor de ninguna.
    const intent = line.payment_intent_id ?? null;
    const ownIntent = line.our_reference ? LEDGER_REF.exec(line.our_reference)?.[1] : undefined;
    if (intent && ownIntent && ownIntent !== intent) {
      exceptions.push({
        kind: 'unknown_reference',
        providerReference: line.provider_reference,
        businessRef: line.our_reference,
        statementAmountMinor: line.amount_minor,
        ledgerAmountMinor: null,
        differenceMinor: signed(line),
        statementLineRef: lineRef,
        merchantId: null,
        paymentIntentId: null,
        dedupeKey: dedupe(connector, 'unknown_reference', line.our_reference, line.provider_reference, line.amount_minor, null),
      });
      outcomes.push({ line, lineRef, outcome: 'exception' });
      return;
    }
    const key = intent ? `${intent}:capture` : line.our_reference;

    if (!key) {
      exceptions.push({
        kind: 'unknown_reference',
        providerReference: line.provider_reference,
        businessRef: null,
        statementAmountMinor: line.amount_minor,
        ledgerAmountMinor: null,
        differenceMinor: signed(line),
        statementLineRef: lineRef,
        merchantId: null,
        paymentIntentId: null,
        dedupeKey: dedupe(connector, 'unknown_reference', null, line.provider_reference, line.amount_minor, null),
      });
      outcomes.push({ line, lineRef, outcome: 'exception' });
      return;
    }
    const slot = byRef.get(key) ?? { net: 0, refs: [], first: lineRef };
    slot.net += signed(line);
    slot.refs.push(lineRef);
    byRef.set(key, slot);
    keyOf.set(line, key);
    outcomes.push({ line, lineRef, outcome: 'matched' }); // se corrige abajo si el cruce de su clave falla
  });

  // Neto del ledger por cobro: lo que entró a la cuenta de compensación del conector.
  const ledger = new Map<string, { net: number; merchantId: string | null; merchants: Set<string> }>();
  for (const entry of input.ledger) {
    const slot = ledger.get(entry.business_ref) ?? { net: 0, merchantId: null, merchants: new Set<string>() };
    slot.net += entry.direction === 'debit' ? entry.amount_minor : -entry.amount_minor;
    const merchant = MERCHANT_ACCOUNT.exec(entry.counterparty_account)?.[1] ?? null;
    if (merchant) slot.merchants.add(merchant);
    slot.merchantId ??= merchant;
    ledger.set(entry.business_ref, slot);
  }

  const failedRefs = new Set<string>();
  const draft = (kind: ExceptionKind, businessRef: string, statementNet: number | null, ledgerNet: number | null, lineRef: string, providerReference: string | null) => {
    const merchantId = ledger.get(businessRef)?.merchantId ?? null;
    exceptions.push({
      kind,
      providerReference,
      businessRef,
      statementAmountMinor: statementNet === null ? null : Math.abs(statementNet),
      ledgerAmountMinor: ledgerNet === null ? null : Math.abs(ledgerNet),
      differenceMinor: (statementNet ?? 0) - (ledgerNet ?? 0),
      statementLineRef: lineRef,
      merchantId,
      paymentIntentId: PAYMENT_INTENT.exec(businessRef)?.[1] ?? null,
      dedupeKey: dedupe(connector, kind, businessRef, providerReference, statementNet, ledgerNet),
    });
  };

  const providerOf = new Map<string, string>();
  for (const [line, key] of keyOf) if (!providerOf.has(key)) providerOf.set(key, line.provider_reference);

  for (const [ref, stmt] of byRef) {
    const led = ledger.get(ref);
    if (!led) {
      draft('missing_in_ledger', ref, stmt.net, null, stmt.first, providerOf.get(ref) ?? null);
      failedRefs.add(ref);
    } else if (led.merchants.size > 1) {
      // Un mismo cobro repartido entre varios comercios: no hay a quién atribuir la línea. No se adivina.
      draft('unknown_reference', ref, stmt.net, led.net, stmt.first, providerOf.get(ref) ?? null);
      failedRefs.add(ref);
    } else if (led.net !== stmt.net) {
      draft('amount_mismatch', ref, stmt.net, led.net, stmt.first, providerOf.get(ref) ?? null);
      failedRefs.add(ref);
    }
  }
  for (const [ref, led] of ledger) {
    if (byRef.has(ref) || led.net === 0) continue;
    draft('missing_in_statement', ref, null, led.net, `ledger:${ref}`, null);
  }

  const lines = outcomes.map((o) => {
    const key = keyOf.get(o.line);
    return key !== undefined && failedRefs.has(key) && o.outcome === 'matched' ? { ...o, outcome: 'exception' as const } : o;
  });
  return {
    lines,
    exceptions,
    matched: lines.filter((l) => l.outcome === 'matched').length,
    ignored: lines.filter((l) => l.outcome === 'ignored').length,
    confirmedPayouts,
  };
}
