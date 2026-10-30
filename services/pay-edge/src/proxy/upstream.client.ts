import type { UpstreamName } from '../config';
import { fail } from '../edge-problem';
import { inClientSpan, withActiveTraceparent } from '../observability/trace-propagation';
import { CircuitBreaker } from './circuit-breaker';

export interface ForwardRequest {
  readonly upstream: UpstreamName;
  readonly method: string;
  readonly path: string;
  /** Consulta ya filtrada contra la lista del contrato, con el `?` inicial o vacía. */
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface ForwardResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface UpstreamOptions {
  readonly urls: Readonly<Record<UpstreamName, string>>;
  readonly timeoutMs: number;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
  readonly now?: () => number;
  /** Solo para pruebas. */
  readonly fetchImpl?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PASS_HEADERS = ['content-type', 'idempotency-replayed', 'retry-after'] as const;
const CODE = /^[a-z][a-z0-9_]*$/;
const PROBLEM_KEYS = ['type', 'title', 'status', 'detail', 'instance', 'request_id', 'errors'] as const;

/**
 * Un error de un servicio de destino puede traer cualquier cosa (una pila, SQL, un nombre de host). Solo se deja pasar un
 * cuerpo `application/problem+json` bien formado, y re-serializado con una lista cerrada de campos. Devuelve `null` si no lo es.
 */
export function sanitizeProblem(raw: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const input = parsed as Record<string, unknown>;
  if (typeof input.type !== 'string' || typeof input.title !== 'string' || typeof input.status !== 'number' || typeof input.code !== 'string' || !CODE.test(input.code)) return null;
  const out: Record<string, unknown> = { code: input.code };
  for (const key of PROBLEM_KEYS) {
    if (!(key in input)) continue;
    if (key === 'errors') {
      if (!Array.isArray(input.errors)) return null;
      out.errors = input.errors.map((e) => {
        const item = (e ?? {}) as Record<string, unknown>;
        return { field: String(item.field ?? ''), code: String(item.code ?? ''), ...(typeof item.message === 'string' && { message: item.message }) };
      });
    } else if (key === 'status') {
      out.status = input.status;
    } else if (typeof input[key] === 'string') {
      out[key] = input[key];
    }
  }
  return Buffer.from(JSON.stringify(out));
}

export class UpstreamClient {
  private readonly breakers = new Map<UpstreamName, CircuitBreaker>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: UpstreamOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Estado del cortacircuitos de un destino (para salud y pruebas). */
  breakerState(upstream: UpstreamName): string {
    return this.breaker(upstream).state;
  }

  private breaker(upstream: UpstreamName): CircuitBreaker {
    let breaker = this.breakers.get(upstream);
    if (!breaker) {
      breaker = new CircuitBreaker(this.options.failureThreshold, this.options.cooldownMs, this.options.now);
      this.breakers.set(upstream, breaker);
    }
    return breaker;
  }

  /**
   * Reenvía una petición al servicio dueño.
   *
   * - Sin reintentos automáticos: una mutación reintentada a ciegas duplicaría efectos; el cliente reintenta con la misma Idempotency-Key.
   * - Si vence el tiempo, la petición PUDO haberse procesado: por eso el error es 504 y no 5xx genérico.
   * - Un 5xx que trae un problema RFC 9457 válido cuenta como respuesta deliberada del servicio (no abre el cortacircuitos); un
   *   5xx sin cuerpo válido, un error de red o un tiempo agotado sí.
   *
   * - Trazas (P1.H2.M3): `fetch` global no se instrumenta solo, así que el reenvío abre un span CLIENTE propio y el `traceparent` que viaja es el del contexto activo
   *   (el de ese span): el span servidor del destino cuelga de un span que se exporta. Un `traceparent` de `request.headers` se descarta; el `x-request-id` se respeta.
   *
   * @throws EdgeProblemError con 502/503/504 sin detalle del destino.
   */
  async forward(request: ForwardRequest): Promise<ForwardResponse> {
    const breaker = this.breaker(request.upstream);
    if (!breaker.tryAcquire()) {
      throw fail('upstream_unavailable', { headers: { 'Retry-After': String(Math.max(1, Math.ceil(breaker.retryAfterMs() / 1000))) } });
    }
    // Atributos de una lista cerrada: nunca la ruta, la consulta, las cabeceras ni el cuerpo (los escribe el cliente y pueden traer un PAN o una clave).
    return inClientSpan(`forward ${request.upstream}`, { 'peer.service': request.upstream, 'http.request.method': request.method }, async (span) => {
      const response = await this.exchange(request, breaker);
      span.setAttribute('http.response.status_code', response.status);
      return response;
    });
  }

  private async exchange(request: ForwardRequest, breaker: CircuitBreaker): Promise<ForwardResponse> {
    let response: Response;
    let body: Buffer;
    try {
      response = await this.fetchImpl(`${this.options.urls[request.upstream]}${request.path}${request.query}`, {
        method: request.method,
        headers: withActiveTraceparent(request.headers),
        body: request.body.length > 0 ? new Uint8Array(request.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_RESPONSE_BYTES) throw new RangeError('respuesta demasiado grande');
      body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_RESPONSE_BYTES) throw new RangeError('respuesta demasiado grande');
    } catch (error) {
      breaker.onFailure();
      // Por nombre y no por `instanceof`: el DOMException de fetch puede venir de otro realm (jest, vm).
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw fail('upstream_timeout');
      if (error instanceof RangeError) throw fail('upstream_error');
      throw fail('upstream_unavailable');
    }

    const contentType = response.headers.get('content-type') ?? '';
    const headers: Record<string, string> = {};
    for (const name of PASS_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }

    if (response.status >= 300 && response.status < 400) {
      breaker.onFailure();
      throw fail('upstream_error');
    }

    if (response.status >= 400) {
      // Todo error (4xx o 5xx) tiene que ser un problema RFC 9457 bien formado; si no, el servicio de destino se portó mal.
      const clean = contentType.includes('application/problem+json') ? sanitizeProblem(body) : null;
      if (clean === null) {
        breaker.onFailure();
        throw fail('upstream_error');
      }
      breaker.onSuccess();
      return { status: response.status, headers: { ...headers, 'content-type': 'application/problem+json' }, body: clean };
    }

    if (body.length > 0 && !contentType.includes('application/json')) {
      breaker.onFailure();
      throw fail('upstream_error');
    }

    breaker.onSuccess();
    return { status: response.status, headers, body };
  }
}
