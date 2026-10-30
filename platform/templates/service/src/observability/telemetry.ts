// PRIMERA IMPORTACIÓN del proceso (ver main.ts): las instrumentaciones parchean http, express y pg al cargarlos.
// Solo se activa si hay `OTEL_EXPORTER_OTLP_ENDPOINT`; sin él, el servicio arranca sin trazas.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { maskSpanAttributes } from '@pay/idempotency';

/**
 * La ruta y la query de la petición las escribe el cliente (pueden traer un PAN, un NIT o una CI) y varias instrumentaciones las copian a sus spans (`url.*`,
 * `http.*`). Se enmascaran aquí, justo antes de exportar, con la función COMPARTIDA (`@pay/idempotency`, `maskSpanAttributes`: lista única de atributos y prueba
 * que recorre todos), igual que en el log de acceso.
 */
export class MaskingTraceExporter extends OTLPTraceExporter {
  override export(spans: Parameters<OTLPTraceExporter['export']>[0], resultCallback: Parameters<OTLPTraceExporter['export']>[1]): void {
    for (const span of spans) maskSpanAttributes(span.attributes as Record<string, unknown>);
    super.export(spans, resultCallback);
  }
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? '__NAME__',
    traceExporter: new MaskingTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new NestInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
