/**
 * Tipos compartidos entre los workflows y las activities. Solo formas serializables a JSON: es lo que viaja por Temporal.
 * Los workflows importan SOLO tipos de este archivo (el bundle de un workflow no puede traer código con efectos).
 */

export type ChargeStatusName = 'pending' | 'authorized' | 'captured' | 'failed' | 'canceled' | 'expired';

export interface ChargeSignal {
  readonly status: ChargeStatusName;
  readonly failureCode?: string | undefined;
}

export interface ActivityPolicy {
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly initialMs: number;
  readonly maxMs: number;
}

export interface PaymentPlan {
  readonly status: string;
  readonly terminal: boolean;
  readonly method: 'qr' | 'card' | 'bank_transfer' | 'wallet';
  readonly hasCharge: boolean;
  readonly chargeCaptured: boolean;
  readonly expiresAtMs: number;
  readonly inquiryIntervalMs: number;
  readonly activity: ActivityPolicy;
}

/** Siguiente paso del workflow tras aplicar una señal del conector. */
export type NextStep = 'continue' | 'capture' | 'done';

export interface LedgerOutcome {
  readonly transferId?: string;
  readonly rejected?: 'insufficient_funds' | 'validation_failed';
}

export interface PaymentResult {
  readonly status: string;
}

export interface RefundPlan {
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly hasHold: boolean;
  readonly waitMs: number;
  readonly activity: ActivityPolicy;
}

export type RefundStep = 'succeeded' | 'failed' | 'pending';

export interface DisputePlan {
  readonly status: 'open' | 'won' | 'lost';
  readonly activity: ActivityPolicy;
}

export const SIGNALS = {
  connectorEvent: 'connectorEvent',
  wake: 'wake',
  refundEvent: 'refundEvent',
  resolveDispute: 'resolveDispute',
} as const;

export const workflowIds = {
  payment: (intentId: string) => `payment-${intentId}`,
  refund: (refundId: string) => `refund-${refundId}`,
  dispute: (disputeId: string) => `dispute-${disputeId}`,
};
