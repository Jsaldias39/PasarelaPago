/**
 * Costura hacia quien CUSTODIA la tarjeta. pay-vault no guarda números de tarjeta en su base ni inventa cifrado propio
 * (regla de la casa: nada de almacenamiento de tarjetas casero): delega en un backend, que será `hyperswitch-card-vault`
 * (spike P3.H3.M1, sin ejecutar) o los campos alojados del Banco Mercantil (D-17).
 *
 * Esta interfaz es el contrato que pay-vault consume. Hoy solo existe `FakeVaultBackend` (un DOBLE de pruebas).
 */
export interface CardMetadata {
  readonly brand: 'visa' | 'mastercard' | 'other';
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
  /** Huella opaca: sirve para detectar la misma tarjeta sin exponer el número. */
  readonly fingerprint: string;
}

export type CaptureState =
  | { readonly status: 'open' }
  | { readonly status: 'expired' | 'canceled' }
  | { readonly status: 'completed'; readonly token: string; readonly card: CardMetadata };

export interface CardData {
  readonly number: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly holderName: string | null;
}

export interface VaultBackend {
  /** Abre el formulario alojado de captura. Idempotente por `sessionId`. @returns la URL opaca del formulario. */
  openCapture(input: { sessionId: string; merchantId: string; saveCard: boolean; expiresAt: Date }): Promise<{ captureUrl: string }>;
  /** Estado de la captura; trae el token y los metadatos cuando el pagador terminó. */
  getCapture(sessionId: string): Promise<CaptureState>;
  /** Datos de tarjeta de un token, o `null` si no existe. Solo lo llama el endpoint `reveal`. */
  reveal(token: string): Promise<CardData | null>;
  /** Borra el dato. Idempotente. */
  delete(token: string): Promise<void>;
}

export const VAULT_BACKEND = Symbol('VAULT_BACKEND');
