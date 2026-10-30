import { createHash } from 'node:crypto';
import type { PayMode } from './mode';

/**
 * Ids deterministas (P2.H1.M3 y H-TB1 del spike de TigerBeetle).
 *
 * El contrato NO recibe un id de 128 bits: el llamador manda `business_ref` + `attempt` y el servidor deriva el id de cada
 * transferencia. Un id rechazado por TigerBeetle no se puede reintentar (`id_already_failed`), por eso `attempt` forma parte
 * del id: el reintento tras un rechazo usa un id nuevo, y repetir el mismo (business_ref, attempt) da exactamente el mismo id.
 */

const MAX_U128 = (1n << 128n) - 1n;
const BASE_NAMESPACE = 'alovida-pay|ledger|v1';
let namespace = BASE_NAMESPACE;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function digest(...parts: (string | number)[]): Buffer {
  return createHash('sha256').update([namespace, ...parts].join('|')).digest();
}

/**
 * Aparta los ids de este proceso de los de otro despliegue en un TigerBeetle compartido (las cuentas de plataforma, como `platform:fees`, tienen
 * un nombre fijo y, sin esto, todos los procesos suman sobre las mismas). Pruebas de integración: una por proceso. En producción no se usa:
 * cambiarlo en un ledger con datos huérfana el dinero ya registrado (`LEDGER_ID_NAMESPACE`, ver ledger.config.ts).
 */
export function useIdNamespace(suffix: string): void {
  namespace = `${BASE_NAMESPACE}|${suffix}`;
}

/** Id de 128 bits para TigerBeetle: los primeros 16 bytes del hash. 0 y 2^128−1 están prohibidos. */
export function hash128(...parts: (string | number)[]): bigint {
  const value = BigInt(`0x${digest(...parts).subarray(0, 16).toString('hex')}`);
  return value === 0n || value === MAX_U128 ? 1n : value;
}

/**
 * Id de una cuenta lógica EN UN MODO (D-28). `merchant:X:pending` de `test` y de `live` son dos cuentas distintas de TigerBeetle: una
 * etiqueta sola no separaría los saldos, y un asiento no puede mezclar cuentas de dos modos porque ambas patas se resuelven con el mismo.
 */
export function accountTbId(mode: PayMode, name: string): bigint {
  return hash128('account', mode, name);
}

/** Id de la transferencia de la pata `legIndex` del asiento (business_ref, attempt). */
export function legTbId(mode: PayMode, businessRef: string, attempt: number, legIndex: number, part: 'main' | 'debt' = 'main'): bigint {
  // `debt` es la segunda mitad de un contracargo partido (ver `chargeback.ts`).
  return part === 'main' ? hash128('tx', mode, businessRef, attempt, legIndex) : hash128('tx', mode, businessRef, attempt, legIndex, part);
}

/** Id de la retención (primera fase) de (business_ref, attempt). */
export function holdTbId(mode: PayMode, businessRef: string, attempt: number): bigint {
  return hash128('hold', mode, businessRef, attempt);
}

/** Id de la segunda fase (post/void) de una retención. Es único por retención: se resuelve una sola vez. */
export function holdResolveTbId(holdTb: bigint): bigint {
  return hash128('hold-resolve', holdTb.toString(16));
}

/**
 * Marca de pertenencia de las transferencias de ESTE despliegue en `user_data_64` (nunca 0: en un filtro de TigerBeetle el 0 significa «cualquiera»).
 * Sale del espacio de nombres de ids, así que dos despliegues que comparten el cluster no se ven las transferencias (ver `reconciler.service.ts`).
 */
export function ownerTag(): bigint {
  const value = BigInt(`0x${digest('owner').subarray(0, 8).toString('hex')}`);
  return value === 0n ? 1n : value;
}

/** Modo de la operación en `user_data_32` (0 = sin marcar): permite pedirle a TigerBeetle solo las transferencias de un modo. */
export const MODE_CODE: Readonly<Record<PayMode, number>> = { test: 1, live: 2 };

/**
 * Grupo de una operación de negocio, en `user_data_128` de TODAS sus transferencias (las patas de un asiento, la retención y su post/void). El id de
 * una transferencia es un hash de (modo, business_ref, attempt, pata) y no se puede invertir: sin esta marca, una transferencia que TigerBeetle
 * aplicó y Postgres no llegó a registrar no se puede atribuir a ninguna operación ni emparejar con su fila.
 */
export function txGroupId(mode: PayMode, businessRef: string, attempt: number): bigint {
  return hash128('group', 'tx', mode, businessRef, attempt);
}

/** Igual que `txGroupId`, para la familia de la retención (`pending` + `post`/`void`). */
export function holdGroupId(mode: PayMode, businessRef: string, attempt: number): bigint {
  return hash128('group', 'hold', mode, businessRef, attempt);
}

/** Hex de 32 caracteres (128 bits) para guardarlo en Postgres. */
export function toHex128(value: bigint): string {
  return value.toString(16).padStart(32, '0');
}

/** Identificador público estable (`tx_…`, `hd_…`, `tf_…`, `sl_…`): 20 caracteres base32 minúsculas del hash. `tx_` y `hd_` incluyen el modo en `parts`. */
export function publicId(prefix: 'tx' | 'hd' | 'tf' | 'sl', ...parts: (string | number)[]): string {
  const bytes = digest(prefix, ...parts);
  let out = '';
  for (let i = 0; i < 20; i += 1) out += ALPHABET[bytes[i] % 32];
  return `${prefix}_${out}`;
}
