import { createHash } from 'node:crypto';

/**
 * Ids deterministas (P2.H1.M3 y H-TB1 del spike de TigerBeetle).
 *
 * El contrato NO recibe un id de 128 bits: el llamador manda `business_ref` + `attempt` y el servidor deriva el id de cada
 * transferencia. Un id rechazado por TigerBeetle no se puede reintentar (`id_already_failed`), por eso `attempt` forma parte
 * del id: el reintento tras un rechazo usa un id nuevo, y repetir el mismo (business_ref, attempt) da exactamente el mismo id.
 */

const MAX_U128 = (1n << 128n) - 1n;
const NAMESPACE = 'alovida-pay|ledger|v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function digest(...parts: (string | number)[]): Buffer {
  return createHash('sha256').update([NAMESPACE, ...parts].join('|')).digest();
}

/** Id de 128 bits para TigerBeetle: los primeros 16 bytes del hash. 0 y 2^128−1 están prohibidos. */
export function hash128(...parts: (string | number)[]): bigint {
  const value = BigInt(`0x${digest(...parts).subarray(0, 16).toString('hex')}`);
  return value === 0n || value === MAX_U128 ? 1n : value;
}

/** Id de una cuenta lógica. */
export function accountTbId(name: string): bigint {
  return hash128('account', name);
}

/** Id de la transferencia de la pata `legIndex` del asiento (business_ref, attempt). */
export function legTbId(businessRef: string, attempt: number, legIndex: number): bigint {
  return hash128('tx', businessRef, attempt, legIndex);
}

/** Id de la retención (primera fase) de (business_ref, attempt). */
export function holdTbId(businessRef: string, attempt: number): bigint {
  return hash128('hold', businessRef, attempt);
}

/** Id de la segunda fase (post/void) de una retención. Es único por retención: se resuelve una sola vez. */
export function holdResolveTbId(holdTb: bigint): bigint {
  return hash128('hold-resolve', holdTb.toString(16));
}

/** Hex de 32 caracteres (128 bits) para guardarlo en Postgres. */
export function toHex128(value: bigint): string {
  return value.toString(16).padStart(32, '0');
}

/** Identificador público estable (`tx_…`, `hd_…`, `tf_…`, `sl_…`): 20 caracteres base32 minúsculas del hash. */
export function publicId(prefix: 'tx' | 'hd' | 'tf' | 'sl', ...parts: (string | number)[]): string {
  const bytes = digest(prefix, ...parts);
  let out = '';
  for (let i = 0; i < 20; i += 1) out += ALPHABET[bytes[i] % 32];
  return `${prefix}_${out}`;
}
