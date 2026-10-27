import { randomUUID } from 'node:crypto';
import { newCloudEvent } from '@pay/outbox';
import type { SettlementTestContext } from './app';

/** `ledger.transfer.posted` de un crédito a `merchant:{id}:pending`, tal como lo publica pay-ledger. */
export function transferPosted(merchant: string, at = new Date()) {
  return newCloudEvent({
    source: '/pay-ledger',
    type: 'ledger.transfer.posted',
    subject: `tf_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    merchantId: merchant,
    time: at,
    data: {
      transfer_id: `tf_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      ledger_ref: `pi_${randomUUID().replace(/-/g, '').slice(0, 14)}:capture`,
      attempt: 1,
      kind: 'capture',
      debit_account: 'connector:mock:clearing',
      credit_account: `merchant:${merchant}:pending`,
      amount_minor: 100,
      currency: 'BOB',
      posted_at: at.toISOString(),
    },
  });
}

/** El comercio entra al registro de pay-settlement por el camino real: el evento y su consumidor con inbox. */
export async function registerMerchant(ctx: SettlementTestContext, merchant: string): Promise<void> {
  const result = await ctx.consumers.handle(transferPosted(merchant));
  if (result !== 'processed') throw new Error(`no se registró el comercio: ${result}`);
}

let counter = 0;
export const ref = (prefix = 'pi') => `${prefix}_${(counter += 1).toString().padStart(4, '0')}${randomUUID().replace(/-/g, '').slice(0, 10)}:capture`;

export const BATCH_BODY = (cutoff: string, extra: object = {}) => ({ cutoff_date: cutoff, ...extra });

/** `fee_schedule.published` de pay-merchants (contrato `merchants-schedules.yaml`). */
export function feeSchedule(merchant: string, version: number, monthlyFeeMinor: number | undefined, over: { effectiveFrom?: string; effectiveTo?: string | null } = {}) {
  return newCloudEvent({
    source: '/pay-merchants',
    type: 'fee_schedule.published',
    subject: merchant,
    merchantId: merchant,
    data: {
      merchant_id: merchant,
      version,
      currency: 'BOB',
      effective_from: over.effectiveFrom ?? '2026-01-01T00:00:00.000Z',
      effective_to: over.effectiveTo === undefined ? null : over.effectiveTo,
      channels: [{ channel: 'qr', percent: '2.5', fixed_minor: 50 }],
      ...(monthlyFeeMinor !== undefined && { monthly_fee_minor: monthlyFeeMinor }),
    },
  });
}
