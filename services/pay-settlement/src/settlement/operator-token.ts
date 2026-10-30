import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { OperatorIdentity, OperatorVerifier } from './ports';

/**
 * Verificador de la credencial de operador (`OperatorToken`, JWT RS256 emitido por el servicio de identidad de ALOVIDA).
 *
 * Solo se acepta `alg: RS256` con la clave pública configurada: un token con `alg: none`, HS256 (confusión de algoritmo) o cualquier
 * otro se rechaza sin mirar el resto. Se exigen firma, `iss`, `aud`, `exp` y `sub`; `nbf` e `iat`, si vienen, no pueden estar en el
 * futuro (con 30 s de tolerancia de reloj). Los roles salen del claim `roles` (lista de textos). Cualquier fallo devuelve `null`: el
 * llamador responde 403 sin decir por qué.
 */
export class JwtOperatorVerifier implements OperatorVerifier {
  private readonly key: KeyObject;

  constructor(
    publicKeyPem: string,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly now: () => number = () => Date.now(),
    private readonly skewSeconds = 30,
  ) {
    this.key = createPublicKey(publicKeyPem);
  }

  async verify(authorization: string | undefined): Promise<OperatorIdentity | null> {
    const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    if (!match) return null;
    const [, header64, payload64, signature64] = match;
    try {
      const header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
      if (header.alg !== 'RS256') return null;
      const valid = verify('RSA-SHA256', Buffer.from(`${header64}.${payload64}`), this.key, Buffer.from(signature64, 'base64url'));
      if (!valid) return null;
      const claims = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8')) as Record<string, unknown>;
      const nowSeconds = Math.floor(this.now() / 1000);
      if (claims.iss !== this.issuer) return null;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(this.audience)) return null;
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
