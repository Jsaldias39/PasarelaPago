/**
 * Verificación de `wallet_authorization` (Q-20, abierta): token de un solo uso que el propio usuario emite dentro de su
 * sesión, atado a comercio, importe y moneda. Quién lo emite y su formato no están definidos: este puerto es la costura.
 */
export interface WalletAuthorizationClaims {
  /** Id único del token: sirve para garantizar el uso único aunque el emisor falle. */
  readonly authorizationId: string;
  /** Usuario cuya billetera se debita. Sale del token, NUNCA de la petición del comercio. */
  readonly userId: string;
}

export interface WalletAuthorizer {
  /**
   * Verifica el token contra `(comercio, importe, moneda)` y lo marca consumido en el emisor.
   * @returns Los claims, o `null` si el token no existe, está vencido, ya se usó o es de otro comercio/importe/moneda.
   */
  consume(input: { token: string; merchantId: string; amountMinor: number; currency: string }): Promise<WalletAuthorizationClaims | null>;
}

export const WALLET_AUTHORIZER = Symbol('WALLET_AUTHORIZER');

/**
 * Implementación de producción mientras Q-20 siga abierta: NIEGA todo. El saldo AloVida queda deshabilitado en lugar de
 * inventar un emisor de tokens (decisión conservadora registrada en DECISIONES-TOMADAS.md).
 */
export class DisabledWalletAuthorizer implements WalletAuthorizer {
  async consume(): Promise<null> {
    return null;
  }
}
