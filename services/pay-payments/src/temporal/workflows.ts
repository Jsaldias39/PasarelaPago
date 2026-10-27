/**
 * Workflows de pay-payments. Código DETERMINISTA: nada de I/O, `Date.now()` es el reloj del workflow, y todo efecto va en
 * una activity (idempotente). Solo importa `@temporalio/workflow` y tipos: el bundle del worker no puede traer más.
 */
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
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

export async function PaymentWorkflow(input: { intentId: string }): Promise<PaymentResult> {
  const { intentId } = input;
  const inbox: ChargeSignal[] = [];
  let woken = false;
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
  const finalStatus = async (): Promise<PaymentResult> => ({ status: (await a.loadPaymentPlan(intentId)).status });

  let phase: 'risk' | 'charge' | 'wait' | 'ledger' = 'risk';
  try {
    const risk = await a.assessRisk(intentId);
    if (!risk.proceed) return await finalStatus();

    let step: NextStep = 'capture';
    if (plan.method !== 'wallet') {
      phase = 'charge';
      const charge = await a.createCharge(intentId);
      if (charge.state === 'settled') return await finalStatus();
      step = charge.state === 'captured' ? 'capture' : 'continue';
    }

    phase = 'wait';
    while (step === 'continue') {
      const remaining = plan.expiresAtMs - Date.now();
      if (remaining <= 0) {
        step = await a.resolveExpiry(intentId);
        break;
      }
      await condition(() => inbox.length > 0 || woken, Math.min(plan.inquiryIntervalMs, remaining));
      const signal = inbox.shift();
      if (signal) {
        step = await a.applyChargeSignal(intentId, signal);
      } else if (woken) {
        woken = false;
        if ((await a.loadPaymentPlan(intentId)).terminal) return await finalStatus();
      } else if (plan.expiresAtMs - Date.now() > 0) {
        // Nadie avisó: se pregunta al conector (un evento perdido no puede dejar el cobro colgado, REQ-P3-7).
        try {
          const state = await a.inquireCharge(intentId);
          if (state.status !== 'pending') step = await a.applyChargeSignal(intentId, state);
        } catch {
          // El conector no contestó: se vuelve a preguntar en el próximo ciclo; el vencimiento sigue corriendo.
        }
      }
    }
    if (step === 'done') return await finalStatus();

    phase = 'ledger';
    const ledger = await a.recordLedger(intentId);
    if (ledger.transferId) return await a.completeIntent(intentId, { transferId: ledger.transferId });
    // El ledger rechazó el asiento: el cobro no se completa y, si el conector ya cobró, se le devuelve el dinero al pagador.
    if (plan.method !== 'wallet') await a.compensateCapture(intentId);
    return await a.completeIntent(intentId, { failureCode: ledger.rejected ?? 'ledger_unavailable' });
  } catch {
    // Se agotaron los reintentos de una activity (o falló algo no previsto): el cobro termina en UN estado, nunca colgado.
    if (phase === 'ledger' && plan.method !== 'wallet') await a.compensateCapture(intentId);
    const code = phase === 'charge' ? 'connector_unavailable' : phase === 'ledger' ? 'ledger_unavailable' : 'internal_error';
    return await a.settleFailed(intentId, code);
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

  let connectorTouched = false;
  try {
    const hold = await a.holdRefund(refundId);
    if (hold.rejected) {
      await a.failRefund(refundId, hold.rejected, false);
      return { status: 'failed' };
    }
    connectorTouched = true;
    let result = await a.refundAtConnector(refundId);
    if (result.status === 'pending') {
      const arrived = await condition(() => events.length > 0, plan.waitMs);
      const event = events[0];
      if (!arrived || !event) {
        // No se sabe si el conector devolvió el dinero: NO se libera la retención ni se da por fallido; queda para conciliación.
        await a.flagRefundPending(refundId);
        return { status: 'pending' };
      }
      result = { status: event.status, ...(event.failureCode ? { failureCode: event.failureCode } : {}) };
    }
    if (result.status === 'succeeded') {
      await a.finishRefund(refundId);
      return { status: 'succeeded' };
    }
    await a.failRefund(refundId, result.failureCode ?? 'connector_unavailable', true);
    return { status: 'failed' };
  } catch {
    if (connectorTouched) {
      // El conector no contestó tras los reintentos: el resultado real es desconocido. Se anula la retención para no congelar
      // dinero del comercio y se deja registrado para que una persona concilie.
      await a.flagRefundOutcomeUnknown(refundId);
    }
    await a.failRefund(refundId, connectorTouched ? 'connector_unavailable' : 'ledger_unavailable', true);
    return { status: 'failed' };
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
  const outcome = await a.settleDispute(disputeId, resolution ?? 'lost');
  return { status: outcome.status };
}
