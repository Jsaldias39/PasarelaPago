import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const NAMESPACE = 'alovida-pay|settlement|v1';

export type IdPrefix = 'po' | 'sb' | 'rr' | 'rx' | 'cg' | 'rl';

function base32(bytes: Uint8Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** Id estable: el mismo `(prefix, parts)` da siempre el mismo id. Sirve para que repetir un paso no cree otro registro. */
export function stableId(prefix: IdPrefix, ...parts: (string | number)[]): string {
  const digest = createHash('sha256')
    .update([NAMESPACE, prefix, ...parts].join('|'))
    .digest();
  return `${prefix}_${base32(digest, 20)}`;
}

/** Id nuevo, no derivable de nada. */
export function randomId(prefix: IdPrefix): string {
  return `${prefix}_${base32(randomBytes(20), 20)}`;
}

/** `business_ref` del ledger de una operación de este servicio: `<id>:<operación>`. */
export const businessRef = (id: string, operation: 'payout' | 'release' | 'collect'): string => `${id}:${operation}`;
