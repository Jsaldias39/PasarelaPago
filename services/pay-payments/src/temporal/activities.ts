import { ApplicationFailure } from '@temporalio/activity';
import type { Deps } from '../deps';
import type { ChargeStatusValue } from '../clients/connectors.client';
import { toPublicNextAction } from '../domain/next-action';
import { businessRef } from '../domain/ids';
import { decideConnectorEvent, isTerminal, type IntentStatus } from '../domain/state';
import { emitIntentEvent, normalizeFailureCode, type IntentEventType } from '../events/emit';
import { settleIntent } from '../payments/settle';
import { contradictionsRepo } from '../persistence/contradictions.repo';
import type { Db } from '../persistence/db';
import { intentsRepo, type IntentRow } from '../persistence/intents.repo';
import type { ChargeSignal, ChargeStatusName, LedgerOutcome, NextStep, PaymentPlan } from './types';

const EVENT_FOR: Record<'succeeded' | 'failed' | 'canceled' | 'expired', IntentEventType> = {
  succeeded: 'payment_intent.succeeded',
  failed: 'payment_intent.failed',
  canceled: 'payment_intent.canceled',
  expired: 'payment_intent.expired',
};

const isUpstreamError = (error: unknown): boolean => error instanceof Error && error.name === 'UpstreamError';
const isRejection = (error: unknown): boolean => error instanceof Error && error.name === 'UpstreamRejection';

/** El conector llama «succeeded» a lo que el contrato de eventos llama «captured»; «requires_action» es «pending». */
export function chargeNameOf(status: ChargeStatusValue | string): ChargeStatusName {
  switch (status) {
    case 'succeeded':
    case 'captured':
      return 'captured';
    case 'authorized':
      return 'authorized';
    case 'failed':
    case 'canceled':
    case 'expired':
      return status;
    default:
      return 'pending';
  }
}

/**
 * Activities del cobro (P3.H2). TODA activity con efecto externo es idempotente: Temporal las ejecuta al menos una vez
 * (si el worker cae a mitad, se repite). La idempotencia sale de claves derivadas del intento (`${intentId}:risk|charge|cancel`,
 * `business_ref = ${intentId}:capture`), de precondiciones en la escritura (CAS sobre el estado) y de leer el estado de la base.
 */
