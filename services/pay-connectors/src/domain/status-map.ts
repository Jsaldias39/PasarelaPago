import type { ConnectorCode, ProviderStatus } from './connector';

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
 * Código del conector en los EVENTOS (AsyncAPI). Difiere del de la API en `mock` ↔ `simulator`: inconsistencia entre los dos
 * contratos, registrada en docs/trabajo/ola-1/P4/PROPUESTAS.md; hasta que se unifiquen se traduce acá.
 */
export function eventConnectorCode(code: ConnectorCode): 'simulator' | 'mercantil_qr' | 'mercantil_card' | 'bank_transfer' {
  return code === 'mock' ? 'simulator' : code;
}

/**
 * `failure_code` de los EVENTOS: solo admite `connector_unavailable`, `validation_failed` o `internal_error`. Un rechazo del
 * proveedor (tarjeta declinada, etc.) se informa como `validation_failed` hasta que el catálogo tenga un código propio (PROPUESTAS.md).
 */
export function eventFailureCode(code: string | null | undefined): 'connector_unavailable' | 'validation_failed' | 'internal_error' | null {
  if (!code) return null;
  if (code === 'connector_unavailable' || code === 'internal_error') return code;
  return 'validation_failed';
}
