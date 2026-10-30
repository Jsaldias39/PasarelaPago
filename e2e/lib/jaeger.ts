/**
 * Cliente mínimo de Jaeger REAL para el arnés (P1.H2.M3): consulta la API HTTP de consulta (`/api/traces`) y arma el ÁRBOL de spans de una traza para poder afirmar relaciones
 * padre/hijo y no solo «mismo traceId». No es un doble: los servicios exportan OTLP/HTTP al contenedor `pay-jaeger-1` del Compose (puertos publicados en 127.0.0.1, ver
 * `platform/compose.yml`: 54318 → OTLP/HTTP 4318 y 54686 → consulta 16686) y esta clase lee de ahí lo que Jaeger indexó.
 *
 * Todo lo que no depende de la red (`viewsOf`, `danglingParents`, `reachableFrom`, `renderTree`) es puro y tiene prueba propia en jaeger.spec.ts.
 */

export interface JaegerTag {
  readonly key: string;
  readonly type?: string;
  readonly value: unknown;
}

export interface JaegerSpan {
  readonly traceID: string;
  readonly spanID: string;
  readonly operationName: string;
  readonly references?: readonly { readonly refType: string; readonly traceID?: string; readonly spanID: string }[];
  /** Microsegundos desde la época. */
  readonly startTime: number;
  readonly duration: number;
  readonly tags?: readonly JaegerTag[];
  readonly logs?: readonly unknown[];
  readonly processID: string;
}

export interface JaegerTrace {
  readonly traceID: string;
  readonly spans: readonly JaegerSpan[];
  readonly processes: Readonly<Record<string, { readonly serviceName: string; readonly tags?: readonly JaegerTag[] }>>;
}

/** Un span ya resuelto: servicio, padre y atributos en un mapa. */
export interface SpanView {
  readonly spanId: string;
  /** `undefined` si es raíz de la traza (sin referencia). */
  readonly parentId: string | undefined;
  readonly service: string;
  readonly operation: string;
  readonly kind: string | undefined;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly startUs: number;
  readonly durationUs: number;
}

export interface JaegerEndpoints {
  /** API de consulta (16686 dentro del contenedor). */
  readonly queryUrl: string;
  /** Valor para `OTEL_EXPORTER_OTLP_ENDPOINT` de los servicios (OTLP/HTTP, 4318 dentro del contenedor). */
  readonly otlpUrl: string;
}

/** Puertos publicados por `platform/compose.yml`; sobrescribibles como el resto de la infraestructura del arnés. */
export function jaegerEndpoints(env: NodeJS.ProcessEnv = process.env): JaegerEndpoints {
  return {
    queryUrl: env.PAY_E2E_JAEGER_QUERY_URL ?? 'http://127.0.0.1:54686',
    otlpUrl: env.PAY_E2E_JAEGER_OTLP_URL ?? 'http://127.0.0.1:54318',
  };
}

export interface SearchQuery {
  readonly service: string;
  /** Etiquetas exactas que debe tener algún span (p. ej. `user_agent.original`). */
  readonly tags?: Readonly<Record<string, string>>;
  /** Ventana en microsegundos desde la época. */
  readonly startUs: number;
  readonly endUs: number;
  readonly limit?: number;
}

export class Jaeger {
  constructor(readonly endpoints: JaegerEndpoints = jaegerEndpoints()) {}

