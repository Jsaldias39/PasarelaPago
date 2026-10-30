/**
 * Detector de números de tarjeta (PAN) en texto libre (regla de separación #6: el PAN solo existe en pay-vault).
 *
 * Un PAN tiene 13 a 19 dígitos y cumple Luhn (sin importar la marca); puede venir con espacios o guiones. Se busca en toda cadena que un comercio
 * pueda escribir (descripción, metadata, referencias) y se rechaza ANTES de guardarla: así no llega a la base, a un log ni a un evento.
 */
export function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * ¿Hay un posible número de tarjeta en el texto? Regla ÚNICA (la misma en pay-payments y en pay-vault): una secuencia de 13 a 19
 * dígitos contiguos que cumple Luhn. NO hay lista de marcas: una marca desconocida o un prefijo raro seguiría siendo un PAN, y la
 * guarda tiene que fallar cerrada. Se prueba CADA subsecuencia de 13 a 19 dígitos de una corrida más larga (un PAN pegado a otros
 * dígitos); una subsecuencia que empieza en 0 no es un PAN (el primer dígito de un PAN nunca es 0) y equivale a la misma sin sus
 * ceros a la izquierda, que se prueba por su cuenta en su propia posición. Los separadores admitidos entre dígitos son espacio y guion.
 */
export function containsPan(text: string): boolean {
  for (const run of text.match(/\d(?:[ -]?\d)*/g) ?? []) {
    const digits = run.replace(/[ -]/g, '');
    for (let length = 13; length <= 19; length += 1) {
      for (let start = 0; start + length <= digits.length; start += 1) {
        if (digits[start] !== '0' && luhn(digits.slice(start, start + length))) return true;
      }
    }
  }
  return false;
}

/** Forma de un token de tarjeta: lo único que una petición puede llevar en `card_token`. */
export const CARD_TOKEN_PATTERN = /^tok_[a-z0-9]{10,60}$/;
