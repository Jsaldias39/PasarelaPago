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
 * Hash: SHA-256 de `modo | key_id | secreto`. Es un secreto aleatorio de alta entropía, no una contraseña: un KDF lento
 * (argon2id, scrypt) no agrega seguridad y costaría decenas de ms en CADA petición del borde. Se compara en tiempo constante.
 * **El modo y el id quedan atados al hash**: reescribir `sk_test_` a `sk_live_` (o cambiar el id) en un token robado o propio
 * cambia el hash y la verificación falla, aunque quien llama olvide comparar el modo. Aun así, el modo con el que se
 * enruta (sandbox o producción) debe salir SIEMPRE del registro guardado de la clave, nunca del token.
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

export interface ApiKeyParts {
  readonly mode: ApiKeyMode;
  readonly keyId: string;
  readonly secret: string;
}

/** Hash que se guarda: `sha256$<hex>` de `pay-api-key-v1|modo|key_id|secreto`. */
export function hashApiKey(parts: ApiKeyParts): string {
  return `sha256$${createHash('sha256').update(`pay-api-key-v1|${parts.mode}|${parts.keyId}|${parts.secret}`).digest('hex')}`;
}

/** Genera una clave nueva. */
export function generateApiKey(mode: ApiKeyMode): GeneratedApiKey {
  const body = randomBase32(16);
  const secret = randomBase32(32);
  const keyId = `key_${body}`;
  return { keyId, token: `sk_${mode}_${body}_${secret}`, mode, last4: secret.slice(-4), keyHash: hashApiKey({ mode, keyId, secret }) };
}

/** Descompone un token. Devuelve `null` si no tiene la forma exacta (nunca lanza ni revela por qué). */
export function parseApiKey(token: unknown): ParsedApiKey | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const match = TOKEN.exec(token);
  return match ? { mode: match[1] as ApiKeyMode, keyId: `key_${match[2]}`, secret: match[3] } : null;
}

/** Registro guardado de una clave (lo que `pay-edge` replica desde `api_key.created`). */
export interface StoredApiKey {
  readonly keyId: string;
  readonly mode: ApiKeyMode;
  readonly keyHash: string;
}

/**
 * ¿Este token corresponde a esta clave guardada? Compara en tiempo constante y exige que coincidan el id **y el modo**
 * guardados con los del token, además del hash (que ya los ata). Devuelve `false` ante cualquier forma inválida, sin lanzar.
 */
export function verifyApiKey(token: unknown, stored: StoredApiKey): boolean {
  const parsed = parseApiKey(token);
  if (parsed === null || parsed.keyId !== stored.keyId || parsed.mode !== stored.mode || !HASH.test(stored.keyHash)) return false;
  const a = Buffer.from(hashApiKey(parsed));
  const b = Buffer.from(stored.keyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
