import { ApplicationFailure } from '@temporalio/activity';
import type { Deps } from '../deps';
import { businessRef } from '../domain/ids';
import { emitDisputeEvent, emitRefundEvent } from '../events/emit';
import { contradictionsRepo } from '../persistence/contradictions.repo';
import { disputesRepo } from '../persistence/disputes.repo';
import { intentsRepo, type IntentRow } from '../persistence/intents.repo';
import { refundsRepo, type RefundRow } from '../persistence/refunds.repo';
import { nonRetryableRejections } from './activities';
import type { DisputePlan, RefundPlan } from './types';

const clearingOf = (intent: IntentRow) => `connector:${intent.connector ?? 'mock'}:clearing`;

/**
 * Activities del reembolso (P3.H2.M5): retención en dos fases sobre `merchant:X:available`.
 *   retener → pedir la devolución al conector → (éxito) confirmar la retención | (fallo) anularla.
 * Cada paso es idempotente: claves `${refundId}:refund|post|void` y `business_ref = ${refundId}:refund`.
 */
export function createRefundActivities(deps: Deps) {
  const { clients, config } = deps;

  const loadBoth = async (refundId: string): Promise<{ refund: RefundRow; intent: IntentRow }> => {
    const refund = await refundsRepo.byId(deps.pool, refundId);
    if (!refund) throw ApplicationFailure.nonRetryable(`El reembolso ${refundId} no existe`, 'RefundNotFound');
    const intent = await intentsRepo.byId(deps.pool, refund.paymentIntentId);
    if (!intent) throw ApplicationFailure.nonRetryable(`El intento ${refund.paymentIntentId} no existe`, 'IntentNotFound');
    return { refund, intent };
  };

  return nonRetryableRejections({
    async loadRefundPlan(refundId: string): Promise<RefundPlan> {
      const { refund } = await loadBoth(refundId);
      return { status: refund.status, hasHold: refund.ledgerHoldId !== null, waitMs: config.policy.refundWaitMs, activity: config.policy.activity };
    },

    /** Reserva el importe en el saldo disponible del comercio. Sin fondos el reembolso falla sin haber tocado al conector. */
    async holdRefund(refundId: string): Promise<{ rejected?: 'insufficient_funds' | 'validation_failed' }> {
      const { refund, intent } = await loadBoth(refundId);
      if (refund.status !== 'pending' || refund.ledgerHoldId) return {};
      const result = await clients.ledger.createHold({
        businessRef: businessRef.refund(refundId),
        attempt: 1,
        debitAccount: `merchant:${refund.merchantId}:available`,
        creditAccount: clearingOf(intent),
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        expiresInSeconds: config.policy.refundHoldSeconds,
      });
      if (result.kind === 'ok') {
        await refundsRepo.setHold(deps.pool, refundId, result.value.id);
        return {};
      }
      if (result.kind === 'rejected') return { rejected: result.code };
      throw ApplicationFailure.nonRetryable('El ledger ya tiene una retención para este reembolso y no coincide', 'LedgerConflict');
    },

    async refundAtConnector(refundId: string): Promise<{ status: 'succeeded' | 'failed' | 'pending'; failureCode?: string }> {
      const { refund, intent } = await loadBoth(refundId);
      if (!intent.chargeId) throw ApplicationFailure.nonRetryable('El cobro no tiene cargo en un conector para reembolsar', 'NoCharge');
      const outcome = await clients.connectors.createRefund(intent.chargeId, refund.amountMinor, `${refundId}:refund`, refund.reason ?? undefined);
      if (!outcome.ok) return { status: 'failed', failureCode: outcome.code };
      const { status, failure_code: failureCode } = outcome.value;
      return { status, ...(failureCode ? { failureCode } : {}) };
    },

    /** El conector devolvió el dinero: se confirma la retención (el dinero sale del saldo) y se cierra el reembolso. */
    async finishRefund(refundId: string): Promise<void> {
      const { refund } = await loadBoth(refundId);
      if (refund.status !== 'pending') return;
      if (!refund.ledgerHoldId) throw ApplicationFailure.nonRetryable('Reembolso sin retención en el ledger', 'NoHold');
      const posted = await clients.ledger.postHold(refund.ledgerHoldId, `${refundId}:post`);
      // `conflict` = la retención ya estaba resuelta (una ejecución anterior la confirmó): se sigue.
      if (posted.kind === 'rejected') throw ApplicationFailure.nonRetryable('El ledger rechazó confirmar la retención', 'LedgerRejected');
      await deps.tx(async (db) => {
        const done = await refundsRepo.complete(db, refundId, 'succeeded', { ledgerTransferId: refund.ledgerHoldId as string });
        if (done) await emitRefundEvent(db, 'refund.succeeded', done);
      });
    },

    /** El reembolso no se hizo: se anula la retención (el saldo vuelve entero) y se cierra como fallido. */
    async failRefund(refundId: string, failureCode: string, voidHold: boolean): Promise<void> {
      const { refund } = await loadBoth(refundId);
      if (refund.status !== 'pending') return;
      if (voidHold && refund.ledgerHoldId) await clients.ledger.voidHold(refund.ledgerHoldId, `${refundId}:void`);
      await deps.tx(async (db) => {
        const done = await refundsRepo.complete(db, refundId, 'failed', { failureCode });
        if (done) await emitRefundEvent(db, 'refund.failed', done);
      });
    },

    /**
     * Resultado ambiguo o sin respuesta final (CLAUDE.md regla 11): NO se anula la retención ni se da por fallido. Se conserva el
     * estado y se deja constancia para una persona; el workflow sigue esperando/reintentando con la misma clave.
     */
    async escalateRefund(refundId: string, kind: string): Promise<void> {
      const { refund } = await loadBoth(refundId);
      await deps.tx((db) => contradictionsRepo.record(db, { paymentIntentId: refund.paymentIntentId, currentStatus: `refund_${refund.status}`, incomingStatus: 'ambiguous', sourceEventId: `ambiguous:${kind}:${refundId}`, kind, reason: 'ambiguous_result_keeps_state' }));
    },
  });
}

