/**
 * ¿El texto lleva un número de tarjeta (PAN)? Regla del repo: el PAN no existe en ningún lado salvo `pay-vault` (CLAUDE.md regla 6). Núcleo COMPARTIDO: lo usan
 * la `Idempotency-Key` (se guarda en claro), el enmascarado de rutas y spans (`url-mask.ts`) y la defensa de cuerpos de pay-edge (`pan-guard.ts`).
 *
 * Cómo se inspecciona (cada punto cierra un modo de esquivarlo):
 * 1. Se normaliza: NFKC (dígitos de ancho completo, matemáticos, superíndices), se quitan los caracteres de formato invisibles (`\p{Cf}`: ancho cero, guion suave,
 *    marcas de dirección) y TODO dígito decimal de cualquier escritura (`\p{Nd}`: árabe-índicos, devanagari, tailandeses…) se lleva a su dígito ASCII.
 * 2. TODO carácter que no sea letra ni dígito (`[^\p{L}\p{N}]`: espacios, `-`, `_`, `.`, `/`, `+`, `:`, `;`, `|`, `,`, `*`, `#`, `~`, emojis, controles…) es un
 *    separador y se colapsa en un espacio ANTES de buscar corridas: ninguno puede partir una corrida para esquivar la prueba.
 * 3. Se toma cada corrida de grupos de dígitos unidos por separadores (de cualquier tipo y largo) y, sobre la SECUENCIA de dígitos, se prueba con Luhn TODA ventana
 *    contigua de 13 a 19 dígitos: un PAN pegado a otros dígitos, antes o después, no se esconde. Cada ventana se resuelve en O(1) con sumas de prefijo por
 *    paridad: costo O(n × 7) aun con 100 KB de dígitos y sin retroceso de expresión regular.
 *
 * COSTO (declarado): cuanto más larga la secuencia de dígitos, más ventanas, así que casi todo número de 20 dígitos o más (y un 25 a 40 % de las claves con una
 * fecha y un correlativo de 14 a 17 dígitos separados por guiones) se marca aunque no sea una tarjeta. Una clave legítima recomendada (UUID, ULID, texto con letras)
 * no lo sufre. LÍMITE: no detecta un PAN partido por LETRAS ni codificado (base64, hexadecimal). No lanza nunca y no devuelve ni conserva ningún fragmento del texto.
 */
const MIN_PAN = 13;
const MAX_PAN = 19;
const FORMAT_CHARS = /\p{Cf}/gu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ALNUM_RUN = /[^\p{L}\p{N}]+/gu;
/** Grupos de dígitos ASCII unidos por UN espacio (los separadores ya se colapsaron en uno). */
const DIGIT_GROUPS = /[0-9]+(?: [0-9]+)*/g;

/** Lleva un dígito decimal Unicode (cualquier escritura) a su dígito ASCII: el valor es la posición dentro de su serie contigua de a 10. */
function asciiDigit(char: string): string {
  if (char >= '0' && char <= '9') return char;
  const code = char.codePointAt(0)!;
  let before = 0;
  while (before < 49 && DECIMAL_DIGIT.test(String.fromCodePoint(code - before - 1))) before += 1;
  return String(before % 10);
}

/** ¿Alguna ventana contigua de 13 a 19 dígitos de esta secuencia cumple Luhn? O(n) con sumas de prefijo por paridad de posición. */
function hasLuhnWindow(digits: string): boolean {
  const n = digits.length;
  if (n < MIN_PAN) return false;
  // plain[x][i]: suma de los dígitos en posiciones j < i con j % 2 == x · doubled[x][i]: lo mismo pero con el dígito duplicado (Luhn)
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
    // En la ventana [start, end) el último dígito pesa 1, el anterior 2, etc.: pesa 1 si j y end-1 tienen la misma paridad.
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
  const normalized = text
    .normalize('NFKC')
    .replace(FORMAT_CHARS, '')
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(NON_ALNUM_RUN, ' ');
  for (const match of normalized.matchAll(DIGIT_GROUPS)) {
    if (hasLuhnWindow(match[0].replace(/ /g, ''))) return true;
  }
  return false;
}
