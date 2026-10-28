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
 * - Cada texto se prueba con el núcleo COMPARTIDO `containsCardNumber` de `@pay/idempotency` (`card-number.ts`, donde está razonado): NFKC, dígitos de
 *   cualquier escritura, caracteres invisibles fuera, TODO carácter que no sea letra o dígito como separador y TODA ventana Luhn de 13 a 19 dígitos. COSTO: cuanto más larga la corrida, más ventanas, así que casi todo número de 20 dígitos o más se
 *   rechaza aunque no sea una tarjeta (tasas medidas en test/pan-guard.spec.ts y docs/cumplimiento/pci-alcance.md).
 *
 * LÍMITE: no detecta un PAN partido en varios campos («4111», «1111», …) ni codificado (base64, hexadecimal). Eso lo cubre la
 * ausencia de cualquier campo de tarjeta en el contrato y el rechazo por forma de los demás controles.
 */
import { containsCardNumber as hasCardNumber } from '@pay/idempotency';

export type BodyVerdict = 'clean' | 'card_number' | 'invalid_json';

const NUMBER_CHAR = /[0-9eE+\-.]/;

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
