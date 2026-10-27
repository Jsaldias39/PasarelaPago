// PRIMERA IMPORTACIÓN del proceso (ver main.ts): las instrumentaciones parchean http, express y pg al cargarlos.
// Solo se activa si hay `OTEL_EXPORTER_OTLP_ENDPOINT`; sin él, el servicio arranca sin trazas.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'pay-vault',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation(), new NestInstrumentation(), new PgInstrumentation()],
  });
  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
