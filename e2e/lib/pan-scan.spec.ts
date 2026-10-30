import { luhnValid, maskPan, panVariants, scanSources, scanText, SYNTHETIC_PANS } from './pan-scan.ts';

/**
 * El oráculo de E7 (pan-scan.ts) tiene que acertar solo: un detector que no ve el PAN daría un verde falso a toda la prueba, y uno que ve PAN en cualquier número larga el
 * suite a rojo por nada. Tres niveles: correcto (encuentra cada forma del PAN conocido y el desconocido válido), límite (identificadores, fechas y cifras largas no son tarjetas;
 * un PAN dentro de una cifra más larga se encuentra por la capa de PAN conocidos) e inválido (Luhn mal, prefijo de otra cosa, longitudes fuera de 13–19).
 */
describe('pan-scan', () => {
  const VISA = SYNTHETIC_PANS.visa;
  const MC = SYNTHETIC_PANS.mastercard;
  const AMEX = SYNTHETIC_PANS.amex;

  describe('correcto', () => {
    it('los PAN sintéticos cumplen Luhn (son números de prueba válidos) y la variante seguida es la primera', () => {
      for (const pan of Object.values(SYNTHETIC_PANS)) {
        expect(luhnValid(pan)).toBe(true);
        expect(panVariants(pan)[0]).toBe(pan);
      }
    });

    it('encuentra el PAN conocido seguido, con espacios, con guiones y con puntos, y el Amex en grupos 4-6-5', () => {
      expect(scanText('t', `{"card":"${VISA}"}`).map((h) => h.kind)).toEqual(['known_pan']);
      expect(scanText('t', 'tarjeta 4111 1111 1111 1111 ok')).toHaveLength(1);
      expect(scanText('t', 'tarjeta 4111-1111-1111-1111 ok')).toHaveLength(1);
      expect(scanText('t', 'tarjeta 4111.1111.1111.1111 ok')).toHaveLength(1);
      expect(scanText('t', 'amex 3782 822463 10005 fin')).toHaveLength(1);
      expect(scanText('t', `mc=${MC}`)).toHaveLength(1);
      expect(scanText('t', `amex=${AMEX}`)).toHaveLength(1);
    });

    it('encuentra una tarjeta que la prueba NO conoce (Visa, Mastercard, Amex y Discover válidas) por forma + prefijo + Luhn, y la devuelve enmascarada', () => {
      for (const unknown of ['4012888888881881', '5105105105105100', '371449635398431', '6011111111111117']) {
        const hits = scanText('log', `x ${unknown} y`, []);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ kind: 'card_like_number', source: 'log' });
        expect(hits[0]!.masked).toBe(maskPan(unknown));
        expect(hits[0]!.masked).not.toContain(unknown);
      }
    });

    it('el hallazgo no repite el PAN: solo 6 primeros y 4 últimos', () => {
      const hit = scanText('t', `a ${VISA} b`)[0]!;
      expect(hit.masked).toBe('411111******1111');
      expect(JSON.stringify(hit)).not.toContain(VISA);
    });

    it('scanSources suma fuentes y bytes mirados (la prueba lo usa para demostrar que el escaneo no fue vacío)', () => {
      const result = scanSources([{ source: 'a', text: 'nada' }, { source: 'b', text: `PAN ${VISA}` }]);
      expect(result).toMatchObject({ sources: 2, bytes: 4 + 4 + VISA.length });
      expect(result.hits.map((h) => h.source)).toEqual(['b']);
    });
  });

  describe('límite', () => {
    it('un PAN conocido DENTRO de una cifra más larga se encuentra (capa de PAN conocidos), aunque la capa genérica no lo vea', () => {
      expect(scanText('t', `id=99${VISA}99`).map((h) => h.kind)).toEqual(['known_pan']);
    });

    it('no son tarjetas: epoch en milisegundos, fechas, UUID, ids largos, importes y la hora', () => {
      const log = '{"level":30,"time":1793166505866,"req":{"id":"8d8670ca-e2f2-4106-926b-ebad7a8f6826"},"created_at":"2026-10-28T05:48:50.498Z","amount_minor":10000,"ledger":"340282366920938463463374607431768211455"}';
      expect(scanText('log', log, [])).toEqual([]);
    });

    it('una tira de 20 dígitos o más no se parte en ventanas (evita el ruido de ids numéricos largos)', () => {
      expect(scanText('t', `4${'1'.repeat(19)}`, [])).toEqual([]);
      expect(scanText('t', '4111111111111111111', [])).toEqual([]); // 19 dígitos: Luhn mal a propósito
    });

    it('los extremos de 13 y 19 dígitos se evalúan (Visa de 13 y de 19 con Luhn válido)', () => {
      expect(scanText('t', 'v 4222222222222 v', [])).toHaveLength(1); // Visa de 13
      expect(scanText('t', 'v 4000000000000000006 v', [])).toHaveLength(1); // Visa de 19
    });

    it('rinde: 100 KB de dígitos y 2 MB de texto se escanean en menos de 2 s', () => {
      const text = `${'7'.repeat(100_000)} ${'texto de relleno con id 12345 y fecha 2026-10-28 '.repeat(40_000)}`;
      const started = Date.now();
      expect(scanText('grande', text)).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe('inválido', () => {
    it('no cuenta: 16 dígitos con Luhn mal, o con un prefijo que no es de tarjeta, o fuera del rango 13–19', () => {
      expect(scanText('t', '4111111111111112', [])).toEqual([]); // Luhn mal
      expect(scanText('t', '9111111111111116', [])).toEqual([]); // prefijo que no es de marca (y Luhn)
      expect(scanText('t', '411111111111', [])).toEqual([]); // 12 dígitos
      expect(scanText('t', '41111111111111111111', [])).toEqual([]); // 20 dígitos
    });

    it('un texto vacío o sin dígitos no da hallazgos, y luhnValid rechaza lo que no son dígitos', () => {
      expect(scanText('t', '', [])).toEqual([]);
      expect(scanText('t', 'solo letras', [])).toEqual([]);
      expect(luhnValid('')).toBe(false);
      expect(luhnValid('41111111111111x1')).toBe(false);
    });

    it('un PAN conocido partido por otro carácter (coma, barra) no se da por encontrado: solo cuentan los separadores de verdad', () => {
      expect(scanText('t', '4111,1111,1111,1111', [VISA])).toEqual([]);
    });
  });
});
