// PRIMERA IMPORTACIÓN del proceso (ver main.ts): las instrumentaciones parchean http, express y pg al cargarlos.
// Solo se activa si hay `OTEL_EXPORTER_OTLP_ENDPOINT`; sin él, el servicio arranca sin trazas.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { safeUrl } from '../log-safe';

/**
 * La ruta de la petición la escribe el cliente (puede traer un PAN o un nombre) y varias instrumentaciones la copian a sus spans
 * (`url.path`, `url.full`, `http.target`, `http.url`). Se enmascara aquí, justo antes de exportar, igual que en el log de acceso.
 */
const URL_ATTRIBUTES = ['url.path', 'url.full', 'http.target', 'http.url'];
export const maskUrl = (value: string): string => {
  const absolute = /^(https?:\/\/[^/]+)(\/.*)?$/.exec(value);
  return absolute ? `${absolute[1]}${safeUrl(absolute[2] ?? '/')}` : safeUrl(value);
};
export class MaskingTraceExporter extends OTLPTraceExporter {
  override export(spans: Parameters<OTLPTraceExporter['export']>[0], resultCallback: Parameters<OTLPTraceExporter['export']>[1]): void {
    for (const span of spans) {
      const attributes = span.attributes as Record<string, unknown>;
      for (const key of URL_ATTRIBUTES) if (typeof attributes[key] === 'string') attributes[key] = maskUrl(attributes[key]);
    }
    super.export(spans, resultCallback);
  }
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'pay-edge',
    traceExporter: new MaskingTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new NestInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
