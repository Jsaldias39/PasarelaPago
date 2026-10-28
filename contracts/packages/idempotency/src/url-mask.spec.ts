import { maskSpanAttributes, maskUrl, safeUrl, URL_PATH_ATTRIBUTES, URL_QUERY_ATTRIBUTES } from './url-mask';

/** Datos SINTÉTICOS: 4111…1111 es el PAN de prueba público; el NIT y la CI son inventados. */
const PAN = '4111111111111111';
const NIT = '1023456028';
const CI = '1234567';
const CI_COMPLEMENTO = '7654321-1A';
const LEAKS = [PAN, '4111', NIT, CI, '7654321', '1A'];
const leaks = (text: string) => LEAKS.filter((leak) => text.includes(leak));

describe('safeUrl — nivel CORRECTO: rutas y ids de la pasarela se conservan', () => {
  it.each([
    '/v1/payment_intents/pi_abcdefghij12/cancel',
    '/v1/payment_intents/pi_1a72d49b631fe6c9e1824b6b',
    '/v1/api_keys/key_a1b2c3d4e5',
    '/v1/webhook_endpoints/we_ab12cd34ef',
    '/v1/webhook_endpoints/we_abcdefghij/rotate_secret',
    '/health/ready',
    '/',
    '',
  ])('%s', (url) => {
    expect(safeUrl(url)).toBe(url);
  });
});

describe('safeUrl — nivel LÍMITE: PAN, NIT, CI, correos y nombres se enmascaran', () => {
  it.each([
    ['PAN', `/v1/${PAN}`],
    ['PAN con espacios codificados', '/v1/4111%201111%201111%201111'],
    ['PAN con guiones', '/v1/4111-1111-1111-1111'],
    ['PAN con prefijo y guiones', '/v1/pan-4111-1111-1111-1111'],
    ['PAN con prefijo y guiones bajos', '/v1/tarjeta_4111_1111_1111_1111'],
    ['PAN en mayúsculas', `/v1/PAN${PAN}`],
    ['PAN con puntos', '/v1/pan.4111.1111.1111.1111'],
    ['PAN pegado a un id propio', `/v1/payment_intents/pi_a${PAN}`],
    ['NIT de 10 dígitos', `/v1/${NIT}`],
    ['NIT con prefijo nit_', `/v1/nit_${NIT}`],
    ['NIT con prefijo y guion', `/v1/NIT-${NIT}`],
    ['NIT con prefijo y guiones', '/v1/nit-123-456-789'],
    ['CI de 7 dígitos', `/v1/${CI}`],
    ['CI con complemento', `/v1/${CI_COMPLEMENTO}`],
    ['CI con prefijo', '/v1/ci1234567'],
    ['CI de 5 dígitos', '/v1/12345'],
    ['id propio solo con dígitos', `/v1/payment_intents/pi_${NIT}`],
    ['correo', '/v1/ana@correo.com'],
    ['nombre con mayúsculas y espacios', '/v1/Juan%20P%C3%A9rez'],
    ['teléfono', '/v1/71234567'],
    ['recorrido de rutas', '/v1/../../etc/passwd'],
    ['segmento larguísimo', `/v1/${'a'.repeat(200)}`],
  ])('%s', (_name, url) => {
    expect(leaks(safeUrl(url))).toEqual([]);
    expect(safeUrl(url)).toMatch(/:x/);
  });

  it('la query y el fragmento nunca se conservan', () => {
    expect(safeUrl(`/v1/payouts?limit=5&email=ana@correo.com&card=${PAN}&nit=${NIT}`)).toBe('/v1/payouts');
    expect(safeUrl(`/v1/payouts#${PAN}`)).toBe('/v1/payouts');
  });
});

