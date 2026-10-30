import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';

/**
 * [DOBLE] de la instrumentación de OpenTelemetry para las pruebas (P1.H2.M3). En producción `telemetry.ts` arranca el SDK y `HttpInstrumentation` abre el span servidor
 * de cada petición; bajo Jest esa instrumentación no puede parchear `http`. Acá se registra el SDK REAL (contexto, propagador W3C, tracer) con un exportador en
 * memoria, y `inServerSpan` hace lo que hace la instrumentación: extrae el `traceparent` de la petición y deja un span servidor activo. La prueba contra la
 * instrumentación real y Jaeger es el e2e (`e2e/flows/traza-jaeger-arbol.e2e.ts`).
 */
export const exported = new tracing.InMemorySpanExporter();
let started = false;

export function startTestTracing(): void {
  if (started) return;
  started = true;
  // Sin detectores de recursos: con ellos el recurso se resuelve de forma asíncrona y los primeros spans se exportarían tarde.
  new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exported)], autoDetectResources: false }).start();
}

/** Corre `run` dentro de un span servidor simulado, hijo del `traceparent` entrante si es válido (si no, raíz). Devuelve el resultado y el span (ya cerrado). */
export async function inServerSpan<T>(incomingTraceparent: string | undefined, run: () => Promise<T>): Promise<{ result: T; traceId: string; spanId: string }> {
  const parent = incomingTraceparent === undefined ? ROOT_CONTEXT : propagation.extract(ROOT_CONTEXT, { traceparent: incomingTraceparent });
  const span = trace.getTracer('test-http-server').startSpan('SERVER (doble de HttpInstrumentation)', { kind: SpanKind.SERVER }, parent);
  try {
    const result = await context.with(trace.setSpan(parent, span), run);
    return { result, traceId: span.spanContext().traceId, spanId: span.spanContext().spanId };
  } finally {
    span.end();
  }
}

export type Finished = ReturnType<typeof exported.getFinishedSpans>[number];
export const parentIdOf = (span: Finished): string | undefined => span.parentSpanContext?.spanId;
export const spansNamed = (prefix: string): Finished[] => exported.getFinishedSpans().filter((s) => s.name.startsWith(prefix));
export const idOf = (span: Finished): string => span.spanContext().spanId;
/** Lo que un span exporta y podría filtrar (sin las referencias internas del SDK, que son circulares). */
export const dumpOf = (span: Finished): string => JSON.stringify({ name: span.name, attributes: span.attributes, status: span.status, events: span.events, links: span.links });
/** Spans exportados cuyo padre NO está entre los exportados (excluye raíces). */
export const danglingParents = (spans: readonly Finished[] = exported.getFinishedSpans()): Finished[] => {
  const ids = new Set(spans.map(idOf));
  return spans.filter((s) => parentIdOf(s) !== undefined && !ids.has(parentIdOf(s)!));
};
