import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Claves de API del comercio (D-27, resuelve Q-17).
 *
 * Formato: `sk_<mode>_<keyBody>_<secret>` donde
 *  - `mode` es `test` o `live` (las `test` solo operan en sandbox);
 *  - `keyBody` son 16 caracteres `[a-z2-7]`; el id público de la clave es `key_<keyBody>` (contrato: `^key_[a-z0-9]{10,40}$`);
 *  - `secret` son 32 caracteres `[a-z2-7]` (160 bits de azar).
 * El `keyBody` va **dentro** del token para que `pay-edge` encuentre la clave por id y compare un solo hash, sin recorrerlas todas.
 *
 * Hash: SHA-256 del secreto. Es un secreto aleatorio de alta entropía, no una contraseña: un KDF lento (argon2id, scrypt) no
 * agrega seguridad y costaría decenas de ms en CADA petición del borde. Se compara en tiempo constante.
 * El secreto se muestra una sola vez; solo se guarda `key_hash`.
 */

export type ApiKeyMode = 'test' | 'live';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN = /^sk_(test|live)_([a-z2-7]{16})_([a-z2-7]{32})$/;
const HASH = /^sha256\$[0-9a-f]{64}$/;

function randomBase32(length: number): string {
  // rechazo para evitar sesgo: 256 es múltiplo de 32, así que `byte % 32` es uniforme.
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return out;
}

export interface GeneratedApiKey {
  /** Id público (`key_…`). */
  readonly keyId: string;
  /** Token completo: SE MUESTRA UNA SOLA VEZ. */
  readonly token: string;
  readonly mode: ApiKeyMode;
  /** Últimos 4 caracteres del secreto, para que el comercio reconozca la clave. */
  readonly last4: string;
  /** Lo único que se persiste y se publica en `api_key.created`: `sha256$<hex>`. */
  readonly keyHash: string;
}

export interface ParsedApiKey {
  readonly mode: ApiKeyMode;
  readonly keyId: string;
  readonly secret: string;
}

/** Hash del secreto, en la forma que se guarda: `sha256$<hex>`. */
export function hashSecret(secret: string): string {
  return `sha256$${createHash('sha256').update(secret).digest('hex')}`;
}

/** Genera una clave nueva. */
export function generateApiKey(mode: ApiKeyMode): GeneratedApiKey {
  const body = randomBase32(16);
  const secret = randomBase32(32);
  return { keyId: `key_${body}`, token: `sk_${mode}_${body}_${secret}`, mode, last4: secret.slice(-4), keyHash: hashSecret(secret) };
}

/** Descompone un token. Devuelve `null` si no tiene la forma exacta (nunca lanza ni revela por qué). */
export function parseApiKey(token: unknown): ParsedApiKey | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const match = TOKEN.exec(token);
  return match ? { mode: match[1] as ApiKeyMode, keyId: `key_${match[2]}`, secret: match[3] } : null;
}

/**
 * Compara el secreto recibido con el hash guardado, en tiempo constante.
 *
 * @returns `false` ante un hash mal formado en vez de lanzar.
 */
export function verifySecret(secret: string, storedHash: string): boolean {
  if (!HASH.test(storedHash)) return false;
  const a = Buffer.from(hashSecret(secret));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Atajo: ¿este token corresponde a esta clave guardada? */
export function verifyApiKey(token: unknown, stored: { keyId: string; keyHash: string }): boolean {
  const parsed = parseApiKey(token);
  return parsed !== null && parsed.keyId === stored.keyId && verifySecret(parsed.secret, stored.keyHash);
}