export function createActivities(deps: Deps) {
  const { clients, config } = deps;

  const load = async (intentId: string): Promise<IntentRow> => {
    const row = await intentsRepo.byId(deps.pool, intentId);
    if (!row) throw ApplicationFailure.nonRetryable(`El intento ${intentId} no existe`, 'IntentNotFound');
    return row;
  };

  const settle = async (intentId: string, to: 'succeeded' | 'failed' | 'canceled' | 'expired', patch: { failureCode?: string; failureReason?: string; ledgerTransferId?: string } = {}): Promise<IntentRow> => {
    try {
      return (await settleIntent(deps, intentId, to, patch)).intent;
    } catch (error) {
      if (error instanceof Error && /no existe/.test(error.message)) throw ApplicationFailure.nonRetryable(error.message, 'IntentNotFound');
      throw error;
    }
  };

  /** Aplica una señal del conector sobre el intento con bloqueo de fila. Idempotente: el resultado sale del estado resultante. */
  const applySignal = async (intentId: string, signal: ChargeSignal): Promise<NextStep> =>
    deps.tx(async (db: Db) => {
      const intent = await intentsRepo.byId(db, intentId, { forUpdate: true });
      if (!intent) throw ApplicationFailure.nonRetryable(`El intento ${intentId} no existe`, 'IntentNotFound');
      if (isTerminal(intent.status)) return 'done';

      const { decision, reason } = decideConnectorEvent({ intentStatus: intent.status, chargeStatus: intent.chargeStatus, incoming: signal.status });
      if (decision === 'contradiccion') {
        await contradictionsRepo.record(db, { paymentIntentId: intentId, currentStatus: intent.chargeStatus, incomingStatus: signal.status, sourceEventId: `signal:${intent.chargeStatus}->${signal.status}`, kind: 'status_conflict', reason });
      }
      if (decision === 'aplicar') {
        await intentsRepo.setChargeStatus(db, intentId, intent.chargeStatus, signal.status);
        if (signal.status === 'failed' || signal.status === 'canceled' || signal.status === 'expired') {
          const to = signal.status;
          const row = await intentsRepo.transition(db, intentId, ['processing', 'requires_action'], to, { ...(to === 'failed' ? { failureCode: normalizeFailureCode(signal.failureCode) } : {}), nextAction: null });
          if (row) await emitIntentEvent(db, EVENT_FOR[to], row);
          return 'done';
        }
      }
      const charge = decision === 'aplicar' ? signal.status : intent.chargeStatus;
      if (charge === 'captured' || charge === 'settled') {
        // Cobrado: deja de esperar al pagador y pasa a registrarse en el ledger.
        if (intent.status === 'requires_action') {
          const row = await intentsRepo.transition(db, intentId, ['requires_action'], 'processing', { nextAction: null });
          if (row) await emitIntentEvent(db, 'payment_intent.processing', row);
        }
        return 'capture';
      }
      return 'continue';
    });

  /**
   * Consulta autoritativa del cargo. Un `404` exacto («el conector no conoce ese cargo», que el propio conector nos devolvió al
   * crearlo) es una ANOMALÍA, no una prueba de que no hubo pago: no anula, no vence ni falla nada (regla 11); se señala con
   * `notFound` para que quien llama escale y siga.
   */
  const inquire = async (intent: IntentRow): Promise<ChargeSignal & { notFound?: true }> => {
    if (!intent.chargeId) return { status: 'pending' };
    let state;
    try {
      state = await clients.connectors.getChargeStatus(intent.chargeId, intent.mode);
    } catch (error) {
      if (isRejection(error) && (error as { status?: number }).status === 404) return { status: 'pending', notFound: true };
      throw error;
    }
    // Un dato viejo del conector (`stale`) no es una novedad: se trata como «sin cambios».
    if (state.stale) return { status: 'pending' };
    return { status: chargeNameOf(state.status), failureCode: state.failure_code ? normalizeFailureCode(state.failure_code) : undefined };
  };

  return nonRetryableRejections({
    async loadPaymentPlan(intentId: string): Promise<PaymentPlan> {
      const intent = await load(intentId);
      return {
        status: intent.status,
        terminal: isTerminal(intent.status),
        method: intent.method,
        hasCharge: intent.chargeId !== null,
        chargeCaptured: intent.chargeStatus === 'captured',
        expiresAtMs: intent.expiresAt.getTime(),
        inquiryIntervalMs: config.policy.inquiryIntervalMs,
        activity: config.policy.activity,
      };
    },

    /**
     * Política fail-closed (P3.H2.M2): si el riesgo no responde, el cobro NO pasa cuando el monto alcanza el umbral (por
     * defecto 0: siempre). Con `deny` o `review` el cobro termina `failed`. Devuelve `proceed:false` ya con el intento cerrado.
     */
    async assessRisk(intentId: string): Promise<{ proceed: boolean }> {
      const intent = await load(intentId);
      if (isTerminal(intent.status)) return { proceed: false };
      try {
        const assessment = await clients.risk.assess({ merchantId: intent.merchantId, paymentIntentId: intent.id, amountMinor: intent.amountMinor, currency: intent.currency, method: intent.method });
        if (assessment.decision === 'allow') return { proceed: true };
        // D4: `review` se trata como `deny` hasta que exista cola de revisión manual.
        await settle(intentId, 'failed', { failureCode: 'risk_denied' });
        return { proceed: false };
      } catch (error) {
        if (isUpstreamError(error)) {
          const failClosed = BigInt(intent.amountMinor) >= config.policy.riskFailClosedThresholdMinor || !config.policy.riskAllowBelowThreshold;
          if (failClosed) {
            await settle(intentId, 'failed', { failureCode: 'risk_unavailable' });
            return { proceed: false };
          }
          return { proceed: true };
        }
        if (isRejection(error)) throw ApplicationFailure.nonRetryable(`pay-risk rechazó la petición: ${(error as Error).message}`, 'RiskRejected');
        throw error;
      }
    },

    async createCharge(intentId: string): Promise<{ state: 'waiting' | 'captured' | 'settled' }> {
      const intent = await load(intentId);
      if (isTerminal(intent.status)) return { state: 'settled' };
      if (intent.method === 'wallet') throw ApplicationFailure.nonRetryable('El saldo AloVida no tiene cargo en un conector', 'NoChargeForWallet');
      if (intent.chargeId) return { state: intent.chargeStatus === 'captured' ? 'captured' : 'waiting' };

      const outcome = await clients.connectors.createCharge({
        mode: intent.mode,
        paymentIntentId: intent.id,
        merchantId: intent.merchantId,
        amountMinor: intent.amountMinor,
        currency: intent.currency,
        method: intent.method,
        ...(intent.cardToken ? { cardToken: intent.cardToken } : {}),
        expiresAt: intent.expiresAt.toISOString(),
        ...(intent.description ? { description: intent.description } : {}),
      });
      if (!outcome.ok) {
        // `502 connector_unavailable` exacto: el conector garantiza que NO se envió nada; se reintenta y, agotados los
        // reintentos, el workflow cierra el cobro. Los demás rechazos (4xx declarados) son de negocio: el cobro no se puede hacer.
        if (outcome.status === 502) throw ApplicationFailure.retryable('El conector no está disponible (sin efecto)', 'ConnectorUnavailable');
        await settle(intentId, 'failed', { failureCode: outcome.status === 422 || outcome.code === 'card_declined' ? 'payment_declined' : normalizeFailureCode(outcome.code) });
        return { state: 'settled' };
      }
      const charge = outcome.value;
      const name = chargeNameOf(charge.status);
      if (name === 'failed' || name === 'canceled' || name === 'expired') {
        await settle(intentId, name, name === 'failed' ? { failureCode: normalizeFailureCode(charge.failure_code) } : {});
        return { state: 'settled' };
      }
      const nextAction = charge.next_action ? toPublicNextAction(charge.next_action, intent.expiresAt, config.policy.bankTransfer) : null;
      if (charge.next_action?.type === 'bank_transfer_instructions' && !nextAction) {
        // El conector no informó la cuenta y no hay respaldo (T-03): no se puede mostrar al pagador adónde transferir. Se anula el
        // cargo (con clave estable; si el conector no contesta, Temporal reintenta) y el POST responde 422 payment_method_unavailable.
        await clients.connectors.cancelCharge(charge.id, `${intentId}:cancel`, intent.mode);
        await settle(intentId, 'failed', { failureCode: 'validation_failed', failureReason: 'payment_method_unavailable' });
        return { state: 'settled' };
      }
      return deps.tx(async (db) => {
        const patch = { connector: charge.connector, chargeId: charge.id, chargeStatus: name === 'captured' ? 'captured' : 'pending' };
        if (nextAction && name !== 'captured') {
          const row = await intentsRepo.transition(db, intentId, ['processing'], 'requires_action', { ...patch, nextAction: nextAction as unknown as Record<string, unknown> });
          if (row) await emitIntentEvent(db, 'payment_intent.requires_action', row);
          else return { state: 'settled' as const };
        } else {
          const row = await intentsRepo.transition(db, intentId, ['processing'], 'processing', patch);
          if (!row) return { state: 'settled' as const };
        }
        return { state: name === 'captured' ? ('captured' as const) : ('waiting' as const) };
      });
    },

    /** Consulta el estado del cargo al conector: atrapa los eventos perdidos (REQ-P3-7). */
    async inquireCharge(intentId: string): Promise<ChargeSignal & { notFound?: true }> {
      return inquire(await load(intentId));
    },

    applyChargeSignal: applySignal,

    /**
     * Vencimiento: antes de dar el intento por vencido se le pregunta al conector, porque el pago pudo llegar y el evento perderse.
     * Si sigue pendiente se cancela el cargo; si el conector responde 409 es que se pagó justo ahora y se vuelve a consultar.
     */
    async resolveExpiry(intentId: string): Promise<NextStep> {
      const intent = await load(intentId);
      if (isTerminal(intent.status)) return 'done';
      if (!intent.chargeId) {
        await settle(intentId, 'expired');
        return 'done';
      }
      const first = await inquire(intent);
      if (first.notFound) {
        // No se puede verificar ni anular un cargo que el conector dice no conocer: el intento NO vence. Se escala y el workflow falla visible.
        await deps.tx((db) => contradictionsRepo.record(db, { paymentIntentId: intentId, currentStatus: intent.status, incomingStatus: 'ambiguous', sourceEventId: 'ambiguous:charge_not_found_at_connector', kind: 'charge_not_found_at_connector', reason: 'authoritative_query_not_found_keeps_state' }));
        throw ApplicationFailure.nonRetryable('El conector no conoce el cargo al vencer; se conserva el estado', 'ChargeNotFoundAtConnector');
      }
      if (first.status !== 'pending' && first.status !== 'authorized') return applySignal(intentId, first);
      const cancel = await clients.connectors.cancelCharge(intent.chargeId, `${intentId}:cancel`, intent.mode);
      if (!cancel.ok) {
        const again = await inquire(await load(intentId));
        if (again.status === 'captured') return applySignal(intentId, again);
      }
      await settle(intentId, 'expired');
      return 'done';
    },

    /**
     * Asiento del cobro en el ledger (único movimiento de dinero). `business_ref = ${intentId}:capture` y el intento (`attempt`)
     * sale de la base: repetir la activity repite la MISMA petición y el ledger devuelve el mismo asiento (H-TB1).
     */
    async recordLedger(intentId: string): Promise<LedgerOutcome> {
      const intent = await load(intentId);
      if (intent.ledgerTransferId) return { transferId: intent.ledgerTransferId };
      const source = ledgerSource(intent);
      const target = `merchant:${intent.beneficiaryMerchantId ?? intent.merchantId}:pending`;
      const legs = [
        { debit_account: source, credit_account: target, amount_minor: intent.netMinor, code: 'charge' as const },
        ...(intent.feeMinor > 0 ? [{ debit_account: source, credit_account: 'platform:fees', amount_minor: intent.feeMinor, code: 'fee' as const }] : []),
      ];
      const result = await clients.ledger.createTransaction({ mode: intent.mode, businessRef: businessRef.capture(intentId), attempt: intent.ledgerAttempt, currency: intent.currency, legs });
      if (result.kind === 'ok') return { transferId: result.value.id };
      if (result.kind === 'rejected') return { rejected: result.code };
      throw ApplicationFailure.nonRetryable('El ledger ya tiene un intento aceptado para este cobro y no se pudo leer', 'LedgerConflict');
    },

    /** Cierra el intento con éxito (ya está en el ledger) o con el motivo de fallo. Una sola vez: el CAS lo garantiza. */
    async completeIntent(intentId: string, outcome: { transferId: string } | { failureCode: string }): Promise<{ status: string }> {
      const row = await settle(intentId, 'transferId' in outcome ? 'succeeded' : 'failed', 'transferId' in outcome ? { ledgerTransferId: outcome.transferId } : { failureCode: outcome.failureCode });
      return { status: row.status };
    },

    /**
     * Compensación: el conector cobró y el ledger RECHAZÓ el asiento (respuesta definitiva). Se reembolsa el cargo completo con una
     * clave estable para que el pagador no pierda su dinero. Un resultado ambiguo se relanza (Temporal reintenta con la MISMA clave);
     * un rechazo definitivo del conector queda registrado para una persona y no se oculta.
     */
    async compensateCapture(intentId: string): Promise<{ compensated: boolean }> {
      const intent = await load(intentId);
      if (!intent.chargeId) return { compensated: true };
      const refund = await clients.connectors.createRefund(intent.chargeId, intent.amountMinor, `${intentId}:compensation`, intent.mode, { reason: 'duplicate' });
      if (refund.ok) return { compensated: true };
      await deps.tx((db) => contradictionsRepo.record(db, { paymentIntentId: intentId, currentStatus: intent.chargeStatus, incomingStatus: 'compensation_failed', sourceEventId: 'compensation', kind: 'compensation_failed', reason: refund.code }));
      return { compensated: false };
    },

    /**
     * Un resultado ambiguo (timeout, corte, 5xx) NO es un fallo (CLAUDE.md regla 11): no se anula nada, se conserva el estado y se
     * deja constancia para una persona. Idempotente por `kind`: escalar dos veces es lo mismo que una.
     */
    async escalate(intentId: string, kind: string): Promise<void> {
      const intent = await load(intentId);
      await deps.tx((db) => contradictionsRepo.record(db, { paymentIntentId: intentId, currentStatus: intent.status, incomingStatus: 'ambiguous', sourceEventId: `ambiguous:${kind}`, kind, reason: 'ambiguous_result_keeps_state' }));
    },

    async settleFailed(intentId: string, failureCode: string): Promise<{ status: string }> {
      const row = await settle(intentId, 'failed', { failureCode });
      return { status: row.status };
    },
  });
}

