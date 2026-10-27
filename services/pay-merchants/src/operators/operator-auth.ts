import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Credencial de la persona operadora del back-office. Quién actuó sale de acá (`sub`), nunca del cuerpo de la petición,
 * y los roles deciden qué puede hacer. Los roles son una PROPUESTA (Q-21/Q-23): confirmar con identidad.
 */
export type OperatorRole = 'merchant_operator' | 'kyc_reviewer' | 'legal_admin' | 'pricing_admin' | 'security_operator';

export interface OperatorIdentity {
  readonly sub: string;
  readonly roles: readonly string[];
}

/** Verifica la credencial (JWT) de un operador. La implementación real la da el servicio de identidad, que todavía no existe. */
export interface OperatorAuthenticator {
  /**
   * @param authorization - Valor de la cabecera `Authorization`.
   * @returns La identidad, o `null` si la credencial no es válida.
   */
  authenticate(authorization: string | undefined): Promise<OperatorIdentity | null>;
}

export const OPERATOR_AUTHENTICATOR = Symbol('OPERATOR_AUTHENTICATOR');

/** Por defecto NADIE es operador: sin verificador configurado, el back-office responde 401 (falla cerrado). */
export class DenyAllOperatorAuthenticator implements OperatorAuthenticator {
  async authenticate(): Promise<OperatorIdentity | null> {
    return null;
  }
}

const REQUIRED_ROLE = Symbol('pay:operator-role');
export const RequiredRole = (role: OperatorRole) => SetMetadata(REQUIRED_ROLE, role);

/** Petición con el operador ya identificado. */
export interface OperatorRequest {
  headers: Record<string, string | string[] | undefined>;
  operator?: OperatorIdentity;
}

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(OPERATOR_AUTHENTICATOR) private readonly authenticator: OperatorAuthenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const role = this.reflector.getAllAndOverride<OperatorRole | undefined>(REQUIRED_ROLE, [context.getHandler(), context.getClass()]);
    // Seguro por defecto: una ruta de operador sin rol declarado no se abre.
    if (!role) throw new ForbiddenException();
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const raw = request.headers.authorization;
    const identity = await this.authenticator.authenticate(Array.isArray(raw) ? raw[0] : raw);
    if (!identity || !identity.sub) throw new UnauthorizedException();
    if (!identity.roles.includes(role)) throw new ForbiddenException();
    request.operator = identity;
    return true;
  }
}
