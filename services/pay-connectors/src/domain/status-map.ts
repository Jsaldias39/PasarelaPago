import type { ProviderStatus } from './connector';

export type ChargeStatus = 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'expired' | 'canceled';

/** Estado público del cobro (contrato OpenAPI) a partir del estado del proveedor (vocabulario de los eventos). */
export function chargeStatusOf(provider: ProviderStatus, hasNextAction: boolean): ChargeStatus {
  switch (provider) {
    case 'pending':
      return hasNextAction ? 'requires_action' : 'pending';
    case 'authorized':
      return 'pending';
    case 'captured':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    case 'expired':
      return 'expired';
  }
}

/**
 * `failure_code` de los EVENTOS de transacción (AsyncAPI): `connector_unavailable`, `validation_failed`, `card_declined` o `internal_error`.
 * Cualquier otro código del proveedor sale como `validation_failed`.
 */
export function eventFailureCode(code: string | null | undefined): 'connector_unavailable' | 'validation_failed' | 'card_declined' | 'internal_error' | null {
  if (!code) return null;
  if (code === 'connector_unavailable' || code === 'internal_error' || code === 'card_declined') return code;
  return 'validation_failed';
}

/**
 * `failure_code` de los eventos de TRANSFERENCIA saliente: `rejected_by_bank`, `rejected_by_provider`, `connector_unavailable` o
 * `validation_failed`. Siempre presente cuando la transferencia falló (prueba de que NO se pagó).
 */
export function transferFailureCode(code: string | null | undefined): 'rejected_by_bank' | 'rejected_by_provider' | 'connector_unavailable' | 'validation_failed' {
  if (code === 'rejected_by_bank' || code === 'rejected_by_provider' || code === 'connector_unavailable' || code === 'validation_failed') return code;
  return 'rejected_by_provider';
}
