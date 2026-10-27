import { containsCardNumber, inspectBody } from '../src/proxy/pan-guard';
import { startEdge, type EdgeHarness } from './harness';

/**
 * Defensa en profundidad PCI: ningún número de tarjeta atraviesa el borde, ni siquiera disfrazado. Los números son los de PRUEBA
 * públicos de las marcas. Tres niveles: CORRECTO (cuerpo limpio), LÍMITE (disfraces válidos de un PAN) e INVÁLIDO (JSON roto).
 */
const b = (text: string) => Buffer.from(text, 'utf8');
const VISA = '4111111111111111';

/** Agrega el dígito de control Luhn: arma un número válido de la longitud pedida. */
function withLuhn(prefix: string): string {
  for (let check = 0; check < 10; check += 1) {
    const candidate = `${prefix}${check}`;
    let sum = 0;
    let double = false;
    for (let i = candidate.length - 1; i >= 0; i -= 1) {
      let n = Number(candidate[i]);
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('imposible');
}

describe('inspectBody — nivel CORRECTO: lo limpio pasa', () => {
  it.each([
    '{"amount_minor":10000,"currency":"BOB"}',
    '{"card_token":"tok_c92215200m49abcdef"}',
    '{"phone":"71234567"}',
    '{"ts":"2026-10-27T15:00:00.000Z"}',
    '{"a":"123456789012"}', // 12 dígitos: debajo del mínimo
    '{"lista":[1,2,3],"anidado":{"x":{"y":["a","b"]}}}',
    '{"nota":"orden 4111 y luego 1111 en otro campo"}',
    '[]',
    '{}',
    'null',
    '"texto"',
    '',
  ])('%p', (body) => {
    expect(inspectBody(b(body))).toBe('clean');
    expect(containsCardNumber(b(body))).toBe(false);
  });

  it('un cuerpo grande de dígitos no tarda (sin retroceso catastrófico)', () => {
    const started = Date.now();
    expect(inspectBody(b(`{"a":"${'9'.repeat(900_000)}"}`))).toBe('clean');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('un anidamiento de 300.000 niveles no revienta la pila (recorrido iterativo)', () => {
    const depth = 300_000;
    const body = b(`${'['.repeat(depth)}1${']'.repeat(depth)}`);
    expect(() => inspectBody(body)).not.toThrow();
  });
});

describe('inspectBody — nivel LÍMITE: el PAN disfrazado se detecta', () => {
  const cases: [string, string][] = [
    ['texto plano', `{"card":"${VISA}"}`],
    ['como NÚMERO JSON', `{"card":${VISA}}`],
    ['como número en notación científica', '{"card":4.111111111111111e15}'],
    ['como número entero muy grande (> 2^53, pierde precisión al decodificar)', '{"card":6011111111111117}'],
    ['escapes \\uXXXX de todos los dígitos', String.raw`{"card":"4111111111111111"}`],
    ['escapes \\uXXXX solo en algunos dígitos', String.raw`{"card":"4\u0031\u0031` + '1'.repeat(13) + '"}'],
    ['escapes con mayúsculas en hexadecimal', String.raw`{"card":"4111111111111111"}`],
    ['escape \\/ y \\u0020 como separadores', String.raw`{"card":"4111 1111 1111 1111"}`],
    ['espacios', '{"card":"4111 1111 1111 1111"}'],
    ['guiones', '{"card":"4111-1111-1111-1111"}'],
    ['puntos', '{"card":"4111.1111.1111.1111"}'],
    ['barras y guiones bajos', '{"card":"4111/1111_1111/1111"}'],
    ['espacio no separable (U+00A0)', '{"card":"4111 1111 1111 1111"}'],
    ['guion largo (U+2013) y signo menos (U+2212)', '{"card":"4111–1111−1111–1111"}'],
    ['tabulación y salto de línea', String.raw`{"card":"4111\t1111\n1111\r1111"}`],
    ['dígitos de ANCHO COMPLETO', '{"card":"４１１１１１１１１１１１１１１１"}'],
    ['caracteres de ancho cero entre dígitos', '{"card":"4111​1111‍1111­1111"}'],
    ['en el NOMBRE de un campo', `{"${VISA}":"x"}`],
    ['en el nombre de un campo con escapes', String.raw`{"4111111111111111":"x"}`],
    ['anidado en objetos', `{"a":{"b":{"c":{"pago":"${VISA}"}}}}`],
    ['anidado en listas', `{"a":[[["x"],[{"y":["${VISA}"]}]]]}`],
    ['dentro de una frase', `{"nota":"pagar con ${VISA} gracias"}`],
    ['dentro de una frase con separadores', '{"nota":"mi tarjeta es 4111 1111 1111 1111, gracias"}'],
    ['lista de números sueltos (uno por elemento) NO es un PAN, pero el entero sí', `{"a":[${VISA}]}`],
    ['Mastercard', '{"c":"5500 0000 0000 0004"}'],
    ['Amex (15)', '{"c":"3400-000000-00009"}'],
    ['Visa de 13 dígitos', '{"c":"4222222222222"}'],
    ['19 dígitos', '{"c":"6759649826438453"}'],
    ['JSON con espacios y saltos alrededor', `\n  {  "card"  :  "${VISA}"  }\n`],
    ['BOM al inicio no esconde nada (el texto sigue siendo JSON válido sin BOM tras quitarlo)', `{"card":"${VISA}"}`],
  ];
  it.each(cases)('%s', (_name, body) => {
    expect(inspectBody(b(body))).toBe('card_number');
  });

  it.each([13, 14, 15, 16, 17, 18, 19])('un número de %i dígitos con Luhn válido se detecta, con y sin separadores', (length) => {
    const pan = withLuhn('4'.repeat(length - 1));
    expect(pan).toHaveLength(length);
    expect(inspectBody(b(`{"c":"${pan}"}`))).toBe('card_number');
    expect(inspectBody(b(`{"c":"${pan.replace(/(.{4})/g, '$1 ')}"}`))).toBe('card_number');
  });
});

describe('inspectBody — nivel INVÁLIDO: JSON roto', () => {
  it.each(['{', '{"a":', '{"a":1,}', '[1,2', 'undefined', '{a:1}', "{'a':1}", '{"a":"sin cerrar}', '\u0000', 'hola', `{"card":"${VISA}"`])('%p ⇒ invalid_json', (body) => {
    expect(inspectBody(b(body))).toBe('invalid_json');
  });

  it('un PAN dentro de un JSON roto igual se rechaza (no se reenvía lo que no se puede interpretar)', () => {
    expect(inspectBody(b(`{"card":"${VISA}"`))).toBe('invalid_json');
  });

  it('no lanza nunca, ni con bytes que no son UTF-8', () => {
    expect(() => inspectBody(Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]))).not.toThrow();
    expect(inspectBody(Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80]))).toBe('invalid_json');
  });
});

