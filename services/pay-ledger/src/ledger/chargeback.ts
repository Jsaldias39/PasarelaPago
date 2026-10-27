import type { LegDto } from './dto';
import { type AccountInfo, parseAccount } from './accounts';
import { accountTbId, legTbId } from './ids';
import type { PayMode } from './mode';
import { ProblemError } from '@pay/problem';
import { LEDGER_BOB, type TigerBeetleEngine, transferCode } from './tb-engine';

/**
 * Contracargo perdido (D-22, P3-D10): un movimiento `adjustment` de `merchant:{id}:pending` a la cuenta de compensación de un conector.
 * `pending` nunca queda en negativo (lo impone TigerBeetle), así que lo que el pendiente no cubre se asienta como DEUDA del comercio en
 * `merchant:{id}:debt`. El llamador manda UNA pata por el monto bruto; el servidor la parte en `min(bruto, pendiente)` desde `pending` y el
 * exceso desde `debt`, las dos en el mismo lote enlazado: o se asientan las dos o ninguna.
 *
 * Es el único movimiento al que se le permite pasarse de lo pendiente, y solo por esta forma exacta; cualquier otro código u otro destino que
 * intente dejar `pending` en negativo se rechaza por saldo, como siempre.
 */
export function isChargeback(leg: { debit_account: string; credit_account: string; code?: string }): boolean {
  return leg.code === 'adjustment' && parseAccount(leg.debit_account)?.kind === 'merchant_pending' && parseAccount(leg.credit_account)?.kind === 'connector_clearing';
}

/** `422 idempotency_key_reused`: lo que TigerBeetle ya tiene con este `(business_ref, attempt)` no es este contracargo. */
const reusedKey = () => new ProblemError('idempotency_key_reused', { detail: 'El (business_ref, attempt) ya se aplicó con otro contenido' });

export interface SplitPlan {
  /** Patas que efectivamente se asientan (las que se guardan, salen en el extracto y publican evento). */
  readonly legs: LegDto[];
  /** Id de TigerBeetle de cada pata de `legs`. */
  readonly tbIds: bigint[];
  /** Comercios con un contracargo en el pedido: hay que serializar sus contracargos. */
  readonly merchants: string[];
}

/**
 * Decide cómo se parte cada contracargo del pedido.
 *
 * Determinista ante una caída: si TigerBeetle ya aplicó este `(business_ref, attempt)` y Postgres no llegó a registrarlo, se ADOPTA lo aplicado
 * (se lee de TigerBeetle por id) en vez de recalcular con un saldo que ya cambió. Solo si no hay nada aplicado se parte según el saldo actual.
 */
export async function planLegs(tb: TigerBeetleEngine, mode: PayMode, businessRef: string, attempt: number, requested: readonly LegDto[]): Promise<SplitPlan> {
  const legs: LegDto[] = [];
  const tbIds: bigint[] = [];
  const merchants = new Set<string>();

  const chargebacks = requested.map((leg, index) => ({ leg, index })).filter(({ leg }) => isChargeback(leg));
  const applied = new Map<number, { main?: bigint; debt?: bigint }>();
  if (chargebacks.length > 0) {
    const ids = chargebacks.flatMap(({ index }) => [legTbId(mode, businessRef, attempt, index), legTbId(mode, businessRef, attempt, index, 'debt')]);
    const found = new Map((await tb.lookupTransfers(ids)).map((t) => [t.id, t]));
    for (const { leg, index } of chargebacks) {
      const info = parseAccount(leg.debit_account) as AccountInfo;
      const clearing = accountTbId(mode, leg.credit_account);
      // Lo ya aplicado se adopta SOLO si es exactamente una mitad de este contracargo: mismas cuentas, ledger y código, y las dos mitades suman el bruto.
      const half = (part: 'main' | 'debt', debitName: string): bigint | undefined => {
        const t = found.get(legTbId(mode, businessRef, attempt, index, part));
        if (!t) return undefined;
        if (t.debit_account_id !== accountTbId(mode, debitName) || t.credit_account_id !== clearing || t.ledger !== LEDGER_BOB || t.code !== transferCode('adjustment')) throw reusedKey();
        return t.amount;
      };
      const main = half('main', leg.debit_account);
      const debt = half('debt', `merchant:${info.merchantId}:debt`);
      const gross = BigInt(leg.amount_minor);
      if ((main !== undefined || debt !== undefined) && (main ?? 0n) + (debt ?? 0n) !== gross) throw reusedKey();
      applied.set(index, { main, debt });
    }
  }

  // Saldo disponible en `pending` de cada comercio con contracargo, leído UNA vez y consumido en orden si el pedido trae varios.
  const free = new Map<string, bigint>();
  const pendingInfos = new Map<string, AccountInfo>();
  for (const { leg } of chargebacks) pendingInfos.set(leg.debit_account, parseAccount(leg.debit_account) as AccountInfo);
  if (pendingInfos.size > 0) {
    const accounts = await tb.lookupAccounts([...pendingInfos.keys()].map((name) => accountTbId(mode, name)));
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const name of pendingInfos.keys()) {
      const a = byId.get(accountTbId(mode, name));
      free.set(name, a ? a.credits_posted - a.debits_posted - a.debits_pending : 0n);
    }
  }

  requested.forEach((leg, index) => {
    if (!isChargeback(leg)) {
      legs.push(leg);
      tbIds.push(legTbId(mode, businessRef, attempt, index));
      return;
    }
    const info = pendingInfos.get(leg.debit_account) as AccountInfo;
    merchants.add(info.merchantId as string);
    const gross = BigInt(leg.amount_minor);
    const prior = applied.get(index) ?? {};
    let fromPending: bigint;
    if (prior.main !== undefined) fromPending = prior.main; // ya aplicado y verificado: se adopta
    else if (prior.debt !== undefined) fromPending = gross - prior.debt; // idem: solo existe la mitad de la deuda
    else {
      const available = free.get(leg.debit_account) ?? 0n;
      fromPending = available <= 0n ? 0n : available < gross ? available : gross;
      free.set(leg.debit_account, available - fromPending);
    }
    const excess = gross - fromPending;
    if (fromPending > 0n) {
      legs.push({ ...leg, amount_minor: Number(fromPending) });
      tbIds.push(legTbId(mode, businessRef, attempt, index));
    }
    if (excess > 0n) {
      legs.push({ ...leg, debit_account: `merchant:${info.merchantId}:debt`, amount_minor: Number(excess) });
      tbIds.push(legTbId(mode, businessRef, attempt, index, 'debt'));
    }
  });
  return { legs, tbIds, merchants: [...merchants].sort() };
}
