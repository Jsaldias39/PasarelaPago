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
 *   guiones de toda la familia, punto, barra, guion bajo, de cualquier longitud y mezcla) se colapsa en uno; recién entonces se
 *   buscan corridas de 13 a 19 dígitos que cumplan Luhn.
 *
 * LÍMITE: no detecta un PAN partido en varios campos («4111», «1111», …) ni codificado (base64, hexadecimal). Eso lo cubre la
 * ausencia de cualquier campo de tarjeta en el contrato y el rechazo por forma de los demás controles.
 */
export type BodyVerdict = 'clean' | 'card_number' | 'invalid_json';

const CANDIDATE = /(?<![0-9])(?:[0-9] ?){12,18}[0-9](?![0-9])/g;
/** Caracteres que no cambian lo que lee una persona o un sistema: ancho cero, separadores de palabra, guion suave. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;
/** Separadores entre grupos de dígitos: espacios (incluido el no separable), guiones de toda la familia, signo menos, punto, barra y guion bajo. */
const SEPARATOR_RUN = /[\s\u00A0\u2010-\u2015\u2212.\-_/]+/g;
const NUMBER_CHAR = /[0-9eE+\-.]/;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(INVISIBLE, '').replace(SEPARATOR_RUN, ' ');
  for (const match of normalized.matchAll(CANDIDATE)) {
    const digits = match[0].replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function numberHasCardNumber(source: string): boolean {
  if (hasCardNumber(source)) return true;
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
