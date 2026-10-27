import { enqueue, newCloudEvent, type Queryable } from '@pay/outbox';
import type { PayMode } from './mode';

/**
 * Eventos de pay-settlement (contracts/asyncapi/ledger-settlement.yaml). Se encolan en el outbox DENTRO de la transacción de Postgres
 * que cambia el estado: si esa transacción se deshace, el evento no existe. `data` lleva solo ids, estados e importes.
 */
const SOURCE = '/pay-settlement';

/** El contrato de `payout.failed` admite cinco códigos (con `rail_rejected` desde la ola 2); los demás motivos del riel se informan como `internal_error`. */
const EVENT_FAILURE_CODES = new Set(['insufficient_funds', 'connector_unavailable', 'ledger_unavailable', 'rail_rejected', 'internal_error']);
export const eventFailureCode = (code: string): string => (EVENT_FAILURE_CODES.has(code) ? code : 'internal_error');

export interface PayoutEventBase {
  readonly payoutId: string;
  /** Modo de la clave que originó el pago (D-28); el evento lo informa. */
  readonly mode: PayMode;
  readonly merchantId: string;
  readonly amountMinor: number;
}

export async function emitPayoutCreated(
  client: Queryable,
  p: PayoutEventBase & { batchId: string | null; periodFrom: Date; periodTo: Date; at: Date },
): Promise<void> {
  await enqueue(
    client,
    newCloudEvent({
      source: SOURCE,
      type: 'payout.created',
      subject: p.payoutId,
      merchantId: p.merchantId,
      time: p.at,
      data: {
        mode: p.mode,
        payout_id: p.payoutId,
        merchant_id: p.merchantId,
        // Ausente en un pago suelto (`manual`, `mandate_obligation`, `mandate_commission`).
        ...(p.batchId && { settlement_batch_id: p.batchId }),
        amount_minor: p.amountMinor,
        currency: 'BOB',
        status: 'pending',
        period_from: p.periodFrom.toISOString(),
        period_to: p.periodTo.toISOString(),
      },
    }),
    { aggregateType: 'payout', aggregateId: p.payoutId },
  );
}

export async function emitPayoutPaid(client: Queryable, p: PayoutEventBase & { paidAt: Date }): Promise<void> {
  await enqueue(
    client,
    newCloudEvent({
      source: SOURCE,
      type: 'payout.paid',
      subject: p.payoutId,
      merchantId: p.merchantId,
      time: p.paidAt,
      data: { mode: p.mode, payout_id: p.payoutId, merchant_id: p.merchantId, amount_minor: p.amountMinor, currency: 'BOB', status: 'paid', paid_at: p.paidAt.toISOString() },
    }),
    { aggregateType: 'payout', aggregateId: p.payoutId },
  );
}

export async function emitPayoutFailed(client: Queryable, p: PayoutEventBase & { failureCode: string; failedAt: Date }): Promise<void> {
  await enqueue(
    client,
    newCloudEvent({
      source: SOURCE,
      type: 'payout.failed',
      subject: p.payoutId,
      merchantId: p.merchantId,
      time: p.failedAt,
      data: {
        mode: p.mode,
        payout_id: p.payoutId,
        merchant_id: p.merchantId,
        amount_minor: p.amountMinor,
        currency: 'BOB',
        status: 'failed',
        failure_code: eventFailureCode(p.failureCode),
        failed_at: p.failedAt.toISOString(),
      },
    }),
    { aggregateType: 'payout', aggregateId: p.payoutId },
  );
}

export async function emitBatchClosed(
  client: Queryable,
  b: { batchId: string; periodFrom: Date; periodTo: Date; merchantsCount: number; payoutsCount: number; releasedMinor: number; closedAt: Date },
): Promise<void> {
  await enqueue(
    client,
    newCloudEvent({
      source: SOURCE,
      type: 'settlement.batch.closed',
      subject: b.batchId,
      time: b.closedAt,
      data: {
        settlement_batch_id: b.batchId,
        period_from: b.periodFrom.toISOString(),
        period_to: b.periodTo.toISOString(),
        currency: 'BOB',
        merchants_count: b.merchantsCount,
        payouts_count: b.payoutsCount,
        released_minor: b.releasedMinor,
        closed_at: b.closedAt.toISOString(),
      },
    }),
    { aggregateType: 'settlement_batch', aggregateId: b.batchId },
  );
}

/** El contrato del evento no admite `unknown_reference`: se informa como `missing_in_ledger` (PROPUESTAS.md). */
const EVENT_EXCEPTION_KIND: Record<string, string> = { unknown_reference: 'missing_in_ledger' };

export async function emitExceptionOpened(
  client: Queryable,
  e: {
    exceptionId: string;
    connector: string;
    kind: string;
    differenceMinor: number;
    paymentIntentId: string | null;
    statementLineRef: string;
    merchantId: string | null;
    openedAt: Date;
  },
): Promise<void> {
  await enqueue(
    client,
    newCloudEvent({
      source: SOURCE,
      type: 'reconciliation.exception.opened',
      subject: e.exceptionId,
      ...(e.merchantId && { merchantId: e.merchantId }),
      time: e.openedAt,
      data: {
        exception_id: e.exceptionId,
        connector: e.connector,
        kind: EVENT_EXCEPTION_KIND[e.kind] ?? e.kind,
        difference_minor: e.differenceMinor,
        currency: 'BOB',
        ...(e.paymentIntentId && { payment_intent_id: e.paymentIntentId }),
        statement_line_ref: e.statementLineRef,
        opened_at: e.openedAt.toISOString(),
      },
    }),
    { aggregateType: 'reconciliation_exception', aggregateId: e.exceptionId },
  );
}
