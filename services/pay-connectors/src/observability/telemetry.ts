// PRIMERA IMPORTACIÓN del proceso (ver main.ts): las instrumentaciones parchean http, express y pg al cargarlos.
// Solo se activa si hay `OTEL_EXPORTER_OTLP_ENDPOINT`; sin él, el servicio arranca sin trazas.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { scrubSpanAttributes } from './scrub';

/** Exportador OTLP que limpia las URLs de los spans (regla 90.2) antes de mandarlos. */
class ScrubbingExporter extends OTLPTraceExporter {
  override export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) scrubSpanAttributes(span.attributes as Record<string, unknown>);
    super.export(spans, resultCallback);
  }
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'pay-connectors',
    traceExporter: new ScrubbingExporter(),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new NestInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