/** Cuenta que se debita: la billetera del usuario, el saldo del comercio pagador (cobro programado) o el clearing del conector. */
export function ledgerSource(intent: IntentRow): string {
  if (intent.method === 'wallet' && intent.walletUserRef) return `user:${intent.walletUserRef}:wallet`;
  if (intent.source) return `merchant:${intent.merchantId}:available`;
  return `connector:${intent.connector ?? 'mock'}:clearing`;
}

export type PaymentActivities = ReturnType<typeof createActivities>;

/**
 * Un rechazo 4xx que el contrato no declara para la operación es un error de integración nuestro: reintentar no lo arregla.
 * Se marca no reintentable para que el workflow lo escale y falle de forma visible, en vez de girar para siempre.
 */
export function nonRetryableRejections<T extends Record<string, (...args: never[]) => Promise<unknown>>>(activities: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(activities)) {
    wrapped[name] = async (...args: never[]) => {
      try {
        return await fn(...args);
      } catch (error) {
        if (isRejection(error)) throw ApplicationFailure.nonRetryable((error as Error).message, 'UpstreamRejection');
        throw error;
      }
    };
  }
  return wrapped as T;
}

/** Estados desde los que un cobro puede cancelarse (solo mientras espera al pagador). */
export const CANCELABLE: readonly IntentStatus[] = ['requires_action'];
