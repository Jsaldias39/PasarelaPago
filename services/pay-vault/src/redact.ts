/**
 * Un número de tarjeta que el cliente pone por error en una URL no se repite en el error ni queda en el log (el PAN solo existe
 * en pay-vault), y uno en la clave de idempotencia o el id de petición se rechaza. Misma regla que pay-payments (`domain/pan.ts`).
 */

function luhn(digits: string): boolean {
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

/** Enmascara cada corrida de dígitos (con espacios o guiones) que contenga un posible PAN según {@link containsPan}. */
export function redactPan(text: string): string {
  return text.replace(/\d(?:[ -]?\d)*/g, (run) => (containsPan(run) ? '[redacted]' : run));
}
