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
    '{"amount_minor":9007199254740991}', // 16 dígitos, no cumple Luhn
    '{"card_token":"tok_c92215200m49abcdef"}',
    '{"ref":"1234567890123456"}',
    '{"phone":"71234567"}',
    `{"n":4111111111111112}`, // un dígito cambiado: no es Luhn
    '{"ts":"2026-10-27T15:00:00.000Z"}',
    '{"a":"123456789012"}', // 12 dígitos: debajo del mínimo
    '{"a":"41111111111111111111"}', // 20 dígitos: arriba del máximo
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
