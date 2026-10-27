/**
 * Workflows de pay-payments. Código DETERMINISTA: nada de I/O, `Date.now()` es el reloj del workflow, y todo efecto va en
 * una activity (idempotente). Solo importa `@temporalio/workflow` y tipos: el bundle del worker no puede traer más.
 */
import { ActivityFailure, ApplicationFailure, condition, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { PaymentActivities } from './activities';
import type { RefundActivities, DisputeActivities } from './activities-money';
import { SIGNALS, type ActivityPolicy, type ChargeSignal, type NextStep, type PaymentResult, type RefundStep } from './types';

export const connectorEventSignal = defineSignal<[ChargeSignal]>(SIGNALS.connectorEvent);
export const wakeSignal = defineSignal(SIGNALS.wake);
export const refundEventSignal = defineSignal<[{ status: 'succeeded' | 'failed'; failureCode?: string }]>(SIGNALS.refundEvent);
export const resolveDisputeSignal = defineSignal<[{ outcome: 'won' | 'lost' }]>(SIGNALS.resolveDispute);

// El plan se lee con una política fija; el resto de las activities usa la de la configuración que el propio plan devuelve.
const boot = { startToCloseTimeout: 10_000, retry: { maximumAttempts: 8, initialInterval: 500, maximumInterval: 5_000 } } as const;
const policy = (p: ActivityPolicy) => ({
  startToCloseTimeout: p.timeoutMs,
  retry: { maximumAttempts: p.maxAttempts, initialInterval: p.initialMs, maximumInterval: p.maxMs },
});

const isNonRetryable = (error: unknown): boolean => error instanceof ActivityFailure && error.cause instanceof ApplicationFailure && error.cause.nonRetryable === true;
const causeType = (error: unknown): string | undefined => (error instanceof ActivityFailure && error.cause instanceof ApplicationFailure ? (error.cause.type ?? undefined) : undefined);

/**
 * Un resultado AMBIGUO no es un fallo (CLAUDE.md regla 11). Si una activity agota sus reintentos por un timeout, un corte o un 5xx,
 * NO se anula nada ni se cierra el cobro por «no disponible»: se escala a una persona (una vez) y se reintenta con la MISMA clave
 * de idempotencia, despacio, hasta que haya una respuesta definitiva. Se corta solo ante lo que no tiene arreglo reintentando
 * (un error no reintentable), ante una respuesta que `isDefinitive` reconoce o, si se da, al llegar `deadlineMs`.
 */
const EXPIRED = Symbol('expired');
async function untilResolved<T>(options: { run: () => Promise<T>; escalate: () => Promise<unknown>; slowMs: number; isDefinitive?: (error: unknown) => boolean; deadlineMs?: number }): Promise<T | typeof EXPIRED> {
  let escalated = false;
  for (;;) {
    try {
      return await options.run();
    } catch (error) {
      if (isNonRetryable(error) || options.isDefinitive?.(error)) throw error;
      if (!escalated) {
        try {
          await options.escalate();
          escalated = true;
        } catch {
          // No se pudo dejar constancia ahora: se reintenta en la próxima ronda.
        }
      }
      if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) return EXPIRED;
      await sleep(options.slowMs);
    }
  }
}

