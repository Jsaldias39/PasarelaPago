/**
 * Defensa en profundidad de la segmentación PCI (docs/cumplimiento/pci-alcance.md): el contrato público NO tiene ningún campo
 * para el número de tarjeta (solo tokens), así que un cuerpo que lo traiga es un error del cliente que dejaría a pay-edge
 * dentro del alcance del CDE. Se rechaza ANTES de reenviar y sin guardar ni registrar el valor.
 *
 * Cómo se inspecciona (cada punto cierra un modo de esquivarlo):
 * - El cuerpo se valida como JSON (`JSON.parse`); si no se puede interpretar, se rechaza: no se reenvía lo que no se sabe qué lleva.
 * - Se revisa CADA token de cadena y de número del texto, ya decodificado (un escape como `4` vale lo mismo que el dígito 4
 *   para quien lo recibe). Se recorre el texto token por token y no el objeto que devuelve `JSON.parse`: con claves duplicadas
 *   (`{"card":"4111…","card":"x"}`) el objeto conserva solo la última, y el servicio de destino podría conservar la otra.
 * - Los nombres de campo son tokens de cadena como cualquier otro, y los números se revisan por su texto (un número de más de
 *   2^53 pierde dígitos al decodificarse).
 * - Se normaliza (NFKC: dígitos de ancho completo; se quitan caracteres de ancho cero) y toda corrida de separadores (espacios,
 *   guiones de toda la familia, punto, barra, guion bajo, de cualquier longitud y mezcla) se colapsa en uno. Recién entonces se
 *   toma cada corrida maximal de dígitos y se prueba con Luhn TODA ventana contigua de 13 a 19 dígitos (un PAN pegado a otros
 *   dígitos no se esconde). COSTO: cuanto más larga la corrida, más ventanas, así que casi todo número de 20 dígitos o más se
 *   rechaza aunque no sea una tarjeta (tasas medidas en test/pan-guard.spec.ts y docs/cumplimiento/pci-alcance.md).
 *
 * LÍMITE: no detecta un PAN partido en varios campos («4111», «1111», …) ni codificado (base64, hexadecimal). Eso lo cubre la
 * ausencia de cualquier campo de tarjeta en el contrato y el rechazo por forma de los demás controles.
 */
export type BodyVerdict = 'clean' | 'card_number' | 'invalid_json';

/** Corrida maximal de dígitos con, a lo sumo, un espacio entre dígitos (los separadores ya se colapsaron en uno). */
const DIGIT_RUN = /[0-9](?: ?[0-9])*/g;
/** Caracteres que no cambian lo que lee una persona o un sistema: ancho cero, separadores de palabra, guion suave. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;
/** Separadores entre grupos de dígitos: espacios (incluido el no separable), guiones de toda la familia, signo menos, punto, barra y guion bajo. */
const SEPARATOR_RUN = /[\s\u00A0\u2010-\u2015\u2212.\-_/]+/g;
const NUMBER_CHAR = /[0-9eE+\-.]/;

const MIN_PAN = 13;
const MAX_PAN = 19;

/**
 * ¿Alguna ventana contigua de 13 a 19 dígitos de esta corrida cumple Luhn? Una corrida maximal puede traer el PAN pegado a otros
 * dígitos («12 / 4111 1111 1111 1111», «4111111111111111 - 7»): decidir solo por la corrida completa lo esquivaría, así que se
 * prueban TODAS las ventanas. Cada una se resuelve en O(1) con sumas de prefijo por paridad de posición, así que el costo total
 * es O(n × 7) aun con millones de dígitos y no hay retroceso de expresión regular.
 */
function runHasLuhnWindow(digits: string): boolean {
  const n = digits.length;
  if (n < MIN_PAN) return false;
  // plain[x][i]: suma de los dígitos en posiciones j < i con j % 2 == x · doubled[x][i]: lo mismo pero con el dígito duplicado (Luhn)
  const plain = [new Int32Array(n + 1), new Int32Array(n + 1)];
  const doubled = [new Int32Array(n + 1), new Int32Array(n + 1)];
  for (let j = 0; j < n; j += 1) {
    const d = digits.charCodeAt(j) - 48;
    const twice = d * 2 > 9 ? d * 2 - 9 : d * 2;
    for (let x = 0; x < 2; x += 1) {
      plain[x][j + 1] = plain[x][j] + (j % 2 === x ? d : 0);
      doubled[x][j + 1] = doubled[x][j] + (j % 2 === x ? twice : 0);
    }
  }
  for (let end = MIN_PAN; end <= n; end += 1) {
    // En la ventana [start, end) el último dígito pesa 1, el anterior 2, etc.: pesa 1 si j y end-1 tienen la misma paridad.
    const same = (end - 1) % 2;
    for (let length = MIN_PAN; length <= MAX_PAN && length <= end; length += 1) {
      const start = end - length;
      const sum = plain[same][end] - plain[same][start] + doubled[1 - same][end] - doubled[1 - same][start];
      if (sum % 10 === 0) return true;
    }
  }
  return false;
}

function hasCardNumber(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(INVISIBLE, '').replace(SEPARATOR_RUN, ' ');
  for (const match of normalized.matchAll(DIGIT_RUN)) {
    if (runHasLuhnWindow(match[0].replace(/ /g, ''))) return true;
  }
  return false;
}

function numberHasCardNumber(source: string): boolean {
  if (hasCardNumber(source)) return true;
  // Un entero escrito tal cual ya se revisó por su texto exacto (convertirlo a Number perdería dígitos por encima de 2^53).
  if (/^-?[0-9]+$/.test(source)) return false;
  const value = Number(source);
  // 4.111111111111111e15 es el mismo entero que 4111111111111111
  return Number.isFinite(value) && Number.isInteger(value) && hasCardNumber(BigInt(value).toString());
}

/**
 * Recorre un texto que ya es JSON válido y revisa cada token de cadena y de número, en el orden en que aparecen y sin
 * recursión (un cuerpo con 500.000 niveles de anidación no puede reventar la pila).
 */
function scanTokens(text: string): boolean {
  const length = text.length;
  let i = 0;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      let end = i + 1;
      while (end < length) {
        const current = text.charCodeAt(end);
        if (current === 92) end += 2;
        else if (current === 34) break;
        else end += 1;
      }
      // El texto ya pasó por JSON.parse: el token siempre es una cadena JSON válida.
      if (hasCardNumber(JSON.parse(text.slice(i, end + 1)) as string)) return true;
      i = end + 1;
    } else if ((code >= 48 && code <= 57) || code === 45) {
      let end = i + 1;
      while (end < length && NUMBER_CHAR.test(text[end])) end += 1;
      if (numberHasCardNumber(text.slice(i, end))) return true;
      i = end;
    } else {
      i += 1;
    }
  }
  return false;
}

/** Revisa un cuerpo JSON. No lanza nunca y no devuelve ni conserva ningún fragmento del contenido. */
export function inspectBody(body: Buffer): BodyVerdict {
  if (body.length === 0) return 'clean';
  const text = body.toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    // El mensaje de JSON.parse cita un trozo del texto: se descarta a propósito.
    return 'invalid_json';
  }
  return scanTokens(text) ? 'card_number' : 'clean';
}

/** Compatibilidad con las pruebas de la función pura. */
export const containsCardNumber = (body: Buffer): boolean => inspectBody(body) === 'card_number';
