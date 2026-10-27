/**
 * Defensa en profundidad de la segmentación PCI (docs/cumplimiento/pci-alcance.md): el contrato público NO tiene ningún campo
 * para el número de tarjeta (solo tokens), así que un cuerpo que lo traiga es un error del cliente que dejaría a pay-edge
 * dentro del alcance del CDE. Se rechaza ANTES de reenviar y sin guardar ni registrar el valor.
 *
 * Detecta corridas de 13 a 19 dígitos (con espacios o guiones entre grupos) que cumplen Luhn.
 */
const CANDIDATE = /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g;

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

export function containsCardNumber(body: Buffer): boolean {
  const text = body.toString('latin1');
  for (const match of text.matchAll(CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}
