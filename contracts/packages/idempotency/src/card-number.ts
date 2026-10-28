/**
 * ¿El texto lleva un número de tarjeta (PAN)? Regla del repo: el PAN no existe en ningún lado salvo `pay-vault` (CLAUDE.md regla 6). La tabla
 * `idempotency_keys` guarda la `Idempotency-Key` EN CLARO, así que una clave con forma de PAN no puede ni entrar a ella.
 *
 * Mismo criterio que la defensa de pay-edge (`services/pay-edge/src/proxy/pan-guard.ts`, donde está razonado): se normaliza (NFKC, sin caracteres
 * invisibles), toda corrida de separadores (espacios, guiones, punto, barra, guion bajo, de cualquier mezcla) se colapsa en uno y, de cada corrida maximal
 * de dígitos, se prueba con Luhn TODA ventana contigua de 13 a 19 dígitos (un PAN pegado a otros dígitos o a letras no se esconde).
 * COSTO: cuanto más larga la corrida, más ventanas, así que casi todo número de 20 dígitos o más se rechaza aunque no sea una tarjeta; una clave
 * legítima (UUID, ULID, `orden-123`) no tiene corridas largas de dígitos. LÍMITE: no detecta un PAN partido por letras ni codificado (base64, hex).
 * No lanza nunca y no conserva ni devuelve ningún fragmento del texto.
 */
const MIN_PAN = 13;
const MAX_PAN = 19;
const DIGIT_RUN = /[0-9](?: ?[0-9])*/g;
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;
const SEPARATOR_RUN = /[\s\u00A0\u2010-\u2015\u2212.\-_/]+/g;

/** ¿Alguna ventana contigua de 13 a 19 dígitos de esta corrida cumple Luhn? O(n) con sumas de prefijo por paridad (sin retroceso de regex). */
function runHasLuhnWindow(digits: string): boolean {
  const n = digits.length;
  if (n < MIN_PAN) return false;
  const plain = [new Int32Array(n + 1), new Int32Array(n + 1)];
  const doubled = [new Int32Array(n + 1), new Int32Array(n + 1)];
  for (let j = 0; j < n; j += 1) {
    const d = digits.charCodeAt(j) - 48;
    const twice = d * 2 > 9 ? d * 2 - 9 : d * 2;
    for (let x = 0; x < 2; x += 1) {
      plain[x]![j + 1] = plain[x]![j]! + (j % 2 === x ? d : 0);
      doubled[x]![j + 1] = doubled[x]![j]! + (j % 2 === x ? twice : 0);
    }
  }
  for (let end = MIN_PAN; end <= n; end += 1) {
    const same = (end - 1) % 2;
    for (let length = MIN_PAN; length <= MAX_PAN && length <= end; length += 1) {
      const start = end - length;
      const sum = plain[same]![end]! - plain[same]![start]! + doubled[1 - same]![end]! - doubled[1 - same]![start]!;
      if (sum % 10 === 0) return true;
    }
  }
  return false;
}

export function containsCardNumber(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(INVISIBLE, '').replace(SEPARATOR_RUN, ' ');
  for (const match of normalized.matchAll(DIGIT_RUN)) {
    if (runHasLuhnWindow(match[0].replace(/ /g, ''))) return true;
  }
  return false;
}