  /** ¿Responde la API de consulta y el colector OTLP? Falla con un mensaje accionable (el arnés no levanta Jaeger: es del Compose). */
  async assertReachable(): Promise<void> {
    const problems: string[] = [];
    try {
      const res = await fetch(`${this.endpoints.queryUrl}/api/services`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) problems.push(`consulta ${this.endpoints.queryUrl}/api/services respondió ${res.status}`);
    } catch (error) {
      problems.push(`consulta ${this.endpoints.queryUrl} no responde (${(error as Error).message})`);
    }
    try {
      // Un POST vacío a /v1/traces es una petición OTLP válida con cero spans: 200 si el colector está abierto.
      const res = await fetch(`${this.endpoints.otlpUrl}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"resourceSpans":[]}', signal: AbortSignal.timeout(5_000) });
      if (!res.ok) problems.push(`OTLP ${this.endpoints.otlpUrl}/v1/traces respondió ${res.status}`);
    } catch (error) {
      problems.push(`OTLP ${this.endpoints.otlpUrl} no responde (${(error as Error).message})`);
    }
    if (problems.length > 0) throw new Error(`Jaeger del Compose no disponible: ${problems.join('; ')}. Levantalo con \`docker compose -f platform/compose.yml up -d jaeger\`.`);
  }

  /** La traza completa tal como la tiene Jaeger, o `undefined` si todavía no la indexó (404). */
  async trace(traceId: string): Promise<JaegerTrace | undefined> {
    const res = await fetch(`${this.endpoints.queryUrl}/api/traces/${traceId}`, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Jaeger GET /api/traces/${traceId} respondió ${res.status}`);
    const body = (await res.json()) as { data?: JaegerTrace[] | null };
    return body.data?.[0];
  }

  /** Trazas con algún span del servicio dentro de la ventana (y con las etiquetas pedidas). */
  async search(query: SearchQuery): Promise<JaegerTrace[]> {
    const params = new URLSearchParams({ service: query.service, start: String(query.startUs), end: String(query.endUs), limit: String(query.limit ?? 50) });
    if (query.tags) params.set('tags', JSON.stringify(query.tags));
    const res = await fetch(`${this.endpoints.queryUrl}/api/traces?${params.toString()}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Jaeger GET /api/traces respondió ${res.status}`);
    const body = (await res.json()) as { data?: JaegerTrace[] | null };
    return body.data ?? [];
  }
}

const tagValue = (tags: readonly JaegerTag[] | undefined): Record<string, unknown> => Object.fromEntries((tags ?? []).map((t) => [t.key, t.value]));

export function viewsOf(trace: JaegerTrace): SpanView[] {
  return trace.spans.map((span) => {
    const attrs = tagValue(span.tags);
    const parent = span.references?.find((r) => r.refType === 'CHILD_OF') ?? span.references?.[0];
    return {
      spanId: span.spanID,
      parentId: parent?.spanID,
      service: trace.processes[span.processID]?.serviceName ?? `?${span.processID}`,
      operation: span.operationName,
      kind: typeof attrs['span.kind'] === 'string' ? attrs['span.kind'] : undefined,
      attrs,
      startUs: span.startTime,
      durationUs: span.duration,
    };
  });
}

export const servicesOf = (views: readonly SpanView[]): string[] => [...new Set(views.map((v) => v.service))].sort();

/** Span SERVIDOR HTTP de un servicio (el que abre la instrumentación http al recibir la petición). */
export const serverSpanOf = (views: readonly SpanView[], service: string): SpanView | undefined => views.filter((v) => v.service === service && v.kind === 'server').sort((a, b) => a.startUs - b.startUs)[0];

/**
 * Spans cuyo padre NO está en la traza (los raíz propiamente dichos no cuentan: no tienen padre). Un hijo «colgado» es lo que deja un `traceparent` con un
 * span-id que ningún servicio exportó: Jaeger lo dibuja como raíz separada con una advertencia.
 */
export function danglingParents(views: readonly SpanView[]): SpanView[] {
  const ids = new Set(views.map((v) => v.spanId));
  return views.filter((v) => v.parentId !== undefined && !ids.has(v.parentId));
}

/** Los span-id alcanzables hacia abajo desde `rootId` (incluido). */
export function reachableFrom(views: readonly SpanView[], rootId: string): Set<string> {
  const children = new Map<string, SpanView[]>();
  for (const v of views) if (v.parentId !== undefined) children.set(v.parentId, [...(children.get(v.parentId) ?? []), v]);
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) for (const child of children.get(queue.shift()!) ?? []) if (!seen.has(child.spanId)) { seen.add(child.spanId); queue.push(child.spanId); }
  return seen;
}

const NOISE = /^(pg\.|pg-pool|middleware - |request handler - )/;

/**
 * El árbol como texto, para la evidencia. Los spans de ruido (consultas SQL, middlewares de Express) se cuentan en su padre en vez de listarse. Las raíces cuyo
 * padre falta en la traza se marcan « [padre ausente de la traza: <id>]».
 */
export function renderTree(views: readonly SpanView[]): string {
  const ids = new Set(views.map((v) => v.spanId));
  const byParent = new Map<string | undefined, SpanView[]>();
  for (const v of views) {
    const key = v.parentId !== undefined && ids.has(v.parentId) ? v.parentId : undefined;
    byParent.set(key, [...(byParent.get(key) ?? []), v]);
  }
  const lines: string[] = [];
  const walk = (parent: string | undefined, depth: number): void => {
    const siblings = (byParent.get(parent) ?? []).sort((a, b) => a.startUs - b.startUs);
    const noise = siblings.filter((s) => NOISE.test(s.operation) && !(byParent.get(s.spanId) ?? []).length);
    for (const span of siblings.filter((s) => !noise.includes(s))) {
      const dangling = span.parentId !== undefined && !ids.has(span.parentId) ? ` [padre ausente de la traza: ${span.parentId}]` : '';
      const route = span.attrs['http.route'] ?? span.attrs['url.path'];
      const status = span.attrs['http.status_code'] ?? span.attrs['http.response.status_code'];
      const extra = [span.kind ? `kind=${span.kind}` : '', route !== undefined ? `route=${String(route)}` : '', status !== undefined ? `status=${String(status)}` : ''].filter(Boolean).join(' ');
      lines.push(`${'  '.repeat(depth)}${span.service}  ${span.operation}  (${span.spanId})${extra ? `  ${extra}` : ''}${dangling}`);
      walk(span.spanId, depth + 1);
    }
    if (noise.length > 0) lines.push(`${'  '.repeat(depth)}… ${noise.length} span(s) de ruido (pg.*, pg-pool.*, middleware, request handler)`);
  };
  walk(undefined, 0);
  return lines.join('\n');
}

/** Todo el texto de una traza (nombres, atributos, eventos, procesos, identificadores) para buscar cadenas que NO deben estar. */
export const textOf = (trace: JaegerTrace): string => JSON.stringify(trace);

const IDENTITY_KEYS = new Set(['traceID', 'spanID', 'processID', 'startTime', 'duration', 'references', 'flags']);

/**
 * El CONTENIDO de una traza sin sus identificadores ni tiempos: los trace/span-id (hex de 32 y 16 caracteres) y los instantes en microsegundos (16 dígitos) traen tiras de 13 a 19
 * dígitos que pasan Luhn por azar y confunden a un detector de números de tarjeta. Lo que queda (nombres de operación, etiquetas, eventos, servicios) es lo único donde un
 * dato del cliente podría haberse colado.
 */
export const contentTextOf = (trace: JaegerTrace): string => JSON.stringify(trace, (key, value: unknown) => (IDENTITY_KEYS.has(key) ? undefined : value));
