import { randomUUID } from 'node:crypto';
import type { WalletAuthorizationClaims, WalletAuthorizer } from '../../src/clients/wallet-authorizer';

interface Issued {
  readonly authorizationId: string;
  readonly userId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt: number;
  used: boolean;
}

/**
 * [DOBLE] del emisor de `wallet_authorization` (Q-20, abierta). Implementa el puerto `WalletAuthorizer`: token de un solo uso,
 * atado a comercio, importe y moneda, con vencimiento. No es el emisor real (todavía no se sabe quién lo será).
 */
export class WalletAuthorizerDouble implements WalletAuthorizer {
  private readonly tokens = new Map<string, Issued>();
  consumeCalls = 0;

  issue(input: { userId: string; merchantId: string; amountMinor: number; currency?: string; ttlMs?: number }): string {
    const token = `wa_${randomUUID().replace(/-/g, '')}`;
    this.tokens.set(token, {
      authorizationId: `wauth_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      userId: input.userId,
      merchantId: input.merchantId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? 'BOB',
      expiresAt: Date.now() + (input.ttlMs ?? 5 * 60_000),
      used: false,
    });
    return token;
  }

  async consume(input: { token: string; merchantId: string; amountMinor: number; currency: string }): Promise<WalletAuthorizationClaims | null> {
    this.consumeCalls += 1;
    const t = this.tokens.get(input.token);
    if (!t || t.used || t.expiresAt < Date.now() || t.merchantId !== input.merchantId || t.amountMinor !== input.amountMinor || t.currency !== input.currency) return null;
    t.used = true;
    return { authorizationId: t.authorizationId, userId: t.userId };
  }
}
