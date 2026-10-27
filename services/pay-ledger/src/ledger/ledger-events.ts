import { enqueue, newCloudEvent, type Queryable } from '@pay/outbox';
import { parseAccount } from './accounts';
import type { LegCode } from './tb-engine';

/**
 * Eventos del ledger (contracts/asyncapi/ledger-settlement.yaml). Se encolan en el outbox DENTRO de la transacción de Postgres
 * que registra el asiento: si esa transacción se deshace, el evento no existe. `data` lleva solo ids, cuentas lógicas e importes.
 */

const SOURCE = '/pay-ledger';

/** Tipo de movimiento del contrato HTTP → `kind` del evento. `release` no tiene `kind` en el contrato de eventos (PROPUESTAS.md #2). */
const KIND: Record<LegCode, string | null> = {
  charge: 'capture',
  fee: 'fee',
  refund: 'refund',
  payout: 'payout',
  release: null,
  wallet_transfer: 'wallet',
  mandate: 'scheduled_payment',
  adjustment: 'adjustment',
};

/** Comercio al que pertenece el movimiento: el del lado crédito si lo hay; si no, el del débito. */
function merchantOf(debit: string, credit: string): string | undefined {
  return parseAccount(credit)?.merchantId ?? parseAccount(debit)?.merchantId;
}

export interface PostedLeg {
  readonly transferId: string;
  readonly businessRef: string;
  readonly attempt: number;
  readonly code: LegCode;
  readonly debitAccount: string;
  readonly creditAccount: string;
  readonly amountMinor: number;
  readonly postedAt: Date;
}

/** `ledger.transfer.posted` — uno por pata asentada. Devuelve `false` si el movimiento no publica evento (`release`). */
export async function emitTransferPosted(client: Queryable, leg: PostedLeg): Promise<boolean> {
  const kind = KIND[leg.code];
  if (!kind) return false;
  const merchantId = merchantOf(leg.debitAccount, leg.creditAccount);
  const event = newCloudEvent({
    source: SOURCE,
    type: 'ledger.transfer.posted',
    subject: leg.transferId,
    ...(merchantId && { merchantId }),
    time: leg.postedAt,
    data: {
      transfer_id: leg.transferId,
      ledger_ref: leg.businessRef,
      attempt: leg.attempt,
      kind,
      debit_account: leg.debitAccount,
      credit_account: leg.creditAccount,
      amount_minor: leg.amountMinor,
      currency: 'BOB',
      posted_at: leg.postedAt.toISOString(),
    },
  });
  await enqueue(client, event, { aggregateType: 'ledger_transaction', aggregateId: leg.transferId });
  return true;
}

interface HoldBase {
  readonly holdId: string;
  readonly businessRef: string;
  readonly account: string;
  readonly creditAccount: string;
}

async function emitHold(client: Queryable, type: string, base: HoldBase, at: Date, data: Record<string, unknown>): Promise<void> {
  const merchantId = merchantOf(base.account, base.creditAccount);
  const event = newCloudEvent({
    source: SOURCE,
    type,
    subject: base.holdId,
    ...(merchantId && { merchantId }),
    time: at,
    data: { hold_id: base.holdId, ledger_ref: base.businessRef, account: base.account, currency: 'BOB', ...data },
  });
  await enqueue(client, event, { aggregateType: 'ledger_hold', aggregateId: base.holdId });
}

export const emitHoldCreated = (c: Queryable, b: HoldBase, d: { attempt: number; amountMinor: number; expiresAt: Date; at: Date }) =>
  emitHold(c, 'ledger.hold.created', b, d.at, { attempt: d.attempt, amount_minor: d.amountMinor, expires_at: d.expiresAt.toISOString() });

export const emitHoldPosted = (c: Queryable, b: HoldBase, d: { postedAmountMinor: number; transferId: string; at: Date }) =>
  emitHold(c, 'ledger.hold.posted', b, d.at, { posted_amount_minor: d.postedAmountMinor, transfer_id: d.transferId, posted_at: d.at.toISOString() });

export const emitHoldVoided = (c: Queryable, b: HoldBase, d: { amountMinor: number; reason: 'requested' | 'downstream_failed'; at: Date }) =>
  emitHold(c, 'ledger.hold.voided', b, d.at, { amount_minor: d.amountMinor, reason: d.reason, voided_at: d.at.toISOString() });

export const emitHoldExpired = (c: Queryable, b: HoldBase, d: { amountMinor: number; at: Date }) =>
  emitHold(c, 'ledger.hold.expired', b, d.at, { amount_minor: d.amountMinor, expired_at: d.at.toISOString() });
