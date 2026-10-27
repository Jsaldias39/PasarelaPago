import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc16CcittFalse, crcHex } from './crc16';
import { buildMpmPayload, parseMpmPayload } from './mpm';
import { decodeTlv, EmvFormatError, encodeTlv } from './tlv';

interface Vector {
  payload: string;
  expected_crc: string;
  package: string;
  version: string;
  license: string;
  file: string;
}
/** Payloads PUBLICADOS por terceros (npm, licencias permisivas) con su CRC; procedencia en cada entrada. */
const vectors: Vector[] = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/published-vectors.json'), 'utf8'));

const accepted = (payload: string): boolean => {
  try {
    return parseMpmPayload(payload).crcValid;
  } catch {
    return false;
  }
};

describe('CRC-16/CCITT-FALSE (M1)', () => {
  it('cumple el valor de comprobación estándar de "123456789" → 0x29B1', () => {
    expect(crc16CcittFalse('123456789')).toBe(0x29b1);
    expect(crcHex('')).toBe('FFFF');
  });

  it(`reproduce el CRC de los ${vectors.length} payloads publicados por terceros`, () => {
    expect(vectors.length).toBeGreaterThanOrEqual(12);
    for (const v of vectors) expect(crcHex(v.payload.slice(0, -4))).toBe(v.expected_crc.toUpperCase());
  });

  it('el CRC incluye el encabezado `6304` (calcularlo sin él da otro valor)', () => {
    const v = vectors[0];
    expect(crcHex(v.payload.slice(0, -8))).not.toBe(v.expected_crc.toUpperCase());
  });
});

describe('TLV', () => {
  it('ida y vuelta sin pérdida', () => {
    const fields = [{ id: '00', value: '01' }, { id: '59', value: 'FULANO DE TAL' }];
    expect(decodeTlv(encodeTlv(fields))).toEqual(fields);
  });

  it.each([
    ['etiqueta no numérica', 'AB0201'],
    ['longitud no numérica', '00XX01'],
    ['longitud cero', '000001'],
    ['valor truncado', '0005ABC'],
    ['longitud incompleta', '005'],
  ])('rechaza %s', (_n, text) => {
    expect(() => decodeTlv(text)).toThrow(EmvFormatError);
  });

  it('no codifica valores vacíos ni de más de 99 caracteres ni etiquetas inválidas', () => {
    expect(() => encodeTlv([{ id: '59', value: '' }])).toThrow(EmvFormatError);
    expect(() => encodeTlv([{ id: '59', value: 'x'.repeat(100) }])).toThrow(EmvFormatError);
    expect(() => encodeTlv([{ id: '5', value: 'x' }])).toThrow(EmvFormatError);
    expect(encodeTlv([{ id: '59', value: 'x'.repeat(99) }])).toHaveLength(103);
  });
});

