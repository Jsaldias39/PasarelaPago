/**
 * Detector de números de tarjeta (PAN) de las pruebas E2E. Es el ORÁCULO de E7 y por eso es independiente del código del producto: no importa nada de
 * `@pay/idempotency` (cuyo `containsCardNumber` es justamente lo que se está comprobando).
 *
 * Dos capas:
 *  1. PAN CONOCIDOS (los sintéticos que la prueba usó): se buscan en cualquier lugar del texto, también dentro de una cifra más larga, con las separaciones habituales
 *     (espacios, guiones, puntos) y con los grupos de cada marca (4-4-4-4, 4-6-5).
 *  2. NÚMEROS CON FORMA DE TARJETA que la prueba no conoce: una tira de dígitos con separadores simples de 13 a 19 dígitos que empieza como Visa/Mastercard/Amex/Discover/JCB
 *     y cumple Luhn. Solo tiras MÁXIMAS (no ventanas dentro de una tira más larga): un identificador numérico largo daría falsos positivos constantemente.
 * Los hallazgos se devuelven ENMASCARADOS (6 primeros y 4 últimos): ni el informe ni el log de la prueba repiten el número.
 */

/** PAN SINTÉTICOS de prueba (números de prueba públicos de las marcas; no corresponden a ninguna tarjeta real ni a ningún titular). */
export const SYNTHETIC_PANS = {
  visa: '4111111111111111',
  mastercard: '5555555555554444',
  amex: '378282246310005',
} as const;

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
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

const BRAND_PREFIX = /^(?:4|5[1-5]|2(?:2[2-9][1-9]|[3-6]\d\d|7[01]\d|720)|3[47]|6011|65|35(?:2[89]|[3-8]\d))/;

/** Las formas en que se escribe un PAN: seguido, o en grupos con espacio, guion o punto. */
export function panVariants(pan: string): string[] {
  const groups = pan.length === 15 ? [4, 6, 5] : [4, 4, 4, 4, 3].slice(0, Math.ceil(pan.length / 4));
  const cut: string[] = [];
  let offset = 0;
  for (const size of pan.length === 15 ? groups : Array.from({ length: Math.ceil(pan.length / 4) }, () => 4)) {
    cut.push(pan.slice(offset, offset + size));
    offset += size;
  }
  return [pan, ...[' ', '-', '.'].map((separator) => cut.join(separator))];
}

export const maskPan = (digits: string): string => (digits.length <= 10 ? '*'.repeat(digits.length) : `${digits.slice(0, 6)}${'*'.repeat(digits.length - 10)}${digits.slice(-4)}`);

export interface PanHit {
  readonly source: string;
  readonly kind: 'known_pan' | 'card_like_number';
  /** Número enmascarado (6 primeros, 4 últimos). */
  readonly masked: string;
  readonly offset: number;
}

/** Tiras de dígitos con UN separador simple (espacio, guion o punto) entre dígitos. */
const RUN = /(?<!\d)\d(?:[ .-]?\d)*(?!\d)/g;

export function scanText(source: string, text: string, knownPans: readonly string[] = Object.values(SYNTHETIC_PANS)): PanHit[] {
  const hits: PanHit[] = [];
  const seen = new Set<string>();
  const push = (hit: PanHit): void => {
    const key = String(hit.offset); // el mismo número visto por las dos capas cuenta UNA vez (gana la de PAN conocidos)
    if (!seen.has(key)) {
      seen.add(key);
      hits.push(hit);
    }
  };
  for (const pan of knownPans) {
    for (const variant of panVariants(pan)) {
      for (let at = text.indexOf(variant); at !== -1; at = text.indexOf(variant, at + 1)) push({ source, kind: 'known_pan', masked: maskPan(pan), offset: at });
    }
  }
  for (const match of text.matchAll(RUN)) {
    const digits = match[0].replace(/[ .-]/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    if (BRAND_PREFIX.test(digits) && luhnValid(digits)) push({ source, kind: 'card_like_number', masked: maskPan(digits), offset: match.index ?? 0 });
  }
  return hits;
}

/** Una fuente con nombre y su texto: `scanSources` recorre todas y suma cuánto texto miró (para probar que el escaneo no fue vacío). */
export interface ScanSource {
  readonly source: string;
  readonly text: string;
}

export function scanSources(sources: readonly ScanSource[], knownPans?: readonly string[]): { hits: PanHit[]; sources: number; bytes: number } {
  const hits = sources.flatMap((s) => scanText(s.source, s.text, knownPans));
  return { hits, sources: sources.length, bytes: sources.reduce((total, s) => total + s.text.length, 0) };
}