describe('safeUrl y maskUrl — nivel INVÁLIDO: entradas raras no lanzan', () => {
  it('no lanzan y siempre devuelven texto', () => {
    for (const url of ['', '?x=1', '//', '/%', '\u0000', 'sin barra', 'http://', 'http://[::1', 'ht!tp://x', `http://u:p@host:99999999/${PAN}`, '/'.repeat(10_000), `/${'9'.repeat(100_000)}`]) {
      expect(typeof safeUrl(url)).toBe('string');
      expect(typeof maskUrl(url)).toBe('string');
    }
  });

  it('una URL absoluta conserva esquema y host, pierde credenciales, query y datos de la ruta', () => {
    expect(maskUrl(`https://svc.interno:3000/v1/refunds/${CI_COMPLEMENTO}?x=${PAN}`)).toBe('https://svc.interno:3000/v1/refunds/:x');
    expect(maskUrl(`http://usuario:secreto@host/v1/${NIT}`)).toBe('http://host/v1/:x');
    expect(maskUrl('http://[::1')).toBe(':x');
  });
});

describe('maskSpanAttributes — recorre TODOS los atributos de URL conocidos de OpenTelemetry', () => {
  it('la lista cubre url.* y http.* conocidos (control del instrumento: si alguien la acorta, esto avisa)', () => {
    for (const key of ['url.path', 'url.full', 'url.original', 'url.query', 'http.target', 'http.url', 'http.route', 'http.path', 'http.query']) {
      expect([...URL_PATH_ATTRIBUTES, ...URL_QUERY_ATTRIBUTES]).toContain(key);
    }
  });

  it.each(URL_PATH_ATTRIBUTES.map((key) => [key]))('CORRECTO/LÍMITE · %s: la ruta con PAN, NIT y CI sale enmascarada, absoluta o relativa', (key) => {
    for (const value of [`/v1/payment_intents/${PAN}`, `/v1/merchants/${NIT}/keys`, `/v1/refunds/${CI_COMPLEMENTO}?nit=${NIT}`, `https://svc:3000/v1/x/${PAN}?card=${PAN}`, `/v1/nit_${NIT}/${CI}`]) {
      const attributes: Record<string, unknown> = { [key]: value, 'http.method': 'GET', 'db.system': 'postgresql' };
      maskSpanAttributes(attributes);
      expect(leaks(JSON.stringify(attributes))).toEqual([]);
      expect(attributes).toMatchObject({ 'http.method': 'GET', 'db.system': 'postgresql' });
    }
    const clean: Record<string, unknown> = { [key]: '/v1/payment_intents/pi_abcdefghij12' };
    maskSpanAttributes(clean);
    expect(clean[key]).toBe('/v1/payment_intents/pi_abcdefghij12');
  });

  it.each(URL_QUERY_ATTRIBUTES.map((key) => [key]))('LÍMITE · %s: la query NUNCA se conserva', (key) => {
    const attributes: Record<string, unknown> = { [key]: `documento=${NIT}&tarjeta=${PAN}` };
    maskSpanAttributes(attributes);
    expect(attributes[key]).toBe('[redacted]');
  });

  it('cualquier OTRO atributo url.* o http.* de texto con un número de tarjeta se redacta; sin él, no se toca', () => {
    const attributes: Record<string, unknown> = { 'http.user_agent': `curl card=${PAN}`, 'http.request.header.referer': `https://x/?c=${PAN}`, 'url.scheme': 'https', 'http.status_code': 200, 'net.peer.ip': PAN };
    maskSpanAttributes(attributes);
    expect(attributes).toEqual({ 'http.user_agent': '[redacted]', 'http.request.header.referer': '[redacted]', 'url.scheme': 'https', 'http.status_code': 200, 'net.peer.ip': PAN });
  });

  it('INVÁLIDO: valores que no son texto o atributos ausentes no lanzan', () => {
    expect(() => maskSpanAttributes({ 'url.path': 42, 'url.query': undefined, 'http.url': null, 'http.target': { a: 1 } })).not.toThrow();
    expect(() => maskSpanAttributes({})).not.toThrow();
  });
});
