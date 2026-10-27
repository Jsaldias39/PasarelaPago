/**
 * Defensa en profundidad de la segmentación PCI (docs/cumplimiento/pci-alcance.md): el contrato público NO tiene ningún campo
 * para el número de tarjeta (solo tokens), así que un cuerpo que lo traiga es un error del cliente que dejaría a pay-edge
 * dentro del alcance del CDE. Se rechaza ANTES de reenviar y sin guardar ni registrar el valor.
 *
 * Se inspecciona el JSON YA DECODIFICADO, no los bytes crudos: `"411…"` es el mismo número que `"411…"` para quien lo
 * recibe, y mirar el texto crudo lo dejaba pasar. Se revisan todas las cadenas, los nombres de campo y los números (también
 * anidados en objetos y listas), se normalizan los separadores y los dígitos de otros alfabetos (NFKC) y se aplica Luhn a las
 * corridas de 13 a 19 dígitos. Adicionalmente se revisa el texto crudo, que atrapa los números JSON que pierden precisión al
 * decodificarse (más de 2^53).
 *
 * LÍMITE: no detecta un PAN partido en varios campos («4111», «1111», …) ni codificado (base64, hex). Eso lo cubre la ausencia de
 * cualquier campo de tarjeta en el contrato y el rechazo por forma de los demás controles.
 */
export type BodyVerdict = 'clean' | 'card_number' | 'invalid_json';

const CANDIDATE = /(?<![0-9])(?:[0-9][ \-._/]?){12,18}[0-9](?![0-9])/g;
/** Caracteres que no cambian lo que lee una persona o un sistema: ancho cero, separadores de palabra, guion suave. */
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;
/** Separadores entre grupos de dígitos que una persona escribe: espacios (incluido el no separable), guiones de toda la familia, punto, barra y guion bajo. */
const SEPARATORS = /[\s\u00A0\u2010-\u2015\u2212]/g;

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
  // NFKC lleva los dígitos de ancho completo (４１１１…) y otros alfabetos compatibles a ASCII.
  const normalized = text.normalize('NFKC').replace(INVISIBLE, '').replace(SEPARATORS, ' ');
  for (const match of normalized.matchAll(CANDIDATE)) {
    const digits = match[0].replace(/[^0-9]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** Recorre el valor sin recursión (un cuerpo con 500.000 niveles de anidación no puede reventar la pila). */
function walk(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (hasCardNumber(value)) return true;
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && Number.isFinite(value) && hasCardNumber(BigInt(value).toString())) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (hasCardNumber(key)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

/** Revisa un cuerpo JSON. No lanza nunca y no devuelve ni conserva ningún fragmento del contenido. */
export function inspectBody(body: Buffer): BodyVerdict {
  if (body.length === 0) return 'clean';
  const text = body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // El mensaje de JSON.parse cita un trozo del texto: se descarta a propósito.
    return 'invalid_json';
  }
  // Números enormes: JSON.parse los redondea y Luhn dejaría de cumplirse; el texto crudo los conserva exactos.
  if (hasCardNumber(text) || walk(parsed)) return 'card_number';
  return 'clean';
}

/** Compatibilidad con las pruebas de la función pura. */
export const containsCardNumber = (body: Buffer): boolean => inspectBody(body) === 'card_number';
