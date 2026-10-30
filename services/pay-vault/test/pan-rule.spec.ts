import { containsPan } from '../src/redact';

const luhn = (digits: string): boolean => {
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
};

/** Números de PRUEBA públicos de cada marca (los que publican los procesadores); ninguno es una tarjeta real. */
const KNOWN: [string, string][] = [
  ['Visa 16', '4111111111111111'],
  ['Visa 13', '4222222222222'],
  ['Visa 19', '4000000000000000006'],
  ['Mastercard', '5555555555554444'],
  ['Mastercard serie 2', '2223003122003222'],
  ['Amex', '378282246310005'],
  ['Discover', '6011111111111117'],
  ['JCB', '3530111333300000'],
  ['Diners', '30569309025904'],
  ['UnionPay', '6200000000000005'],
];

const lcg = (seed: bigint) => {
  let state = seed;
  return (limit: number): number => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number((state >> 11n) % BigInt(limit));
  };
};

/** Implementación de REFERENCIA, escrita distinto a propósito (recorre carácter a carácter): las dos copias del servicio se comparan contra ella. */
function reference(text: string): boolean {
  const runs: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c >= '0' && c <= '9') current += c;
    else if ((c === ' ' || c === '-') && current !== '' && i + 1 < text.length && (text[i + 1] as string) >= '0' && (text[i + 1] as string) <= '9') continue;
    else {
      if (current) runs.push(current);
      current = '';
    }
  }
  if (current) runs.push(current);
  const valid = (d: string) => {
    let sum = 0;
    for (let i = 0; i < d.length; i += 1) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2 === 1) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    return sum % 10 === 0;
  };
  return runs.some((run) => {
    for (let a = 0; a < run.length; a += 1) for (let b = a + 13; b <= Math.min(run.length, a + 19); b += 1) if (run[a] !== '0' && valid(run.slice(a, b))) return true;
    return false;
  });
}

/** Primer número de `length` dígitos, desde un prefijo, que cumple (o no) Luhn. */
function numberWith(prefix: string, length: number, luhnOk: boolean, luhn: (d: string) => boolean): string {
  for (let tail = 0; tail < 10_000_000; tail += 1) {
    const candidate = `${prefix}${String(tail).padStart(length - prefix.length, '0')}`;
    if (luhn(candidate) === luhnOk) return candidate;
  }
  throw new Error('sin candidato');
}

describe('containsPan: Luhn de 13 a 19 dígitos, sin lista de marcas (misma regla en pay-payments y pay-vault)', () => {
  describe('correcto', () => {
    it.each(KNOWN)('un PAN conocido (%s) se detecta solo, con espacios, con guiones y dentro de una frase', (_name, pan) => {
      const spaced = pan.replace(/(\d{4})(?=\d)/g, '$1 ');
      const dashed = pan.replace(/(\d{4})(?=\d)/g, '$1-');
      for (const text of [pan, spaced, dashed, `pago de ${pan}.`, `idem-${pan}`, `x ${spaced} y`]) expect({ text, found: containsPan(text) }).toEqual({ text, found: true });
    });

    it('una marca DESCONOCIDA o un prefijo cualquiera con Luhn válido también se detecta (la guarda falla cerrada, no por marca)', () => {
      for (const prefix of ['9', '1793120', '7', '9100', '1000', '8', '5019', '0123'.slice(1)]) {
        const sample = numberWith(prefix, 16, true, luhn);
        expect({ sample, found: containsPan(sample) }).toEqual({ sample, found: true });
      }
    });
  });

  describe('límite', () => {
    it('exactamente 13 y exactamente 19 dígitos con Luhn válido', () => {
      const t13 = numberWith('9', 13, true, luhn);
      const t19 = numberWith('9', 19, true, luhn);
      expect([t13.length, containsPan(t13), t19.length, containsPan(t19)]).toEqual([13, true, 19, true]);
    });

    it('ceros a la izquierda: el PAN con ceros delante, y con tantos que la corrida supera los 19 dígitos', () => {
      expect(containsPan('0004111111111111111')).toBe(true);
      expect(containsPan('0000000004111111111111111')).toBe(true);
      expect(containsPan('0000 0000 4111 1111 1111 1111'.replace(/ /g, '-'))).toBe(true);
    });

    it('un PAN pegado a otros dígitos (más de 19 en total) se detecta por subsecuencia', () => {
      expect(containsPan(`12${'4111111111111111'}34`)).toBe(true);
      expect(containsPan(`${'4111111111111111'}98765`)).toBe(true);
    });
  });

  describe('inválido: no es un PAN', () => {
    it('12 dígitos aunque cumplan Luhn, y Luhn falso en 13 a 19 dígitos', () => {
      const t12 = numberWith('9', 12, true, luhn);
      expect([t12.length, containsPan(t12)]).toEqual([12, false]);
      // «Luhn falso» = ninguna subsecuencia de 13 a 19 dígitos cumple Luhn (con la corrida entera sola no alcanza: se prueban todas).
      for (const length of [13, 14, 15, 16, 17, 18, 19]) {
        let bad = '';
        for (let tail = 0; tail < 1_000_000; tail += 1) {
          bad = `9${String(tail).padStart(length - 1, '0')}`;
          if (!reference(bad)) break;
        }
        expect({ bad, length: bad.length, ref: reference(bad), found: containsPan(bad) }).toEqual({ bad, length, ref: false, found: false });
      }
      expect(reference('4111111111111112')).toBe(containsPan('4111111111111112')); // el caso «un dígito mal» se decide igual que la referencia
    });

    it('20 dígitos cuya NINGUNA subsecuencia de 13 a 19 cumple Luhn, y solo ceros', () => {
      const next = lcg(20260101n);
      let sample = '';
      for (let i = 0; i < 100_000; i += 1) {
        sample = Array.from({ length: 20 }, () => String(1 + next(9))).join('');
        if (!reference(sample)) break;
      }
      expect({ sample, length: sample.length, ref: reference(sample), found: containsPan(sample) }).toEqual({ sample, length: 20, ref: false, found: false });
      expect(containsPan('0'.repeat(13))).toBe(false);
      expect(containsPan('0'.repeat(25))).toBe(false);
    });

    it('números cortos, teléfonos y texto sin dígitos', () => {
      for (const text of ['', 'sin números', '+591 7 123 4567', 'orden 1234567', 'k-abc-1', '12 34 56 78 90 12']) expect({ text, found: containsPan(text) }).toEqual({ text, found: false });
    });
  });

  it('propiedad (4.000 cadenas con semilla fija): coincide con la implementación de referencia en todas', () => {
    const next = lcg(777n);
    const alphabet = '0123456789 -abx';
    let positives = 0;
    for (let i = 0; i < 4000; i += 1) {
      const length = 1 + next(45);
      const text = Array.from({ length }, () => alphabet[next(next(2) === 0 ? 10 : alphabet.length)] as string).join('');
      const expected = reference(text);
      if (expected) positives += 1;
      expect({ text, found: containsPan(text) }).toEqual({ text, found: expected });
    }
    expect(positives).toBeGreaterThan(50); // el generador ejercita ambos lados
    expect(positives).toBeLessThan(3500);
  });
});
