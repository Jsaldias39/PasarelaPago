import { processOnce, type CloudEvent } from '@pay/outbox';
import type { Deps } from '../deps';
import { decideConnectorEvent, isTerminal } from '../domain/state';
import type { ChannelFee } from '../domain/quote';
import type { PaymentOrchestrator } from '../payments/orchestrator';
import { contradictionsRepo } from '../persistence/contradictions.repo';
import { intentsRepo } from '../persistence/intents.repo';
import { refundsRepo } from '../persistence/refunds.repo';
import { replicasRepo, type MerchantStatus } from '../persistence/replicas.repo';
import { chargeNameOf } from '../temporal/activities';

/** Nombres de inbox: `x-inbox-consumer` de los AsyncAPI. Un consumidor distinto por tipo de evento. */
export const INBOX = {
  connectorStatus: 'pay-payments.connector.transaction.status_changed',
  merchant: 'pay-payments.merchant',
  feeSchedule: 'pay-payments.fee_schedule.published',
} as const;

/** El evento no se puede procesar nunca (forma inválida): se descarta con `term`, no se reintenta en bucle. */
export class PoisonEventError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PoisonEventError';
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') throw new PoisonEventError(`campo inválido: ${name}`);
  return v;
};

/** Consumidores de pay-payments. Cada uno procesa UNA vez por `event.id` (inbox) y deja su efecto en la misma transacción. */
export class EventHandlers {
  constructor(
    private readonly deps: Deps,
    private readonly orchestrator: PaymentOrchestrator,
  ) {}

  /**
   * `connector.transaction.status_changed`. Para un cargo:
   *  - intento terminal ⇒ no hay workflow: se decide con la máquina y una contradicción (dinero cobrado para un intento ya
   *    cerrado sin éxito) queda registrada para conciliación, sin pisar el estado;
   *  - intento vivo ⇒ se SEÑALA al workflow, que decide y aplica. La señal sale antes del COMMIT del inbox: si el commit falla
   *    se reentrega y la señal se repite, y aplicar la misma señal dos veces no cambia nada.
   */
  async connectorStatusChanged(event: CloudEvent): Promise<'processed' | 'duplicate'> {
    const data = event.data;
    if (!isObj(data)) throw new PoisonEventError('data ausente');
    const kind = str(data.kind, 'kind');
    const intentId = str(data.payment_intent_id, 'payment_intent_id');
    const status = chargeNameOf(str(data.status, 'status'));
    const failureCode = typeof data.failure_code === 'string' ? data.failure_code : undefined;

    return processOnce(this.deps.pool, INBOX.connectorStatus, event.id, async (client) => {
      if (kind === 'refund') {
        const refundId = str(data.refund_id, 'refund_id');
        const refund = await refundsRepo.byId(client, refundId);
        if (!refund || refund.status !== 'pending') return;
        if (status !== 'captured' && status !== 'failed') return;
        const delivered = await this.orchestrator.signalRefund(refundId, { status: status === 'captured' ? 'succeeded' : 'failed', ...(failureCode ? { failureCode } : {}) });
        if (delivered === 'no_workflow') throw new Error(`El reembolso ${refundId} está pendiente y no tiene workflow en curso`);
        return;
      }
      if (kind !== 'charge') throw new PoisonEventError('kind desconocido');

      const intent = await intentsRepo.byId(client, intentId, { forUpdate: true });
      if (!intent) return; // un cobro que este servicio no conoce: no es nuestro
      if (isTerminal(intent.status)) {
        const decision = decideConnectorEvent({ intentStatus: intent.status, chargeStatus: intent.chargeStatus, incoming: status });
        if (decision.decision === 'contradiccion') {
          await contradictionsRepo.record(client, { paymentIntentId: intentId, currentStatus: intent.status, incomingStatus: status, sourceEventId: event.id, kind: 'status_conflict', reason: decision.reason });
        }
        return;
      }
      const delivered = await this.orchestrator.signalCharge(intentId, { status, ...(failureCode ? { failureCode } : {}) });
      if (delivered === 'no_workflow') throw new Error(`El cobro ${intentId} está vivo y no tiene workflow en curso`);
    });
  }

  /** `merchant.created|activated|suspended|closed` ⇒ réplica local del estado del comercio. Un evento atrasado no pisa a uno más nuevo. */
  async merchantChanged(event: CloudEvent): Promise<'processed' | 'duplicate'> {
    const status = ({ 'merchant.created': 'pending', 'merchant.activated': 'active', 'merchant.suspended': 'suspended', 'merchant.closed': 'closed' } as Record<string, MerchantStatus>)[event.type];
    if (!status) throw new PoisonEventError(`tipo de evento no admitido: ${event.type}`);
    const data = event.data;
    if (!isObj(data)) throw new PoisonEventError('data ausente');
    const merchantId = str(data.merchant_id, 'merchant_id');
    const occurredAt = new Date(event.time);
    if (Number.isNaN(occurredAt.getTime())) throw new PoisonEventError('time inválido');
    // `legal_name` (D-33) es opcional en merchant.created|activated, 1..300: lo que no cumple se ignora (sin él el riesgo responde `review` ⇒
    // risk_denied, fail-closed). Nunca se trunca ni se inventa: un nombre cortado cribaría otra cosa.
    const trimmed = typeof data.legal_name === 'string' ? data.legal_name.trim() : '';
    const legalName = trimmed.length >= 1 && trimmed.length <= 300 ? trimmed : undefined;
    return processOnce(this.deps.pool, INBOX.merchant, event.id, async (client) => {
      await replicasRepo.upsertMerchantStatus(client, merchantId, status, occurredAt, legalName);
    });
  }

  /** `fee_schedule.published` ⇒ réplica de la tarifa, versionada: la cotización del cobro usa la vigente al crearlo. */
  async feeSchedulePublished(event: CloudEvent): Promise<'processed' | 'duplicate'> {
    const data = event.data;
    if (!isObj(data)) throw new PoisonEventError('data ausente');
    const merchantId = str(data.merchant_id, 'merchant_id');
    const version = data.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new PoisonEventError('version inválida');
    if (data.currency !== 'BOB') throw new PoisonEventError('moneda no admitida');
    const from = new Date(str(data.effective_from, 'effective_from'));
    const to = data.effective_to === null || data.effective_to === undefined ? null : new Date(str(data.effective_to, 'effective_to'));
    if (Number.isNaN(from.getTime()) || (to && Number.isNaN(to.getTime()))) throw new PoisonEventError('vigencia inválida');
    if (!Array.isArray(data.channels)) throw new PoisonEventError('channels ausente');
    const channels: ChannelFee[] = data.channels.map((c: unknown) => {
      if (!isObj(c)) throw new PoisonEventError('canal inválido');
      const num = (v: unknown, name: string): number | undefined => {
        if (v === undefined || v === null) return undefined;
        if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new PoisonEventError(`${name} inválido`);
        return v;
      };
      const fixed = num(c.fixed_minor, 'fixed_minor');
      const min = num(c.min_minor, 'min_minor');
      const cap = num(c.cap_minor, 'cap_minor');
      return { channel: str(c.channel, 'channel'), percent: str(c.percent, 'percent'), ...(fixed !== undefined ? { fixed_minor: fixed } : {}), ...(min !== undefined ? { min_minor: min } : {}), ...(cap !== undefined ? { cap_minor: cap } : {}) };
    });
    return processOnce(this.deps.pool, INBOX.feeSchedule, event.id, async (client) => {
      await replicasRepo.upsertFeeSchedule(client, { merchantId, version, currency: 'BOB', channels, effectiveFrom: from, effectiveTo: to });
    });
  }
}