export async function PaymentWorkflow(input: { intentId: string }): Promise<PaymentResult> {
  const { intentId } = input;
  const inbox: ChargeSignal[] = [];
  let woken = false;
  let notFoundEscalated = false;
  setHandler(connectorEventSignal, (signal) => {
    inbox.push(signal);
  });
  setHandler(wakeSignal, () => {
    woken = true;
  });

  const first = proxyActivities<PaymentActivities>(boot);
  const plan = await first.loadPaymentPlan(intentId);
  if (plan.terminal) return { status: plan.status };
  const a = proxyActivities<PaymentActivities>(policy(plan.activity));
  const slowMs = plan.activity.slowRetryMs;
  const keep = <T>(kind: string, run: () => Promise<T>, extra: { isDefinitive?: (error: unknown) => boolean; deadlineMs?: number } = {}) =>
    untilResolved({ run, escalate: () => a.escalate(intentId, kind), slowMs, ...extra });
  const must = async <T>(kind: string, run: () => Promise<T>): Promise<T> => (await keep(kind, run)) as T;
  const finalStatus = async (): Promise<PaymentResult> => ({ status: (await must('state_read_unknown', () => a.loadPaymentPlan(intentId))).status });

  // Señales que llegaron en la misma ráfaga que la que cerró el cobro (por ejemplo `captured` y luego `failed`): no se descartan, se pasan por
  // `applyChargeSignal`, que las registra como contradicción si afirman algo incompatible con el estado terminal (REQ-P3-3).
  const drainLateSignals = async (): Promise<void> => {
    while (inbox.length > 0) {
      const late = inbox.shift() as ChargeSignal;
      await must('late_signal_unknown', () => a.applyChargeSignal(intentId, late));
    }
  };

  const body = async (): Promise<PaymentResult> => {
    const risk = await must('risk_unknown', () => a.assessRisk(intentId));
    if (!risk.proceed) return await finalStatus();

    let step: NextStep = 'capture';
    if (plan.method !== 'wallet') {
      // Crear el cargo es una orden: si no se sabe si se creó, se reintenta con la misma clave hasta saberlo o hasta el vencimiento.
      // Solo `connector_unavailable` (sin efecto, garantizado por el contrato) cierra el cobro tras agotar los reintentos.
      let charge;
      try {
        charge = await keep('charge_outcome_unknown', () => a.createCharge(intentId), { isDefinitive: (error) => causeType(error) === 'ConnectorUnavailable', deadlineMs: plan.expiresAtMs });
      } catch (error) {
        if (causeType(error) !== 'ConnectorUnavailable') throw error;
        await must('finalize_unknown', () => a.settleFailed(intentId, 'connector_unavailable'));
        return await finalStatus();
      }
      if (charge === EXPIRED) {
        step = await must('expiry_unknown', () => a.resolveExpiry(intentId));
      } else {
        if (charge.state === 'settled') return await finalStatus();
        step = charge.state === 'captured' ? 'capture' : 'continue';
      }
    }

    while (step === 'continue') {
      const remaining = plan.expiresAtMs - Date.now();
      if (remaining <= 0) {
        step = await must('cancel_outcome_unknown', () => a.resolveExpiry(intentId));
        break;
      }
      await condition(() => inbox.length > 0 || woken, Math.min(plan.inquiryIntervalMs, remaining));
      const signal = inbox.shift();
      if (signal) {
        step = await must('state_update_unknown', () => a.applyChargeSignal(intentId, signal));
      } else if (woken) {
        woken = false;
        if ((await must('state_read_unknown', () => a.loadPaymentPlan(intentId))).terminal) return await finalStatus();
      } else if (plan.expiresAtMs - Date.now() > 0) {
        // Nadie avisó: se pregunta al conector (un evento perdido no puede dejar el cobro colgado, REQ-P3-7).
        try {
          const state = await a.inquireCharge(intentId);
          if (state.notFound && !notFoundEscalated) {
            // El conector dice no conocer un cargo que él creó: no es prueba de que no se pagó. Se escala y se sigue esperando.
            await must('charge_not_found_at_connector', () => a.escalate(intentId, 'charge_not_found_at_connector'));
            notFoundEscalated = true;
          } else if (state.status !== 'pending') step = await must('state_update_unknown', () => a.applyChargeSignal(intentId, state));
        } catch (error) {
          if (isNonRetryable(error)) throw error;
          // El conector no contestó: es una consulta de solo lectura; se vuelve a preguntar en el próximo ciclo.
        }
      }
    }
    if (step === 'done') return await finalStatus();

    // El conector ya cobró. Si el ledger no contesta NO se devuelve el dinero ni se cierra el cobro: se conserva el estado,
    // se escala y se reintenta con la misma clave hasta que el ledger responda (R-11). Solo un RECHAZO definitivo compensa.
    const ledger = await must('ledger_outcome_unknown', () => a.recordLedger(intentId));
    if (ledger.transferId) return await must('finalize_unknown', () => a.completeIntent(intentId, { transferId: ledger.transferId as string }));
    if (plan.method !== 'wallet') await must('compensation_outcome_unknown', () => a.compensateCapture(intentId));
    return await must('finalize_unknown', () => a.completeIntent(intentId, { failureCode: ledger.rejected ?? 'internal_error' }));
  };

  try {
    const result = await body();
    await drainLateSignals();
    return result;
  } catch (error) {
    // Lo que no se arregla reintentando (un error de integración, un dato que no existe): se deja constancia y el workflow falla
    // de forma visible. El cobro NO se cierra por esto.
    await a.escalate(intentId, 'workflow_stuck').catch(() => undefined);
    throw error;
  }
}

