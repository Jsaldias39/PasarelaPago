import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { safeUrl } from '../log-safe';

/**
 * La ruta de la petición la escribe el cliente (puede traer un PAN, un NIT o una CI) y varias instrumentaciones la copian a sus spans
 * (`url.path`, `url.full`, `http.target`, `http.url`, `http.route`) y la query en `url.query`. Se enmascara aquí, justo antes de exportar, igual que en el log de acceso.
 */
const URL_ATTRIBUTES = ['url.path', 'url.full', 'http.target', 'http.url', 'http.route'];
/** La query (`?documento=…`) viaja aparte en `url.query` y nunca se conserva (regla 90.2.2). */
const QUERY_ATTRIBUTES = ['url.query', 'http.query'];

export const maskUrl = (value: string): string => {
  const absolute = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(value);
  return absolute ? `${absolute[1]}${safeUrl(absolute[2] ?? '/')}` : safeUrl(value);
};

export class MaskingTraceExporter extends OTLPTraceExporter {
  override export(spans: Parameters<OTLPTraceExporter['export']>[0], resultCallback: Parameters<OTLPTraceExporter['export']>[1]): void {
    for (const span of spans) {
      const attributes = span.attributes as Record<string, unknown>;
      for (const key of URL_ATTRIBUTES) if (typeof attributes[key] === 'string') attributes[key] = maskUrl(attributes[key]);
      for (const key of QUERY_ATTRIBUTES) if (key in attributes) attributes[key] = '[redacted]';
    }
    super.export(spans, resultCallback);
  }
}
