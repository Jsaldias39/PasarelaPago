import { hashRequest, IdempotencyStore, type IdempotencyResult } from '@pay/idempotency';
import { ProblemError } from '@pay/problem';
import type { Deps } from '../deps';
import { disputeIdFor, intentIdFor, refundIdFor } from '../domain/ids';
import { quoteFee } from '../domain/quote';
import { emitDisputeEvent, emitIntentEvent, emitRefundEvent } from '../events/emit';
import { disputesRepo, type DisputeRow } from '../persistence/disputes.repo';
import { encodeCursor, intentsRepo, type IntentRow } from '../persistence/intents.repo';
import { refundsRepo, type RefundRow } from '../persistence/refunds.repo';
import { replicasRepo } from '../persistence/replicas.repo';
import type { PaymentOrchestrator } from './orchestrator';
import { toInternalIntent, toPublicIntent, toPublicRefund } from './serializers';
import { settleIntent } from './settle';
import { parseCreateIntent, parseCreateRefund, parseInternalIntent, parseList } from './validation';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Casos de uso de pay-payments detrás de la API pública, la interna y los consumidores. Nada de HTTP ni de Nest acá. */
export class PaymentsService {
  private readonly idempotency: IdempotencyStore;

  constructor(
    private readonly deps: Deps,
    private readonly orchestrator: PaymentOrchestrator,
  ) {
    // Una petición repetida mientras la primera corre ESPERA a que termine (en vez de recibir 409): así 50 POST iguales dan el mismo intento.
    this.idempotency = new IdempotencyStore(deps.pool, { lockTimeoutMs: 30_000, waitForCompletionMs: deps.config.policy.createWaitMs + 10_000 });
  }

  // ───────────────────────────── cobros ─────────────────────────────