export async function RefundWorkflow(input: { refundId: string }): Promise<{ status: RefundStep }> {
  const { refundId } = input;
  const events: { status: 'succeeded' | 'failed'; failureCode?: string }[] = [];
  setHandler(refundEventSignal, (event) => {
    events.push(event);
  });

  const first = proxyActivities<RefundActivities>(boot);
  const plan = await first.loadRefundPlan(refundId);
  if (plan.status !== 'pending') return { status: plan.status };
  const a = proxyActivities<RefundActivities>(policy(plan.activity));
  const slowMs = plan.activity.slowRetryMs;
  const must = async <T>(kind: string, run: () => Promise<T>): Promise<T> => (await untilResolved({ run, escalate: () => a.escalateRefund(refundId, kind), slowMs })) as T;

  try {
    // Todo paso con dinero es una orden: ante un resultado ambiguo se conserva la retención, se escala y se reintenta con la misma clave.
    const hold = await must('hold_outcome_unknown', () => a.holdRefund(refundId));
    if (hold.rejected) {
      await must('finalize_unknown', () => a.failRefund(refundId, hold.rejected as string, false));
      return { status: 'failed' };
    }
    let result = await must('refund_outcome_unknown', () => a.refundAtConnector(refundId));
    if (result.status === 'pending') {
      // El aviso del conector puede no llegar: se espera `waitMs`, se escala UNA vez y luego se CONSULTA al conector
      // (`GET /refunds/{id}`, solo lectura) cada ciclo. Mientras no responda algo definitivo no se libera la retención ni se
      // da el reembolso por fallido (CLAUDE.md regla 11).
      let notFoundEscalated = false;
      let settled = await condition(() => events.length > 0, plan.waitMs);
      if (!settled) await must('refund_pending_timeout', () => a.escalateRefund(refundId, 'refund_pending_timeout'));
      while (!settled) {
        try {
          const state = await a.inquireRefund(refundId);
          if (state.notFound && !notFoundEscalated) {
            // El conector dice no conocer un reembolso que él mismo creó: una persona tiene que mirarlo. La retención queda puesta.
            await must('refund_not_found_at_connector', () => a.escalateRefund(refundId, 'refund_not_found_at_connector'));
            notFoundEscalated = true;
          } else if (state.status !== 'pending') {
            result = state;
            break;
          }
        } catch (error) {
          if (isNonRetryable(error)) throw error;
          // El conector no contestó: es una consulta; se vuelve a intentar en el próximo ciclo.
        }
        settled = await condition(() => events.length > 0, plan.inquiryIntervalMs);
      }
      const event = events[0];
      if (result.status === 'pending' && event) result = { status: event.status, ...(event.failureCode ? { failureCode: event.failureCode } : {}) };
    }
    // Avisos del conector que se contradicen entre sí (`succeeded` y `failed` del mismo reembolso): manda el primero, el conflicto no se pierde.
    const conflicting = events.length > 1 && events.some((e) => e.status !== events[0]?.status);
    if (result.status === 'succeeded') {
      await must('post_outcome_unknown', () => a.finishRefund(refundId));
      if (conflicting) await must('refund_status_conflict', () => a.escalateRefund(refundId, 'refund_status_conflict'));
      return { status: 'succeeded' };
    }
    // Rechazo DEFINITIVO del conector (4xx declarado o `502 connector_unavailable` exacto = sin efecto): recién ahí se anula la retención.
    await must('void_outcome_unknown', () => a.failRefund(refundId, result.failureCode ?? 'connector_unavailable', true));
    if (conflicting) await must('refund_status_conflict', () => a.escalateRefund(refundId, 'refund_status_conflict'));
    return { status: 'failed' };
  } catch (error) {
    await a.escalateRefund(refundId, 'workflow_stuck').catch(() => undefined);
    throw error;
  }
}

export async function DisputeWorkflow(input: { disputeId: string }): Promise<{ status: 'won' | 'lost' | 'open' }> {
  const { disputeId } = input;
  let resolution: 'won' | 'lost' | null = null;
  setHandler(resolveDisputeSignal, ({ outcome }) => {
    resolution ??= outcome;
  });

  const first = proxyActivities<DisputeActivities>(boot);
  const plan = await first.loadDisputePlan(disputeId);
  if (plan.status !== 'open') return { status: plan.status };
  const a = proxyActivities<DisputeActivities>(policy(plan.activity));

  // Sin plazo inventado: la disputa espera la decisión del conector o de la persona que la resuelve.
  await condition(() => resolution !== null);
  const outcome = (await untilResolved({ run: () => a.settleDispute(disputeId, resolution ?? 'lost'), escalate: () => a.escalateDispute(disputeId, 'dispute_ledger_unknown'), slowMs: plan.activity.slowRetryMs })) as { status: 'won' | 'lost' | 'open' };
  return { status: outcome.status };
}