describe('inspectBody — claves duplicadas y corridas de separadores', () => {
  const pan13 = withLuhn('4'.repeat(12));
  const pan19 = withLuhn('4'.repeat(18));
  const spaced = (pan: string, separator: string) => pan.replace(/(.{4})(?=.)/g, `$1${separator}`);

  it.each([
    ['PAN en la primera y valor inocente en la última', `{"card":"${VISA}","card":"x"}`],
    ['PAN en la última', `{"card":"x","card":"${VISA}"}`],
    ['PAN en el del medio de tres', `{"card":"a","card":"${VISA}","card":"b"}`],
    ['duplicada y anidada', `{"a":{"card":"${VISA}","card":null},"b":1}`],
    ['duplicada con el valor como número', `{"card":${VISA},"card":1}`],
    ['duplicada dentro de una lista de objetos', `[{"n":"${VISA}","n":"z"},{"n":"ok"}]`],
    ['duplicada con escapes en el valor', String.raw`{"card":"4111111111111111","card":"x"}`],
    ['duplicada con escapes en el NOMBRE de la clave', String.raw`{"card":"${VISA}","card":"x"}`],
  ])('claves duplicadas — %s', (_name, body) => {
    expect(inspectBody(b(body))).toBe('card_number');
  });

  it.each([
    ['2 espacios', '  '],
    ['3 espacios', '   '],
    ['espacio y guion', ' - '],
    ['punto, espacio y guion', '. -'],
    ['5 separadores mezclados', ' .-_/'],
    ['guion largo y espacio no separable', '–  '],
    ['tabulaciones y saltos', String.raw`\t\n `],
    ['signo menos y barra', '−/'],
  ])('separadores — %s entre cada grupo', (_name, separator) => {
    expect(inspectBody(b(`{"c":"${spaced(VISA, separator)}"}`))).toBe('card_number');
  });

  it.each([
    ['2 espacios', '4111  1111  1111  1111'],
    ['punto, espacio y guion', '4111. -1111. -1111. -1111'],
    ['un dígito por vez, con espacios', '4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1'],
    ['separador al principio y al final', '  - 4111 1111 1111 1111 -  '],
  ])('separadores — %s', (_name, value) => {
    expect(inspectBody(b(`{"c":"${value}"}`))).toBe('card_number');
  });

  it('escapes COMBINADOS con corridas de separadores y con claves duplicadas', () => {
    const body = String.raw`{"c":"41 . -11   1111–– 1111 . 1111","c":"x"}`;
    expect(inspectBody(b(body))).toBe('card_number');
  });

  it('13 y 19 dígitos (los extremos), pegados y con separadores mezclados', () => {
    for (const pan of [pan13, pan19]) {
      expect(inspectBody(b(`{"c":"${pan}"}`))).toBe('card_number');
      expect(inspectBody(b(`{"c":"${spaced(pan, ' .- ')}"}`))).toBe('card_number');
    }
    // 12 dígitos quedan fuera (un PAN mide 13 a 19)
    expect(inspectBody(b(`{"c":"${withLuhn('4'.repeat(11))}"}`))).toBe('clean');
  });

  it('un número con exponente y un número enorme se detectan por su texto', () => {
    expect(inspectBody(b('{"c":4.111111111111111e15,"c":0}'))).toBe('card_number');
    expect(inspectBody(b(`{"c":${pan19},"c":0}`))).toBe('card_number');
  });

  it.each([
    '{"amount_minor":1500,"currency":"BOB","fecha":"2026-10-27","hora":"15:00:00.000"}',
    '{"a":"12 34 56","b":"78-90","c":"1.2.3.4.5"}',
    '{"telefono":"+591 7123 4567"}', // 11 dígitos: debajo del mínimo de un PAN
    '{"ip":"192.168.100.200","version":"1.2.3"}',
    '{"x":1,"x":2,"x":3}', // claves duplicadas inocentes
    '{"a":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]}', // muchos números chicos seguidos
    '{"cuotas":"1 2 3 4 5 6 7 8 9 10 11 12"}', // sin Luhn de 13+ dígitos
    '{"orden":"0000 0000 0000 0000"}', // 16 ceros: Luhn válido pero no es un PAN: ver abajo
  ])('CORRECTO — números que no son PAN pasan: %s', (body) => {
    // Los 16 ceros cumplen Luhn por definición; se rechaza a propósito (conservador). El resto debe pasar.
    const expected = body.includes('0000 0000 0000 0000') ? 'card_number' : 'clean';
    expect(inspectBody(b(body))).toBe(expected);
  });

  it.each([
    '{"card":"4111 1111 1111 1111","card":',
    '{"card":"x","card":"4111111111111111"',
    '{"card":"4111111111111111",}',
    '{"a":"\\x41"}', // escape inválido
    '{"a":"\u0001"}', // carácter de control sin escapar
    "{'card':'4111111111111111'}",
  ])('INVÁLIDO — JSON mal formado %p ⇒ invalid_json (nunca lanza)', (body) => {
    expect(() => inspectBody(b(body))).not.toThrow();
    expect(inspectBody(b(body))).toBe('invalid_json');
  });
});

