import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

/**
 * Propagación de la traza hacia los servicios internos (P1.H2.M3, T1).
 *
 * El borde NO fabrica identificadores de traza: reenvía el contexto ACTIVO de OpenTelemetry. Ese contexto lo abrió la instrumentación http al recibir la petición (que
 * continúa el `traceparent` del cliente si es válido, o abre una traza nueva si falta o está malformado) y, dentro de `UpstreamClient.forward`, un span CLIENTE propio:
 * el span servidor del servicio dueño cuelga de ese span, que SÍ se exporta, así que la traza no queda con padres ausentes.
 *
 * Quién decide qué es un `traceparent` válido (versión futura, flags, ceros) es el propagador del SDK, no este archivo: así el borde y el SDK no pueden discrepar.
 * Sin SDK (sin `OTEL_EXPORTER_OTLP_ENDPOINT`) el propagador es nulo y no se reenvía ningún `traceparent`: no se inventa uno.
 */

const TRACER = 'pay-edge';
/** Cabeceras de contexto que el borde nunca copia del llamador: solo se reenvía el `traceparent` del contexto activo (`tracestate` y `baggage` del cliente no cruzan). */
const CONTEXT_HEADERS = new Set(['traceparent', 'tracestate', 'baggage']);

/** Copia de `headers` sin ninguna cabecera de contexto, más el `traceparent` del contexto activo (si hay propagador y span activo). */
export function withActiveTraceparent(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (!CONTEXT_HEADERS.has(name.toLowerCase())) out[name] = value;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (typeof carrier.traceparent === 'string') out.traceparent = carrier.traceparent;
  return out;
}

/**
 * Corre `run` dentro de un span CLIENTE activo. Los atributos son una lista cerrada que arma quien llama (nunca URL, cuerpo, cabeceras ni claves: el cliente escribe
 * la ruta y puede traer un PAN). Un error deja el span en `ERROR` SIN el mensaje ni la excepción (podrían traer datos del destino).
 */
export function inClientSpan<T>(name: string, attributes: Attributes, run: (span: Span) => Promise<T>): Promise<T> {
  return trace.getTracer(TRACER).startActiveSpan(name, { kind: SpanKind.CLIENT, attributes }, async (span) => {
    try {
      return await run(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