export type RefundActivities = ReturnType<typeof createRefundActivities>;

/**
 * Activities de la disputa (P3.H2.M6). Perdida ⇒ se debita el importe al comercio (D-22): del saldo `pending`, que no tiene
 * invariante de fondos, así que si no alcanza queda como deuda (saldo negativo) para el neteo del próximo corte.
 */
export function createDisputeActivities(deps: Deps) {
  const { clients, config } = deps;
  return nonRetryableRejections({
    async loadDisputePlan(disputeId: string): Promise<DisputePlan> {
      const dispute = await disputesRepo.byId(deps.pool, disputeId);
      if (!dispute) throw ApplicationFailure.nonRetryable(`La disputa ${disputeId} no existe`, 'DisputeNotFound');
      return { status: dispute.status, activity: config.policy.activity };
    },

    async settleDispute(disputeId: string, outcome: 'won' | 'lost'): Promise<{ status: 'won' | 'lost' | 'open' }> {
      const dispute = await disputesRepo.byId(deps.pool, disputeId);
      if (!dispute) throw ApplicationFailure.nonRetryable(`La disputa ${disputeId} no existe`, 'DisputeNotFound');
      if (dispute.status !== 'open') return { status: dispute.status };
      const intent = await intentsRepo.byId(deps.pool, dispute.paymentIntentId);
      if (!intent) throw ApplicationFailure.nonRetryable(`El intento ${dispute.paymentIntentId} no existe`, 'IntentNotFound');

      let transferId: string | undefined;
      if (outcome === 'lost') {
        const result = await clients.ledger.createTransaction({
          businessRef: businessRef.chargeback(disputeId),
          attempt: 1,
          currency: dispute.currency,
          legs: [{ debit_account: `merchant:${dispute.merchantId}:pending`, credit_account: clearingOf(intent), amount_minor: dispute.amountMinor, code: 'adjustment' }],
        });
        if (result.kind !== 'ok') throw ApplicationFailure.nonRetryable('El ledger no aceptó el débito del contracargo', 'LedgerRejected');
        transferId = result.value.id;
      }
      await deps.tx(async (db) => {
        const done = await disputesRepo.resolve(db, disputeId, outcome, transferId);
        if (done) await emitDisputeEvent(db, outcome === 'won' ? 'dispute.won' : 'dispute.lost', {
            id: done.id, paymentIntentId: done.paymentIntentId, merchantId: done.merchantId, amountMinor: done.amountMinor, currency: done.currency,
            openedAt: done.openedAt, ...(done.resolvedAt ? { resolvedAt: done.resolvedAt } : {}), ledgerTransferId: done.ledgerTransferId,
          });
      });
      return { status: outcome };
    },

    async escalateDispute(disputeId: string, kind: string): Promise<void> {
      const dispute = await disputesRepo.byId(deps.pool, disputeId);
      if (!dispute) throw ApplicationFailure.nonRetryable(`La disputa ${disputeId} no existe`, 'DisputeNotFound');
      await deps.tx((db) => contradictionsRepo.record(db, { paymentIntentId: dispute.paymentIntentId, currentStatus: `dispute_${dispute.status}`, incomingStatus: 'ambiguous', sourceEventId: `ambiguous:${kind}:${disputeId}`, kind, reason: 'ambiguous_result_keeps_state' }));
    },
  });
}

export type DisputeActivities = ReturnType<typeof createDisputeActivities>;
