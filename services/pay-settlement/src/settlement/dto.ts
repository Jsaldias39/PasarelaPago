export type Rail = 'bank_transfer' | 'acquirer_settlement';
export type PayoutStatus = 'pending' | 'in_transit' | 'paid' | 'failed';
export type PayoutReason = 'weekly_cut' | 'mandate_obligation' | 'mandate_commission' | 'manual';

import type { PayMode } from './mode';

export interface PayoutRow {
  id: string;
  mode: PayMode;
  merchant_id: string;
  amount_minor: string;
  currency: 'BOB';
  rail: Rail;
  simulated: boolean;
  reason: PayoutReason;
  status: PayoutStatus;
  step: 'created' | 'held' | 'sent' | 'resolved';
  hold_id: string | null;
  hold_business_ref: string;
  rail_reference: string | null;
  batch_id: string | null;
  requested_by: string;
  failure_code: string | null;
  period_from: Date;
  period_to: Date;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export const PAYOUT_COLUMNS =
  'id, mode, merchant_id, amount_minor, currency, rail, simulated, reason, status, step, hold_id, hold_business_ref, rail_reference, batch_id, requested_by, failure_code, period_from, period_to, created_at, updated_at, paid_at';

/** `Payout` de `internal-settlement-v1.yaml`. */
export function payoutDto(row: PayoutRow) {
  return {
    id: row.id,
    object: 'payout' as const,
    merchant_id: row.merchant_id,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    rail: row.rail,
    simulated: row.simulated,
    status: row.status,
    hold_id: row.hold_id,
    batch_id: row.batch_id,
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
    paid_at: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

/** `Payout` de `public-v1.yaml`: lo que ve el comercio (sin riel, ni retención, ni lote). */
export function publicPayoutDto(row: PayoutRow) {
  return {
    id: row.id,
    object: 'payout' as const,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    failure_code: row.failure_code,
    period_from: row.period_from.toISOString(),
    period_to: row.period_to.toISOString(),
    created_at: row.created_at.toISOString(),
  };
}

export interface BatchRow {
  id: string;
  mode: PayMode;
  cutoff_date: string;
  release_days: number;
  release_before: Date;
  period_from: Date;
  status: 'running' | 'completed' | 'failed';
  merchants_count: number;
  released_minor: string;
  payouts_count: number;
  failed_count: number;
  created_at: Date;
  completed_at: Date | null;
}

export const BATCH_COLUMNS =
  "id, mode, to_char(cutoff_date, 'YYYY-MM-DD') AS cutoff_date, release_days, release_before, period_from, status, merchants_count, released_minor, payouts_count, failed_count, created_at, completed_at";

export function batchDto(row: BatchRow) {
  return {
    id: row.id,
    object: 'settlement_batch' as const,
    cutoff_date: row.cutoff_date,
    release_before: row.release_before.toISOString(),
    status: row.status,
    merchants_count: row.merchants_count,
    released_minor: Number(row.released_minor),
    payouts_count: row.payouts_count,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export interface RunRow {
  id: string;
  mode: PayMode;
  connector: string;
  period_from: Date;
  period_to: Date;
  source: 'api' | 'csv' | 'camt053';
  status: 'running' | 'completed' | 'failed';
  matched_count: number;
  exception_count: number;
  ignored_count: number;
  failure_code: string | null;
  requested_by: string;
  created_at: Date;
  completed_at: Date | null;
}

export const RUN_COLUMNS = 'id, mode, connector, period_from, period_to, source, status, matched_count, exception_count, ignored_count, failure_code, requested_by, created_at, completed_at';

export function runDto(row: RunRow) {
  return {
    id: row.id,
    object: 'reconciliation_run' as const,
    connector: row.connector,
    period_from: row.period_from.toISOString(),
    period_to: row.period_to.toISOString(),
    status: row.status,
    matched_count: row.matched_count,
    exception_count: row.exception_count,
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export interface ExceptionRow {
  id: string;
  mode: PayMode;
  run_id: string;
  connector: string;
  kind: 'missing_in_ledger' | 'missing_in_statement' | 'amount_mismatch' | 'duplicate_in_statement' | 'unknown_reference';
  provider_reference: string | null;
  business_ref: string | null;
  statement_amount_minor: string | null;
  ledger_amount_minor: string | null;
  difference_minor: string;
  statement_line_ref: string;
  merchant_id: string | null;
  payment_intent_id: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: Date;
}

export const EXCEPTION_COLUMNS =
  'id, mode, run_id, connector, kind, provider_reference, business_ref, statement_amount_minor, ledger_amount_minor, difference_minor, statement_line_ref, merchant_id, payment_intent_id, status, resolved_by, resolution_note, created_at';

export function exceptionDto(row: ExceptionRow) {
  return {
    id: row.id,
    object: 'reconciliation_exception' as const,
    run_id: row.run_id,
    kind: row.kind,
    provider_reference: row.provider_reference,
    business_ref: row.business_ref,
    statement_amount_minor: row.statement_amount_minor === null ? null : Number(row.statement_amount_minor),
    ledger_amount_minor: row.ledger_amount_minor === null ? null : Number(row.ledger_amount_minor),
    status: row.status,
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
    created_at: row.created_at.toISOString(),
  };
}
