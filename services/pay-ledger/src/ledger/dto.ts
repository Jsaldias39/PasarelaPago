import { toSafeNumber } from '@pay/money';
import type { Account } from 'tigerbeetle-node';
import type { AccountInfo } from './accounts';
import type { LegCode } from './tb-engine';

/** Pata como viaja por HTTP y como se guarda (jsonb). */
export interface LegDto {
  debit_account: string;
  credit_account: string;
  amount_minor: number;
  code: LegCode;
}

export interface TransactionDto {
  id: string;
  object: 'transaction';
  result: 'created' | 'exists';
  business_ref: string;
  attempt: number;
  status: 'posted' | 'rejected';
  reject_code: 'insufficient_funds' | 'validation_failed' | null;
  currency: 'BOB';
  legs: LegDto[];
  created_at: string;
}

export interface HoldDto {
  id: string;
  object: 'hold';
  result: 'created' | 'exists';
  business_ref: string;
  attempt: number;
  status: 'pending' | 'posted' | 'voided' | 'expired';
  debit_account: string;
  credit_account: string;
  amount_minor: number;
  posted_amount_minor: number | null;
  currency: 'BOB';
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
}

export interface BalanceDto {
  object: 'balance';
  account: string;
  currency: 'BOB';
  balance_minor: number;
  nature: 'credit' | 'debit';
  pending_debits_minor: number;
  pending_credits_minor: number;
  as_of: string;
}

/**
 * Saldo de una cuenta a partir de los acumuladores de TigerBeetle: `créditos − débitos − débitos pendientes`.
 * Una cuenta con invariante de no-negativo nunca da menos de 0; las demás pueden ser deudoras, y entonces se informa el
 * valor absoluto con `nature: 'debit'` (el contrato no admite importes negativos).
 */
export function balanceOf(info: AccountInfo, account: Account | undefined, asOf: Date): BalanceDto {
  const credits = account?.credits_posted ?? 0n;
  const debits = account?.debits_posted ?? 0n;
  const pendingDebits = account?.debits_pending ?? 0n;
  const net = credits - debits - pendingDebits;
  return {
    object: 'balance',
    account: info.name,
    currency: 'BOB',
    balance_minor: toSafeNumber(net < 0n ? -net : net),
    nature: net >= 0n ? 'credit' : 'debit',
    pending_debits_minor: toSafeNumber(pendingDebits),
    pending_credits_minor: toSafeNumber(account?.credits_pending ?? 0n),
    as_of: asOf.toISOString(),
  };
}
