/**
 * Enmascara números largos (13 a 19 dígitos, con espacios o guiones) en texto que puede venir del cliente y se repite en una
 * respuesta o un log (por ejemplo la ruta de un 404). Un cliente que pone un número de tarjeta en la URL por error no lo ve
 * repetido en el error ni queda en el log (el PAN solo existe en pay-vault).
 */
export function redactPan(text: string): string {
  return text.replace(/\d(?:[ -]?\d){12,18}/g, '[redacted]');
}


/** Prefijos (IIN) y largos de las marcas de tarjeta que se aceptan en la región. Un número de 13–19 dígitos que cumple Luhn pero no empieza así (un timestamp, un id de orden) NO es un PAN. */
const CARD_PATTERNS: readonly RegExp[] = [
  /^4(\d{12}|\d{15}|\d{18})$/, // Visa
  /^(5[1-5]\d{14}|2(22[1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720)\d{12})$/, // Mastercard
  /^3[47]\d{13}$/, // American Express
  /^(6011\d{12}|65\d{14}|64[4-9]\d{13})$/, // Discover
  /^62\d{14,17}$/, // UnionPay
  /^3(0[0-5]|09|[68]\d)\d{11}$/, // Diners Club
  /^35(2[89]|[3-8]\d)\d{12}$/, // JCB
  /^(5018|5020|5038|5893|6304|6759|676[1-3])\d{8,15}$/, // Maestro
];

/** ¿Hay un número de tarjeta (13 a 19 dígitos que cumplen Luhn y tienen el prefijo y el largo de una marca) en el texto? */
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
    return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0 && CARD_PATTERNS.some((pattern) => pattern.test(digits));
  });
}
