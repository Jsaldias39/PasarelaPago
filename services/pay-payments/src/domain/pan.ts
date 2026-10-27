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

/** Secuencias de dígitos (con separadores comunes) de 13 a 19 dígitos que pasan Luhn. */
export function containsPan(text: string): boolean {
  const candidates = text.match(/\d(?:[ -]?\d){12,18}/g) ?? [];
  return candidates.some((candidate) => {
    const digits = candidate.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhn(digits);
  });
}

/** Forma de un token de tarjeta: lo único que una petición puede llevar en `card_token`. */
export const CARD_TOKEN_PATTERN = /^tok_[a-z0-9]{10,60}$/;
