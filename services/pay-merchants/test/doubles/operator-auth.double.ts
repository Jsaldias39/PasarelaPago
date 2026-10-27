import type { OperatorAuthenticator, OperatorIdentity } from '../../src/operators/operator-auth';

/**
 * [DOBLE] del servicio de identidad de operadores, que todavía no existe (Q-21, Q-23).
 * Entiende `Bearer op-<nombre>` y nada más: no verifica firmas JWT ni vencimientos. No es el verificador real.
 */
export const OPERATORS: Record<string, OperatorIdentity> = {
  'op-admin': { sub: 'operator_admin_01', roles: ['merchant_operator', 'kyc_reviewer', 'legal_admin', 'pricing_admin', 'security_operator'] },
  'op-merchant': { sub: 'operator_merchant_01', roles: ['merchant_operator'] },
  'op-kyc': { sub: 'operator_kyc_01', roles: ['kyc_reviewer'] },
  'op-legal': { sub: 'operator_legal_01', roles: ['legal_admin'] },
  'op-pricing': { sub: 'operator_pricing_01', roles: ['pricing_admin'] },
  'op-security': { sub: 'operator_security_01', roles: ['security_operator'] },
  'op-norole': { sub: 'operator_norole_01', roles: [] },
};

export class OperatorAuthenticatorDouble implements OperatorAuthenticator {
  async authenticate(authorization: string | undefined): Promise<OperatorIdentity | null> {
    const match = /^Bearer (op-[a-z]+)$/.exec(authorization ?? '');
    return match ? (OPERATORS[match[1]] ?? null) : null;
  }
}

export const bearer = (name: keyof typeof OPERATORS | string): string => `Bearer ${name}`;