  async createIntent(merchantId: string, idempotencyKey: string, body: unknown): Promise<IdempotencyResult<Record<string, unknown>>> {
    const input = parseCreateIntent(body);
    const request = { scope: `payments:create:${merchantId}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/payment_intents', body }) };
    return this.idempotency.execute(request, async (context) => {
      const id = intentIdFor(merchantId, idempotencyKey);
      if (context.recoveryPoint === 'started') {
        await this.assertMerchantMayCharge(merchantId);
        const schedule = await replicasRepo.effectiveFeeSchedule(this.deps.pool, merchantId, this.deps.now());
        if (!schedule) throw new ProblemError('validation_failed', { detail: 'El comercio no tiene tarifa publicada', errors: [{ field: 'payment_method.type', code: 'fee_schedule_missing' }] });
        const split = quoteFee(schedule.channels, input.method, input.amountMinor);
        if (input.method === 'bank_transfer' && !this.deps.config.policy.bankTransfer) {
          throw new ProblemError('validation_failed', { detail: 'La transferencia bancaria no está habilitada', errors: [{ field: 'payment_method.type', code: 'payment_method_unavailable' }] });
        }
        let walletUserRef: string | undefined;
        let authorizationId: string | undefined;
        if (input.method === 'wallet' && input.walletAuthorization) {
          // El usuario sale del token, nunca de la petición del comercio (IDOR). Sin token válido no se debita nada.
          const claims = await this.deps.wallet.consume({ token: input.walletAuthorization, merchantId, amountMinor: input.amountMinor, currency: 'BOB' });
          if (!claims) throw new ProblemError('forbidden', { detail: 'La autorización de billetera no es válida' });
          walletUserRef = claims.userId;
          authorizationId = claims.authorizationId;
        }
        const expiresAt = new Date(this.deps.now().getTime() + input.expiresInSeconds * 1000);
        await context.atomic('created', async (db) => {
          if (authorizationId) {
            const used = await db.query('INSERT INTO wallet_authorizations_used (authorization_id, merchant_id, payment_intent_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [authorizationId, merchantId, id]);
            if ((used.rowCount ?? 0) !== 1) throw new ProblemError('forbidden', { detail: 'La autorización de billetera ya se usó' });
          }
          const { inserted } = await intentsRepo.insert(db, {
            id, merchantId, amountMinor: input.amountMinor, method: input.method, feeMinor: Number(split.feeMinor), netMinor: Number(split.netMinor),
            description: input.description, metadata: input.metadata, expiresAt, cardToken: input.cardToken, walletUserRef,
          });
          if (inserted) {
            const row = await intentsRepo.byId(db, id);
            if (row) await emitIntentEvent(db, 'payment_intent.created', row);
          }
        });
      }
      await this.orchestrator.startPayment(id);
      const row = await this.waitForAction(id);
      return { status: 201, body: toPublicIntent(row) };
    });
  }

  async getIntent(merchantId: string, id: string): Promise<Record<string, unknown>> {
    return toPublicIntent(await intentsRepo.forMerchant(this.deps.pool, merchantId, id));
  }

  async listIntents(merchantId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = parseList(query);
    const page = await intentsRepo.list(this.deps.pool, merchantId, input);
    const last = page.rows[page.rows.length - 1];
    return { object: 'list', has_more: page.hasMore, next_cursor: page.hasMore && last ? encodeCursor(last) : null, data: page.rows.map(toPublicIntent) };
  }

  /**
   * Cancela un cobro que todavía espera al pagador. Si el conector ya lo cobró (409) es demasiado tarde: el cobro sigue su
   * camino y la respuesta es 409. La transición exige `requires_action` en la escritura: un cobro ya capturado no se cancela.
   */
  async cancelIntent(merchantId: string, id: string, idempotencyKey: string): Promise<IdempotencyResult<Record<string, unknown>>> {
    const request = { scope: `payments:cancel:${merchantId}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: `/payment_intents/${id}/cancel` }) };
    return this.idempotency.execute(request, async () => {
      const intent = await intentsRepo.forMerchant(this.deps.pool, merchantId, id);
      if (intent.status === 'canceled') return { status: 200, body: toPublicIntent(intent) };
      if (intent.status !== 'requires_action') throw new ProblemError('invalid_state_transition', { detail: `Un cobro ${intent.status} no se puede cancelar` });
      if (intent.chargeId) {
        const cancel = await this.deps.clients.connectors.cancelCharge(intent.chargeId, `${id}:cancel`);
        if (!cancel.ok) {
          await this.deps.pool.query("INSERT INTO payment_cancellation_requests (payment_intent_id, outcome) VALUES ($1, 'too_late')", [id]);
          throw new ProblemError('invalid_state_transition', { detail: 'El cobro ya no se puede cancelar' });
        }
      }
      const { intent: after } = await settleIntent(this.deps, id, 'canceled', {}, ['requires_action']);
      if (after.status !== 'canceled') {
        await this.deps.pool.query("INSERT INTO payment_cancellation_requests (payment_intent_id, outcome) VALUES ($1, 'too_late')", [id]);
        throw new ProblemError('invalid_state_transition', { detail: `Un cobro ${after.status} no se puede cancelar` });
      }
      await this.deps.pool.query("INSERT INTO payment_cancellation_requests (payment_intent_id, outcome) VALUES ($1, 'canceled')", [id]);
      await this.orchestrator.wakePayment(id);
      return { status: 200, body: toPublicIntent(after) };
    });
  }

  // ───────────────────────────── reembolsos ─────────────────────────────

  async createRefund(merchantId: string, intentId: string, idempotencyKey: string, body: unknown): Promise<IdempotencyResult<Record<string, unknown>>> {
    const input = parseCreateRefund(body);
    const request = { scope: `payments:refund:${merchantId}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: `/payment_intents/${intentId}/refunds`, body }) };
    return this.idempotency.execute(request, async (context) => {
      const refundId = refundIdFor(merchantId, idempotencyKey);
      if (context.recoveryPoint === 'started') {
        await intentsRepo.forMerchant(this.deps.pool, merchantId, intentId); // otro comercio ⇒ 404
        await context.atomic('created', async (db) => {
          // Se serializan los reembolsos del mismo cobro con bloqueo de fila: dos reembolsos que juntos pasan el total no caben.
          const intent = await intentsRepo.byId(db, intentId, { forUpdate: true });
          if (!intent || intent.merchantId !== merchantId) throw new ProblemError('resource_not_found');
          if (intent.status !== 'succeeded') throw new ProblemError('invalid_state_transition', { detail: `Un cobro ${intent.status} no se puede reembolsar` });
          const committed = await refundsRepo.committedAmount(db, intentId);
          if (committed + input.amountMinor > intent.amountMinor) {
            throw new ProblemError('validation_failed', { detail: 'El reembolso supera lo que queda por reembolsar', errors: [{ field: 'amount_minor', code: 'exceeds_refundable' }] });
          }
          const inserted = await refundsRepo.insert(db, { id: refundId, paymentIntentId: intentId, merchantId, amountMinor: input.amountMinor, reason: input.reason, metadata: input.metadata });
          if (inserted) {
            const row = await refundsRepo.byId(db, refundId);
            if (row) await emitRefundEvent(db, 'refund.created', row);
          }
        });
      }
      await this.orchestrator.startRefund(refundId);
      const row = await this.waitForRefund(refundId);
      return { status: 201, body: toPublicRefund(row) };
    });
  }

  async getRefund(merchantId: string, id: string): Promise<Record<string, unknown>> {
    return toPublicRefund(await refundsRepo.forMerchant(this.deps.pool, merchantId, id));
  }

  // ───────────────────────────── cobros de servicios internos ─────────────────────────────

  /** Cobro por mandato (pay-schedules). Idempotente por `source` + `period`: el mismo mandato y periodo no crea otro intento. */
  async createInternalIntent(idempotencyKey: string, body: unknown): Promise<IdempotencyResult<Record<string, unknown>>> {
    const input = parseInternalIntent(body);
    const request = { scope: `payments:internal:${input.payerMerchantId}`, key: idempotencyKey, requestHash: hashRequest({ method: 'POST', path: '/intents', body }) };
    return this.idempotency.execute(request, async (context) => {
      const existing = await intentsRepo.byMandatePeriod(this.deps.pool, input.source.id, input.source.period);
      if (existing) return { status: 200, body: toInternalIntent(await this.waitForAction(existing.id)) };
      const id = intentIdFor(input.payerMerchantId, `${input.source.id}:${input.source.period}`);
      if (context.recoveryPoint === 'started') {
        await this.assertMerchantMayCharge(input.payerMerchantId);
        const expiresAt = new Date(this.deps.now().getTime() + 3600_000);
        // Sin comisión sobre pagos programados hasta que el acuerdo comercial lo defina (x-open-question del contrato): D-P3-7.
        await context.atomic('created', async (db) => {
          const { inserted } = await intentsRepo.insert(db, {
            id, merchantId: input.payerMerchantId, amountMinor: input.amountMinor, method: 'wallet', feeMinor: 0, netMinor: input.amountMinor, description: input.description,
            metadata: {}, expiresAt, source: input.source, kind: input.kind, beneficiaryMerchantId: input.beneficiaryMerchantId,
          });
          if (inserted) {
            const row = await intentsRepo.byId(db, id);
            if (row) await emitIntentEvent(db, 'payment_intent.created', row);
          }
        });
      }
      await this.orchestrator.startPayment(id);
      const row = await this.waitForAction(id);
      if (row.status === 'failed' && row.failureCode === 'insufficient_funds') {
        throw new ProblemError('insufficient_funds', { detail: 'El pagador no tiene saldo suficiente' });
      }
      return { status: 201, body: toInternalIntent(row) };
    });
  }

  async getInternalIntent(id: string): Promise<Record<string, unknown>> {
    const row = await intentsRepo.byId(this.deps.pool, id);
    if (!row || !row.source) throw new ProblemError('resource_not_found');
    return toInternalIntent(row);
  }

  // ───────────────────────────── disputas ─────────────────────────────
  // El contrato no define una API de disputas (PROP-6): estos son los casos de uso; el borde HTTP o de eventos queda para cuando exista.

  async openDispute(input: { paymentIntentId: string; openedKey: string }): Promise<{ dispute: DisputeRow; created: boolean }> {
    const intent = await intentsRepo.byId(this.deps.pool, input.paymentIntentId);
    if (!intent) throw new ProblemError('resource_not_found');
    if (intent.status !== 'succeeded') throw new ProblemError('invalid_state_transition', { detail: 'Solo se disputa un cobro exitoso' });
    const id = disputeIdFor(intent.id, input.openedKey);
    const created = await this.deps.tx(async (db) => {
      const inserted = await disputesRepo.insert(db, { id, paymentIntentId: intent.id, merchantId: intent.merchantId, amountMinor: intent.amountMinor });
      if (inserted) {
        const row = await disputesRepo.byId(db, id);
        if (row) await emitDisputeEvent(db, 'dispute.opened', row);
      }
      return inserted;
    });
    const dispute = await disputesRepo.byId(this.deps.pool, id);
    if (!dispute) throw new ProblemError('invalid_state_transition', { detail: 'El cobro ya tiene una disputa abierta' });
    await this.orchestrator.startDispute(id);
    return { dispute, created };
  }

  async addEvidence(disputeId: string, reference: string): Promise<DisputeRow> {
    await disputesRepo.addEvidence(this.deps.pool, disputeId, reference);
    const dispute = await disputesRepo.byId(this.deps.pool, disputeId);
    if (!dispute) throw new ProblemError('resource_not_found');
    return dispute;
  }

  async resolveDispute(disputeId: string, outcome: 'won' | 'lost'): Promise<void> {
    const dispute = await disputesRepo.byId(this.deps.pool, disputeId);
    if (!dispute) throw new ProblemError('resource_not_found');
    if (dispute.status !== 'open') throw new ProblemError('invalid_state_transition', { detail: 'La disputa ya está resuelta' });
    await this.orchestrator.resolveDispute(disputeId, outcome);
  }

  // ───────────────────────────── internos ─────────────────────────────

  private async assertMerchantMayCharge(merchantId: string): Promise<void> {
    const status = await replicasRepo.merchantStatus(this.deps.pool, merchantId);
    if (status === 'suspended') throw new ProblemError('merchant_suspended');
    // Un comercio que no conocemos (sin evento todavía) o no activo no cobra: ante la duda se niega (D5).
    if (status !== 'active') throw new ProblemError('forbidden', { detail: 'El comercio no está activo' });
  }

  /** Espera a que el cobro deje de estar «procesando» (pide algo al pagador o terminó) o se acabe `createWaitMs`. */
  private async waitForAction(id: string): Promise<IntentRow> {
    const deadline = Date.now() + this.deps.config.policy.createWaitMs;
    for (;;) {
      const row = await intentsRepo.byId(this.deps.pool, id);
      if (!row) throw new ProblemError('resource_not_found');
      if (row.status !== 'processing' || Date.now() >= deadline) return row;
      await sleep(40);
    }
  }

  private async waitForRefund(id: string): Promise<RefundRow> {
    const deadline = Date.now() + this.deps.config.policy.createWaitMs;
    for (;;) {
      const row = await refundsRepo.byId(this.deps.pool, id);
      if (!row) throw new ProblemError('resource_not_found');
      if (row.status !== 'pending' || Date.now() >= deadline) return row;
      await sleep(40);
    }
  }
}
