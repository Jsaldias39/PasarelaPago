import { scrubSpanAttributes, scrubUrl } from '../src/observability/scrub';

// Regla 90.2: la URL de un span no puede llevar PAN, CVV, documento ni nombre. Tres niveles.
const PAN = '4111111111111111';

describe('scrubUrl', () => {
  it('correcto: rutas con forma de id o de nombre se conservan; la query desaparece', () => {
    expect(scrubUrl('/charges/ch_abcdefghij12/status?refresh=true')).toBe('/charges/ch_abcdefghij12/status');
    expect(scrubUrl('/health/ready')).toBe('/health/ready');
  });
  it('límite: una URL absoluta conserva el origen y limpia la ruta; sin ruta o con basura no revienta', () => {
    expect(scrubUrl(`http://127.0.0.1:3104/qr/${PAN}?cvv=0731`)).toBe('http://127.0.0.1:3104/qr/:x');
    expect(scrubUrl('http://localhost')).toBe('http://localhost/');
    expect(scrubUrl('http://[::1')).toBe(':x');
    expect(scrubUrl('')).toBe('');
  });
  it('inválido: PAN (continuo, con espacios codificados), documento y nombre en la ruta o en la query NO sobreviven', () => {
    for (const hostile of [`/charges/${PAN}`, '/charges/4111%201111%201111%201111', `/x?pan=${PAN}&doc=CI-7654321-SCAN`, '/transfers/Sentinela%20Pagadora%20Nandu', '/qr/CI-7654321-SCAN/image?name=Juan']) {
      expect(scrubUrl(hostile)).not.toMatch(/4111|7654321|Sentinela|Juan|pan=|name=|cvv/);
    }
  });
});

describe('scrubSpanAttributes', () => {
  it('reemplaza los atributos de URL de cualquier instrumentación y deja intactos los demás', () => {
    const attributes: Record<string, unknown> = {
      'http.target': `/charges/${PAN}?cvv=0731`,
      'http.url': `http://127.0.0.1:3103/charges/${PAN}?cvv=0731`,
      'url.full': `http://127.0.0.1:3103/charges/${PAN}?cvv=0731`,
      'url.path': `/charges/${PAN}`,
      'url.query': `cvv=0731&pan=${PAN}`,
      'http.request.method': 'GET',
      'http.route': '/charges/:id',
      'db.statement': 'SELECT 1',
      'http.status_code': 200,
    };
    scrubSpanAttributes(attributes);
    expect(JSON.stringify(attributes)).not.toMatch(/4111|0731/);
    expect(attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/charges/:id', 'db.statement': 'SELECT 1', 'http.status_code': 200, 'url.query': '' });
  });
  it('atributos ausentes o que no son texto no rompen nada', () => {
    const attributes: Record<string, unknown> = { 'url.full': 5, 'http.target': undefined };
    expect(() => scrubSpanAttributes(attributes)).not.toThrow();
    expect(attributes['url.full']).toBe(5);
  });
});
