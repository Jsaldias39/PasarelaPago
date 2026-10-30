import { AsyncLocalStorage } from 'node:async_hooks';
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import { containsPan } from '../domain/pan';
import type { TraceCarrier } from '../temporal/types';

/**
 * Propagación de la traza y del `x-request-id` desde la petición pública hasta las llamadas a riesgo, conector y ledger (P1.H2.M3, T2 y T3).
 *
 * El cobro NO se ejecuta dentro de la petición HTTP: la petición arranca un workflow de Temporal y las llamadas a riesgo y al conector las hacen sus activities, en el
 * worker, sin contexto. Por eso el contexto viaja COMO DATO: al arrancar el workflow se captura el `traceparent` del contexto activo y el `x-request-id` de la
 * petición (`TraceCarrier`, campo opcional del input), y cada activity que llama hacia afuera lo reconstruye con `propagation.extract` y abre un span de actividad como
 * hijo. Desde ahí los clientes HTTP (`clients/http.ts`) inyectan el contexto activo. No hay dependencia nueva: solo `@opentelemetry/api`.
 */

const TRACER = 'pay-payments';
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
/** Un traceparent bien formado mide 55 caracteres (versión 00); se acota por si llega algo mayor, y el SDK decide su validez. */
const MAX_TRACEPARENT = 512;
/** Cabeceras de contexto que un cliente interno nunca copia del llamador: solo se envía el `traceparent` del contexto activo. */
const CONTEXT_HEADERS = new Set(['traceparent', 'tracestate', 'baggage']);

/** La misma regla que `genReqId` de `app.module.ts`: 8 a 64 caracteres sin espacios ni símbolos y sin forma de PAN. */
export const isValidRequestId = (value: unknown): value is string => typeof value === 'string' && REQUEST_ID.test(value) && !containsPan(value);

// ── x-request-id de la petición de origen ─────────────────────────────────────────────────────────────────────────────
// Propio de este módulo y no del contexto de OpenTelemetry: el id tiene que viajar aunque no haya SDK (sin `OTEL_EXPORTER_OTLP_ENDPOINT` el contexto activo es nulo).
const requestScope = new AsyncLocalStorage<{ readonly requestId: string }>();

/** Corre `run` con `requestId` como id de la petición de origen. Un id inválido (o ausente) no abre alcance: las llamadas generarán el suyo. */
export function runWithRequestId<T>(requestId: unknown, run: () => T): T {
  return isValidRequestId(requestId) ? requestScope.run({ requestId }, run) : run();
}

export const currentRequestId = (): string | undefined => requestScope.getStore()?.requestId;

// ── Salida: clientes HTTP ─────────────────────────────────────────────────────────────────────────────────────────────
/** Copia de `headers` sin cabeceras de contexto, más el `traceparent` del contexto activo (si hay propagador y span activo). */
export function withActiveTraceparent(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (!CONTEXT_HEADERS.has(name.toLowerCase())) out[name] = value;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (typeof carrier.traceparent === 'string') out.traceparent = carrier.traceparent;
  return out;
}

/**
 * Corre `run` dentro de un span CLIENTE activo. Atributos: una lista cerrada que arma quien llama (nunca ruta, cuerpo ni cabeceras). Un error deja el span en `ERROR`
 * SIN mensaje ni excepción.
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

// ── Cruce de Temporal ─────────────────────────────────────────────────────────────────────────────────────────────────
/** Lo que hay que llevar al worker: el `traceparent` del contexto activo y el id de la petición de origen. `undefined` si no hay ninguno de los dos. */
export function captureTraceCarrier(): TraceCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier.traceparent;
  const requestId = currentRequestId();
  if (traceparent === undefined && requestId === undefined) return undefined;
  return { ...(traceparent !== undefined && { traceparent }), ...(requestId !== undefined && { requestId }) };
}

/**
 * Corre una activity dentro de un span INTERNO hijo del `traceparent` del carrier y con el id de la petición de origen. Un carrier ausente (workflow que arrancó antes de
 * este cambio) o con un `traceparent` malformado abre una traza nueva: nunca falla, la traza es observabilidad y no puede cambiar el resultado de un cobro.
 */
export function inActivityTrace<T>(activity: string, carrier: TraceCarrier | undefined, attempt: number | undefined, run: () => Promise<T>): Promise<T> {
  const traceparent = typeof carrier?.traceparent === 'string' && carrier.traceparent.length <= MAX_TRACEPARENT ? carrier.traceparent : undefined;
  const parent = traceparent === undefined ? ROOT_CONTEXT : propagation.extract(ROOT_CONTEXT, { traceparent });
  const attributes: Attributes = { 'temporal.activity.type': activity, ...(attempt !== undefined && { 'temporal.activity.attempt': attempt }) };
  return runWithRequestId(carrier?.requestId, () =>
    trace.getTracer(TRACER).startActiveSpan(`activity ${activity}`, { kind: SpanKind.INTERNAL, attributes }, parent, async (span) => {
      try {
        return await run();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
