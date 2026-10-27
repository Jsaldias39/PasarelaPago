import { createHash } from 'node:crypto';

const hex = (seed: string, length: number) => createHash('sha256').update(seed).digest('hex').slice(0, length);

/**
 * Id del intento derivado de `(comercio, Idempotency-Key)`: si el proceso cae a mitad de la creación, el reintento con la misma
 * clave vuelve a derivar EL MISMO id y retoma, sin crear un segundo intento (P3.H1.M4, REQ-P3-1).
 */
export const intentIdFor = (merchantId: string, idempotencyKey: string): string => `pi_${hex(`intent:${merchantId}:${idempotencyKey}`, 24)}`;
export const refundIdFor = (merchantId: string, idempotencyKey: string): string => `re_${hex(`refund:${merchantId}:${idempotencyKey}`, 24)}`;
export const disputeIdFor = (paymentIntentId: string, openedKey: string): string => `dp_${hex(`dispute:${paymentIntentId}:${openedKey}`, 24)}`;

/** Referencias de negocio del ledger (`<recurso>:<operación>`), estables por operación (H-TB1). */
export const businessRef = {
  capture: (intentId: string) => `${intentId}:capture`,
  refund: (refundId: string) => `${refundId}:refund`,
  chargeback: (disputeId: string) => `${disputeId}:chargeback`,
};
