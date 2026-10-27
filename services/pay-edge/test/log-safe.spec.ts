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
    ['recorrido de rutas', '/v1/../../etc/passwd', '/v1/:x/:x/etc/passwd'],
    ['segmento larguísimo', `/v1/${'a'.repeat(200)}`, '/v1/:x'],
  ])('LÍMITE — %s se enmascara', (_name, url, expected) => {
    expect(safeUrl(url)).toBe(expected);
  });

  it('INVÁLIDO: entradas raras no lanzan', () => {
    for (const url of ['', '?x=1', '//', '/%', '\u0000', 'sin barra']) expect(() => safeUrl(url)).not.toThrow();
  });
});
