import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { PayMode } from '../config';
import type { OperatorAuthenticator, OperatorIdentity } from './operator-auth';

/**
 * Verificador de la credencial de operador (`OperatorToken`): JWT RS256 emitido por el servicio de identidad, con el mismo formato que
 * usa `pay-settlement` (P2-D22): solo `alg: RS256` con la clave pública configurada (`alg: none`, HS256 y cualquier otro se rechazan
 * sin mirar el resto); se exigen firma, `iss`, `aud`, `exp` y `sub`; `nbf`/`iat`, si vienen, no pueden estar en el futuro (30 s de
 * tolerancia). Los roles salen del claim `roles`.
 *
 * Además la credencial está ATADA AL MODO: el claim `mode` (`sandbox`|`live`) es obligatorio y tiene que ser el de este despliegue. Una
 * credencial emitida para sandbox no sirve en `live`, ni al revés. Cualquier fallo devuelve `null` (el guard responde 401 sin decir por qué).
 */
export class JwtOperatorAuthenticator implements OperatorAuthenticator {
  private readonly key: KeyObject;

  constructor(
    publicKeyPem: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly mode: PayMode,
    private readonly now: () => number = () => Date.now(),
    private readonly skewSeconds = 30,
  ) {
    this.key = createPublicKey(publicKeyPem);
  }

  async authenticate(authorization: string | undefined): Promise<OperatorIdentity | null> {
    const match = /^Bearer ([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{1,2048})$/.exec(authorization ?? '');
    if (!match) return null;
    const [, header64, payload64, signature64] = match;
    try {
      const header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8')) as { alg?: unknown };
      if (header.alg !== 'RS256') return null;
      if (!verify('RSA-SHA256', Buffer.from(`${header64}.${payload64}`), this.key, Buffer.from(signature64, 'base64url'))) return null;
      const claims = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8')) as Record<string, unknown>;
      const nowSeconds = Math.floor(this.now() / 1000);
      if (claims.iss !== this.issuer) return null;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(this.audience)) return null;
      if (claims.mode !== this.mode) return null;
      if (typeof claims.exp !== 'number' || claims.exp + this.skewSeconds <= nowSeconds) return null;
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - this.skewSeconds > nowSeconds)) return null;
      if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - this.skewSeconds > nowSeconds)) return null;
      if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 100) return null;
      const roles = claims.roles;
      if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) return null;
      return { sub: claims.sub, roles: roles as string[] };
    } catch {
      return null;
    }
  }
}
