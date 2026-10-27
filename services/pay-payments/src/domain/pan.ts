/**
 * Detector de números de tarjeta (PAN) en texto libre (regla de separación #6: el PAN solo existe en pay-vault).
 *
 * Un PAN tiene 13 a 19 dígitos y cumple Luhn; puede venir con espacios o guiones. Se busca en toda cadena que un comercio
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

/** Secuencias de dígitos (con separadores comunes) de 13 a 19 dígitos que pasan Luhn Y tienen el prefijo y el largo de una marca de tarjeta. */
export function containsPan(text: string): boolean {
  const candidates = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) && CARD_PATTERNS.some((pattern) => pattern.test(digits));
  });
}

/** Forma de un token de tarjeta: lo único que una petición puede llevar en `card_token`. */
export const CARD_TOKEN_PATTERN = /^tok_[a-z0-9]{10,60}$/;