describe('payload MPM', () => {
  const base = { accountGuid: 'guid.provisional', merchantAccountRef: 'mc_abcdefghij12', merchantName: 'Clínica Santa María', merchantCity: 'Santa Cruz' };

  it('ida y vuelta de los payloads publicados: se leen y se vuelven a codificar idénticos', () => {
    for (const v of vectors) {
      const parsed = parseMpmPayload(v.payload);
      expect(parsed.crcValid).toBe(true);
      const body = `${encodeTlv(parsed.fields.slice(0, -1))}6304`;
      expect(`${body}${crcHex(body)}`).toBe(v.payload);
    }
  });

  it('QR dinámico: lleva monto con 2 decimales, moneda 068, país BO, referencia y CRC válido', () => {
    const payload = buildMpmPayload({ ...base, kind: 'dynamic', amountMinor: 10000n, referenceLabel: 'PQ7K2M9XABCD1234' });
    expect(payload.startsWith('000201')).toBe(true);
    expect(payload).toMatch(/6304[0-9A-F]{4}$/);
    const parsed = parseMpmPayload(payload);
    expect(parsed).toMatchObject({ crcValid: true, pointOfInitiation: 'dynamic', amount: '100.00', currencyNumeric: '068', country: 'BO', mcc: '0000', referenceLabel: 'PQ7K2M9XABCD1234' });
    expect(parsed.merchantName).toBe('Clinica Santa Maria'); // sin tildes: las longitudes EMV son en caracteres ASCII
    expect(parsed.merchantAccounts[0].subfields).toEqual([{ id: '00', value: 'guid.provisional' }, { id: '01', value: 'mc_abcdefghij12' }]);
  });

  it('QR estático: sin monto, punto de iniciación 11 y referencia `***`', () => {
    const parsed = parseMpmPayload(buildMpmPayload({ ...base, kind: 'static' }));
    expect(parsed).toMatchObject({ crcValid: true, pointOfInitiation: 'static', amount: null, referenceLabel: '***' });
  });

  it('un centavo y el máximo seguro se escriben exactos (sin coma flotante)', () => {
    expect(parseMpmPayload(buildMpmPayload({ ...base, kind: 'dynamic', amountMinor: 1n, referenceLabel: 'A' })).amount).toBe('0.01');
    expect(parseMpmPayload(buildMpmPayload({ ...base, kind: 'dynamic', amountMinor: 900719925474099n, referenceLabel: 'A' })).amount).toBe('9007199254740.99');
  });

  it('UN CARÁCTER CAMBIADO ⇒ el payload deja de ser válido (todas las posiciones de todos los payloads)', () => {
    const swap = (c: string) => (c === '0' ? '1' : c === 'Z' ? 'Y' : /\d/.test(c) ? '0' : 'Z');
    let probes = 0;
    const own = buildMpmPayload({ ...base, kind: 'dynamic', amountMinor: 12345n, referenceLabel: 'PQ7K2M9XABCD1234' });
    for (const payload of [own, ...vectors.map((v) => v.payload)]) {
      expect(accepted(payload)).toBe(true);
      for (let i = 0; i < payload.length; i += 1) {
        const mutated = payload.slice(0, i) + swap(payload[i]) + payload.slice(i + 1);
        expect(accepted(mutated)).toBe(false);
        probes += 1;
      }
    }
    expect(probes).toBeGreaterThan(1000);
  });

  it('rechaza lo que no cumple EMV al armar', () => {
    const dyn = { ...base, kind: 'dynamic' as const, referenceLabel: 'REF1' };
    expect(() => buildMpmPayload({ ...dyn })).toThrow(/monto/);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 0n })).toThrow(EmvFormatError);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 1n, referenceLabel: undefined })).toThrow(EmvFormatError);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 1n, referenceLabel: 'con espacio' })).toThrow(EmvFormatError);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 1n, merchantName: 'N'.repeat(26) })).toThrow(/25/);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 1n, merchantCity: 'C'.repeat(16) })).toThrow(/15/);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 1n, merchantName: '商店' })).toThrow(EmvFormatError);
    expect(() => buildMpmPayload({ ...dyn, amountMinor: 1n, mcc: '12' })).toThrow(EmvFormatError);
    expect(() => buildMpmPayload({ ...base, kind: 'static', amountMinor: 100n })).toThrow(/estático/);
  });

  it('rechaza al leer lo que no es un payload MPM', () => {
    for (const bad of ['', 'x'.repeat(600), '0002010102116304ABCD'.slice(0, 10), '000202'.padEnd(30, '0'), '00020101021258020BO']) {
      expect(() => parseMpmPayload(bad)).toThrow(EmvFormatError);
    }
    // CRC mal formado (minúsculas) se informa como inválido, no se acepta
    const ok = buildMpmPayload({ ...base, kind: 'static' });
    expect(parseMpmPayload(`${ok.slice(0, -4)}${ok.slice(-4).toLowerCase().replace(/\d/g, 'a')}`).crcValid).toBe(false);
  });
});
