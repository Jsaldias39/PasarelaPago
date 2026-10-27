/**
 * Enmascara números largos (13 a 19 dígitos, con espacios o guiones) en texto que puede venir del cliente y se repite en una
 * respuesta o un log (por ejemplo la ruta de un 404). Un cliente que pone un número de tarjeta en la URL por error no lo ve
 * repetido en el error ni queda en el log (el PAN solo existe en pay-vault).
 */
export function redactPan(text: string): string {
  return text.replace(/\d(?:[ -]?\d){12,18}/g, '[redacted]');
}

/** ¿Hay un número de tarjeta (13 a 19 dígitos que cumplen Luhn) en el texto? */
export function containsPan(text: string): boolean {
  const candidates = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/[ -]/g, '');
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
    return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
  });
}