/** Referencia ingenua e independiente: prueba TODAS las ventanas de 13 a 19 dígitos de una corrida, una por una. */
function bruteForceHasWindow(digits: string): boolean {
  const luhnOk = (d: string) => {
    let sum = 0;
    let double = false;
    for (let i = d.length - 1; i >= 0; i -= 1) {
      let n = Number(d[i]);
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    return sum % 10 === 0;
  };
  for (let length = 13; length <= 19; length += 1) for (let start = 0; start + length <= digits.length; start += 1) if (luhnOk(digits.slice(start, start + length))) return true;
  return false;
}

/** PRNG determinista (xorshift32) para que las tasas y las propiedades sean reproducibles. */
function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
}
const randomDigits = (next: () => number, length: number) => Array.from({ length }, () => String(Math.floor(next() * 10))).join('');

/** Una corrida de `length` dígitos SIN ninguna ventana Luhn (se busca con la referencia ingenua). */
function runWithoutWindow(length: number): string {
  const next = prng(12345 + length);
  for (let i = 0; i < 100_000; i += 1) {
    const candidate = randomDigits(next, length);
    if (!bruteForceHasWindow(candidate)) return candidate;
  }
  throw new Error(`no hay corrida limpia de ${length} dígitos`);
}

describe('inspectBody — ventana deslizante (un PAN pegado a otros dígitos no se esconde)', () => {
  it.each([
    ['dígitos y barra antes (ejemplo del hallazgo)', '12 / 4111 1111 1111 1111'],
    ['un dígito suelto después (ejemplo del hallazgo)', '4111111111111111 - 7'],
    ['antes y después', '12345 4111 1111 1111 1111 98765'],
    ['pegado sin separador al número anterior', '0004111111111111111'],
    ['pegado sin separador al siguiente', '41111111111111119999'],
    ['con separadores mezclados por ambos lados', '99 . - 4111  1111_1111/1111 -.- 55'],
    ['partido en dos corridas por una letra: la corrida con el PAN se detecta', 'ref A 12 4111 1111 1111 1111 B 34'],
  ])('%s', (_name, value) => {
    expect(inspectBody(b(`{"c":"${value}"}`))).toBe('card_number');
    expect(inspectBody(b(`{"c":"${value}","c":"x"}`))).toBe('card_number');
    expect(inspectBody(b(`{"a":[{"b":["${value}"]}]}`))).toBe('card_number');
  });

  it('como número JSON, con dígitos antes y después, el entero se detecta por su texto', () => {
    expect(inspectBody(b(`{"c":12${VISA}}`))).toBe('card_number');
    expect(inspectBody(b(`{"c":${VISA}7}`))).toBe('card_number');
  });

  it.each([13, 14, 15, 16, 17, 18, 19])('un PAN de %i dígitos EXACTOS dentro de una corrida más larga', (length) => {
    const pan = withLuhn('5'.repeat(length - 1));
    for (const [before, after] of [['', ''], ['7', ''], ['', '3'], ['90210', '12345'], ['1'.repeat(40), '8'.repeat(40)]]) {
      expect(inspectBody(b(`{"c":"${before}${pan}${after}"}`))).toBe('card_number');
    }
  });

  it('PROPIEDAD: el resultado coincide con la referencia ingenua en 4.000 corridas aleatorias (largos 1 a 48, con separadores)', () => {
    const next = prng(20261027);
    for (let i = 0; i < 4000; i += 1) {
      const length = 1 + Math.floor(next() * 48);
      const digits = randomDigits(next, length);
      const spaced = digits.replace(/(\d)(?=\d)/g, (d) => (next() < 0.25 ? `${d}${[' ', ' - ', '. ', '/'][Math.floor(next() * 4)]}` : d));
      expect(inspectBody(b(`{"c":"${spaced}"}`))).toBe(bruteForceHasWindow(digits) ? 'card_number' : 'clean');
    }
  });

  it.each([12, 13, 16, 19, 20, 24])('CORRECTO: una corrida de %i dígitos sin ninguna ventana Luhn pasa', (length) => {
    const run = runWithoutWindow(length);
    expect(inspectBody(b(`{"id":"${run}"}`))).toBe('clean');
    if (run[0] !== '0') expect(inspectBody(b(`{"id":${run}}`))).toBe('clean'); // un número JSON no empieza con 0
  });

  it('CORRECTO: identificadores con letras, fechas, importes y teléfonos (corridas de menos de 13 dígitos) pasan', () => {
    for (const body of [
      '{"payment_intent_id":"pi_c92215200m49","merchant_id":"mc_5c048c31m1fb"}',
      '{"fecha":"2026-10-27T15:00:00.000Z","hasta":"27/10/2026 15:00"}',
      '{"amount_minor":123456789012,"fee_minor":300}',
      '{"tel":"+591 7123 4567","nit":"1020304050"}',
      '{"uuid":"6f1f0a52-0d1c-4f4a-9a52-1f5a8c2f3a10"}',
      '{"ip":"192.168.100.200","semver":"10.20.30"}',
    ]) expect(inspectBody(b(body))).toBe('clean');
  });

  it('TASAS de falso positivo: cadenas numéricas AL AZAR (no tarjetas) que el borde rechaza, por largo de la corrida', () => {
    const rows: string[] = [];
    const rates = new Map<number, number>();
    for (const length of [12, 13, 14, 15, 16, 17, 18, 19, 20, 25, 30, 40]) {
      const next = prng(777 + length);
      const samples = 5000;
      let flagged = 0;
      for (let i = 0; i < samples; i += 1) if (inspectBody(b(`{"c":"${randomDigits(next, length)}"}`)) === 'card_number') flagged += 1;
      rates.set(length, flagged / samples);
      rows.push(`${String(length).padStart(2)} dígitos: ${((flagged / samples) * 100).toFixed(1).padStart(5)} % rechazadas`);
    }
    if (process.env.PAN_RATES) process.stdout.write(`TASAS (5.000 cadenas al azar por largo, semilla fija)\n  ${rows.join('\n  ')}\n`);
    expect(rates.get(12)).toBe(0); // menos de 13 dígitos nunca es un PAN
    expect(rates.get(13)!).toBeGreaterThan(0.06);
    expect(rates.get(13)!).toBeLessThan(0.14); // ≈ 1 de cada 10: una sola ventana
    expect(rates.get(16)!).toBeGreaterThan(0.5);
    expect(rates.get(16)!).toBeLessThan(0.8);
    expect(rates.get(25)!).toBeGreaterThan(0.95);
    expect(rates.get(40)!).toBeGreaterThan(0.99);
  });

  describe('costo: sin cuelgue ni retroceso catastrófico', () => {
    const timed = (body: string) => {
      const started = Date.now();
      const verdict = inspectBody(b(body));
      return { verdict, ms: Date.now() - started };
    };

    it.each([
      ['900.000 dígitos en una cadena', () => `{"a":"${'7'.repeat(900_000)}"}`],
      ['900.000 dígitos que nunca cierran una ventana válida por construcción (todos ceros menos el final)', () => `{"a":"${'0'.repeat(899_999)}1"}`],
      ['450.000 dígitos separados por espacios', () => `{"a":"${'1 '.repeat(450_000)}"}`],
      ['separadores mezclados sin fin', () => `{"a":"${'1 - . _ / '.repeat(90_000)}"}`],
      ['un solo dígito y 900.000 separadores', () => `{"a":"1${' '.repeat(900_000)}2"}`],
      ['un número JSON de 900.000 dígitos', () => `{"a":${'3'.repeat(900_000)}}`],
    ])('%s', (_name, build) => {
      const { verdict, ms } = timed(build());
      expect(['clean', 'card_number']).toContain(verdict);
      expect(ms).toBeLessThan(3000);
    });

    it('corridas de 40+ dígitos (muchas, en una lista) tardan lo mismo que una', () => {
      const body = `{"a":[${Array.from({ length: 5000 }, () => `"${'8'.repeat(48)}"`).join(',')}]}`;
      const { ms } = timed(body);
      expect(ms).toBeLessThan(3000);
    });
  });
});

