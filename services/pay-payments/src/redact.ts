import { containsPan } from './domain/pan';

/**
 * Enmascara cada corrida de dígitos (con espacios o guiones) que contenga un posible PAN según `containsPan` (Luhn de 13 a 19
 * dígitos, sin lista de marcas). Un cliente que pone un número de tarjeta en la URL por error no lo ve repetido en el error ni
 * queda en el log (el PAN solo existe en pay-vault). Misma regla que pay-vault (`src/redact.ts`).
 */
export function redactPan(text: string): string {
  return text.replace(/\d(?:[ -]?\d)*/g, (run) => (containsPan(run) ? '[redacted]' : run));
}
