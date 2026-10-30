import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import type { NextFunction, Request, Response } from 'express';

/**
 * [DOBLE] de la instrumentación de OpenTelemetry para las pruebas del borde. En producción `telemetry.ts` arranca el SDK y `HttpInstrumentation` abre el span
 * servidor de cada petición (continuando el `traceparent` del cliente); bajo Jest esa instrumentación no puede parchear `http` (Jest carga los módulos del núcleo por
 * su cuenta). Acá se registra el SDK REAL (contexto, propagador W3C, tracer) con un exportador en memoria, y `simulatedServerSpan` hace lo que hace la instrumentación:
 * extrae el contexto de la petición y deja un span servidor activo mientras se atiende. La prueba contra la instrumentación real es el e2e de Jaeger.
 */
export const exported = new tracing.InMemorySpanExporter();
let started = false;

export function startTestTracing(): void {
  if (started) return;
  started = true;
  // Sin detectores de recursos: con ellos el recurso se resuelve de forma asíncrona y los primeros spans se exportarían tarde.
  new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exported)], autoDetectResources: false }).start();
}

export function simulatedServerSpan(req: Request, res: Response, next: NextFunction): void {
  const parent = propagation.extract(ROOT_CONTEXT, req.headers);
  const span = trace.getTracer('test-http-server').startSpan('SERVER (doble de HttpInstrumentation)', { kind: SpanKind.SERVER }, parent);
  res.on('close', () => span.end());
  context.with(trace.setSpan(parent, span), next);
}

export type Finished = ReturnType<typeof exported.getFinishedSpans>[number];
export const parentIdOf = (span: Finished): string | undefined => span.parentSpanContext?.spanId;
export const spansNamed = (prefix: string): Finished[] => exported.getFinishedSpans().filter((s) => s.name.startsWith(prefix));
/** Lo que un span exporta y podría filtrar (sin las referencias internas del SDK, que son circulares). */
export const dumpOf = (span: Finished): string => JSON.stringify({ name: span.name, attributes: span.attributes, status: span.status, events: span.events, links: span.links });
