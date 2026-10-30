import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Id público con prefijo y 16 caracteres `[a-z2-7]` (80 bits de azar; 256 es múltiplo de 32, sin sesgo). */
export function newId(prefix: string): string {
  let body = '';
  for (const byte of randomBytes(16)) body += ALPHABET[byte % 32];
  return `${prefix}_${body}`;
}

/** Referencia de pago para el payload: `PQ` + 14 caracteres en mayúsculas (16 en total; EMV admite hasta 25). */
export function newPaymentReference(): string {
  let body = '';
  for (const byte of randomBytes(14)) body += ALPHABET[byte % 32].toUpperCase();
  return `PQ${body}`;
}
