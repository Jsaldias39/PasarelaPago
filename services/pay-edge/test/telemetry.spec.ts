import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { URL_PATH_ATTRIBUTES, URL_QUERY_ATTRIBUTES } from '@pay/idempotency';
import { MaskingTraceExporter } from '../src/observability/telemetry';

/**
 * Lo que llega a un span lo escribe el cliente: una ruta o una query con un PAN o un documento NO puede salir hacia el colector (regla 6 del repo). El
 * enmascarado y la lista de atributos son COMPARTIDOS (`@pay/idempotency`, `url-mask.ts`, probados atributo por atributo); acá se prueba que el exportador del
 * servicio los aplica a TODOS los spans justo antes de exportar.
 */
describe('telemetry — los spans salen con la ruta y la query enmascaradas', () => {
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
  const exporter = () => new MaskingTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' });

  it('CORRECTO: una ruta sin datos se conserva', () => {
    const attributes: Record<string, unknown> = { 'url.path': '/v1/payment_intents/pi_abcdefghij12', 'http.method': 'GET' };
    exporter().export([{ attributes }] as unknown as Spans, () => undefined);
    expect(attributes).toEqual({ 'url.path': '/v1/payment_intents/pi_abcdefghij12', 'http.method': 'GET' });
  });

  it('LÍMITE: PAN y documentos en TODOS los atributos de URL conocidos (ruta y query) salen enmascarados; los demás atributos no se tocan', () => {
    const attributes: Record<string, unknown> = { 'http.method': 'GET', 'db.system': 'postgresql' };
    for (const key of URL_PATH_ATTRIBUTES) attributes[key] = '/v1/pan-4111-1111-1111-1111/nit_1023456028?x=1234567';
    for (const key of URL_QUERY_ATTRIBUTES) attributes[key] = 'tarjeta=4111111111111111&nit=1023456028';
    exporter().export([{ attributes }] as unknown as Spans, () => undefined);
    expect(exported).toBeDefined();
    const out = JSON.stringify((exported as unknown as { attributes: unknown }[])[0]!.attributes);
    expect(out).not.toMatch(/4111|1023456028|1234567/);
    expect(attributes).toMatchObject({ 'http.method': 'GET', 'db.system': 'postgresql' });
  });

  it('INVÁLIDO: un atributo que no es texto, o un span sin atributos de ruta, no lanza', () => {
    expect(() => exporter().export([{ attributes: { 'url.path': 42 } }, { attributes: {} }] as unknown as Spans, () => undefined)).not.toThrow();
  });
});
