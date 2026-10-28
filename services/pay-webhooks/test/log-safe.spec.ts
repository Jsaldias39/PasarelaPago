import { safeUrl } from '../src/log-safe';

describe('safeUrl — la URL que llega a los logs y a `instance` no puede delatar datos del cliente', () => {
  it('CORRECTO: rutas con nombres e ids de la pasarela se conservan', () => {
    expect(safeUrl('/v1/payment_intents/pi_abcdefghij12/cancel')).toBe('/v1/payment_intents/pi_abcdefghij12/cancel');
    expect(safeUrl('/health/ready')).toBe('/health/ready');
    expect(safeUrl('/')).toBe('/');
  });

  it('nunca incluye la query (puede traer datos personales)', () => {
    expect(safeUrl('/v1/payouts?limit=5&email=ana@correo.com&card=4111111111111111')).toBe('/v1/payouts');
  });

  it.each([
    ['número de tarjeta', '/v1/4111111111111111', '/v1/:x'],
    ['número con separadores codificados', '/v1/4111%201111%201111%201111', '/v1/:x'],
    ['correo', '/v1/ana@correo.com', '/v1/:x'],
    ['nombre con mayúsculas y espacios', '/v1/Juan%20P%C3%A9rez', '/v1/:x'],
    ['teléfono', '/v1/71234567', '/v1/:x'],
    ['segmento con 6+ dígitos seguidos dentro de un id', '/v1/payment_intents/pi_c92215200m49', '/v1/payment_intents/:x'],
    ['PAN con separadores - o _ entre grupos (letra delante)', '/v1/pan-4111-1111-1111-1111', '/v1/:x'],
    ['PAN con guiones bajos', '/v1/tarjeta_4111_1111_1111_1111', '/v1/:x'],
    ['NIT con prefijo y guiones', '/v1/nit-123-456-789', '/v1/:x'],
    ['documento de identidad con prefijo', '/v1/ci1234567', '/v1/:x'],
    ['documento de identidad con separadores', '/v1/ci_1234_567', '/v1/:x'],
    ['documento en el segmento intermedio de una ruta anidada', '/v1/merchants/doc-12-345-678/keys', '/v1/merchants/:x/keys'],
    ['PAN en mayúsculas', '/v1/PAN4111111111111111', '/v1/:x'],
    ['PAN con puntos', '/v1/pan.4111.1111.1111.1111', '/v1/:x'],
    ['recorrido de rutas', '/v1/../../etc/passwd', '/v1/:x/:x/etc/passwd'],
    ['segmento larguísimo', `/v1/${'a'.repeat(200)}`, '/v1/:x'],
  ])('LÍMITE — %s se enmascara', (_name, url, expected) => {
    expect(safeUrl(url)).toBe(expected);
  });

  it('los ids de la pasarela con dígitos y letras mezclados, o con pocos dígitos separados, NO se enmascaran', () => {
    expect(safeUrl('/v1/api_keys/key_a1b2c3d4e5')).toBe('/v1/api_keys/key_a1b2c3d4e5');
    expect(safeUrl('/v1/webhook_endpoints/we_ab12-cd34')).toBe('/v1/webhook_endpoints/we_ab12-cd34');
    expect(safeUrl('/v1/v2-2026')).toBe('/v1/v2-2026');
  });

  it('INVÁLIDO: entradas raras no lanzan', () => {
    for (const url of ['', '?x=1', '//', '/%', '\u0000', 'sin barra']) expect(() => safeUrl(url)).not.toThrow();
  });
});