describe('pay-edge rechaza el PAN y el JSON roto', () => {
  let h: EdgeHarness;
  let token: string;
  beforeAll(async () => {
    h = await startEdge();
    const key = await h.seedKey();
    token = key.token;
    h.doubles['pay-payments'].own(key.merchantId, 'pi_abcdefghij12');
  });
  afterAll(async () => h.stop());
  afterEach(() => (h.doubles['pay-payments'].requests.length = 0));

  const post = (body: string, key = 'clave-de-idempotencia-0001') =>
    h.http().post('/v1/payment_intents').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).set('Content-Type', 'application/json').send(body);

  it('CORRECTO: un cobro con card_token pasa y llega al servicio', async () => {
    const res = await post('{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","card_token":"tok_c92215200m49abcdef"}}');
    expect(res.status).toBe(201);
    expect(h.doubles['pay-payments'].requests).toHaveLength(1);
  });

  it.each([
    ['plano', `{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","number":"${VISA}"}}`],
    ['con escapes \\uXXXX', String.raw`{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","number":"4111111111111111"}}`],
    ['con separadores', '{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","number":"4111 1111 1111 1111"}}'],
    ['como número JSON', `{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card","number":${VISA}}}`],
    ['anidado en una lista', `{"amount_minor":1000,"currency":"BOB","payment_method":{"type":"card"},"extra":[[{"n":"${VISA}"}]]}`],
  ])('LÍMITE (%s): 422 card_number_detected, NO llega al servicio y la respuesta no repite ningún dígito del número', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual([{ field: 'body', code: 'card_number_detected', message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toMatch(/4111|1111|\\u0034/);
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
    h.contract.assertResponse({ method: 'POST', path: '/payment_intents', status: 422, body: res.body });
  });

  it.each(['{', '{"amount_minor":1000,', `{"card":"${VISA}"`, '{"a":1,}'])('INVÁLIDO (%p): 422 invalid_json, nunca 500, sin eco del cuerpo y sin llegar al servicio', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(res.body.errors).toEqual([{ field: 'body', code: 'invalid_json', message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toMatch(/4111|Unexpected|position/);
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
    h.contract.assertResponse({ method: 'POST', path: '/payment_intents', status: 422, body: res.body });
  });

  it.each([
    ['clave duplicada con el PAN primero', `{"amount_minor":1000,"currency":"BOB","n":"${VISA}","n":"x"}`],
    ['clave duplicada con el PAN último', `{"amount_minor":1000,"currency":"BOB","n":"x","n":"${VISA}"}`],
    ['separadores mezclados', '{"amount_minor":1000,"currency":"BOB","n":"4111 . -1111  1111 _ 1111"}'],
  ])('LÍMITE (%s): 422 card_number_detected y no llega al servicio', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'body', code: 'card_number_detected', message: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toMatch(/4111|1111/);
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
  });

  it.each([
    ['dígitos y barra antes', '12 / 4111 1111 1111 1111'],
    ['un dígito suelto después', '4111111111111111 - 7'],
  ])('LÍMITE (PAN pegado a otros dígitos: %s): 422 card_number_detected y no llega al servicio', async (_name, value) => {
    const res = await post(`{"amount_minor":1000,"currency":"BOB","n":"${value}"}`);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'body', code: 'card_number_detected', message: expect.any(String) }]);
    expect(h.doubles['pay-payments'].requests).toHaveLength(0);
  });

  it('un cuerpo vacío en una mutación sin cuerpo sigue pasando', async () => {
    const res = await h.http().post('/v1/payment_intents/pi_abcdefghij12/cancel').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'clave-de-idempotencia-0009');
    expect(res.status).toBe(200);
  });

  it('el PAN nunca llega a la salida estándar (logs): ni en el rechazo ni en el JSON roto', async () => {
    const logging = await startEdge({ env: { LOG_LEVEL: 'trace' } });
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      writes.push(String(chunk));
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      const k = await logging.seedKey();
      const send = (body: string) =>
        logging.http().post('/v1/payment_intents').set('Authorization', `Bearer ${k.token}`).set('Idempotency-Key', 'clave-de-idempotencia-0002').set('Content-Type', 'application/json').send(body);
      expect((await send(`{"number":"${VISA}"}`)).status).toBe(422);
      expect((await send(String.raw`{"number":"4111111111111111"}`)).status).toBe(422);
      expect((await send(`{"number":"${VISA}"`)).status).toBe(422);
    } finally {
      process.stdout.write = original;
      await logging.stop();
    }
    expect(writes.join('')).not.toMatch(/4111|\\u0034/);
  });
});
