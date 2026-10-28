import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { MaskingTraceExporter, maskUrl } from '../src/observability/telemetry';

/** Lo que llega a un span lo escribe el cliente: una ruta con un PAN o un documento NO puede salir hacia el colector (regla 6 del repo). */
describe('telemetry — los spans salen con la ruta enmascarada', () => {
  type Spans = Parameters<OTLPTraceExporter['export']>[0];
  const parentExport = OTLPTraceExporter.prototype.export;
  let exported: Spans | undefined;
  beforeAll(() => {
    OTLPTraceExporter.prototype.export = function (spans: Spans, cb: Parameters<OTLPTraceExporter['export']>[1]) {
      exported = spans;
      cb({ code: 0 });
    };
  });
  afterAll(() => {
    OTLPTraceExporter.prototype.export = parentExport;
  });

  it('CORRECTO: una ruta sin datos se conserva', () => {
    expect(maskUrl('/v1/payment_intents/pi_abcdefghij12')).toBe('/v1/payment_intents/pi_abcdefghij12');
    expect(maskUrl('http://127.0.0.1:3101/v1/payment_intents')).toBe('http://127.0.0.1:3101/v1/payment_intents');
  });

  it('LÍMITE: PAN, NIT y documento en url.path, url.full, http.target y http.url se enmascaran; los demás atributos no se tocan', () => {
    const attributes: Record<string, unknown> = {
      'url.path': '/v1/4111111111111111/charge',
      'url.full': 'http://127.0.0.1:3101/v1/pan-4111-1111-1111-1111?x=1',
      'http.target': '/v1/nit-123-456-789',
      'http.url': 'http://127.0.0.1:3101/v1/ci1234567',
      'http.method': 'GET',
    };
    new MaskingTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' }).export([{ attributes }] as unknown as Spans, () => undefined);
    expect(exported).toBeDefined();
    const out = JSON.stringify((exported as unknown as { attributes: unknown }[])[0]!.attributes);
    expect(out).not.toMatch(/4111|123-456|1234567/);
    expect(attributes).toMatchObject({ 'url.path': '/v1/:x/charge', 'url.full': 'http://127.0.0.1:3101/v1/:x', 'http.target': '/v1/:x', 'http.url': 'http://127.0.0.1:3101/v1/:x', 'http.method': 'GET' });
  });

  it('INVÁLIDO: un atributo que no es texto, o un span sin atributos de ruta, no lanza', () => {
    expect(() => new MaskingTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' }).export([{ attributes: { 'url.path': 42 } }, { attributes: {} }] as unknown as Spans, () => undefined)).not.toThrow();
  });
});
