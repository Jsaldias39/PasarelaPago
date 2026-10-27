import type { OperatorAuthenticator, OperatorIdentity } from '../../src/operators/operator-auth';

/**
 * [DOBLE] del servicio de identidad de operadores, que todavía no existe (Q-21, Q-23).
 * Entiende `Bearer op-<nombre>` y nada más: no verifica firmas JWT ni vencimientos. No es el verificador real.
 */
export const OPERATORS: Record<string, OperatorIdentity> = {
  'op-risk': { sub: 'operator_risk_01', roles: ['risk_admin'] },
  'op-norole': { sub: 'operator_norole_01', roles: [] },
  'op-other': { sub: 'operator_other_01', roles: ['merchant_operator'] },
};

export class OperatorAuthenticatorDouble implements OperatorAuthenticator {
  async authenticate(authorization: string | undefined): Promise<OperatorIdentity | null> {
    const match = /^Bearer (op-[a-z]+)$/.exec(authorization ?? '');
    return match ? (OPERATORS[match[1]] ?? null) : null;
  }
}

export const bearer = (name: keyof typeof OPERATORS | string): string => `Bearer ${name}`;
