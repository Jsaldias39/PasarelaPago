import type { Span } from '@opentelemetry/api';
import { serviceHeaders } from '@pay/service-auth';
import { generateRequestId } from '@pay/idempotency';
import { currentRequestId, inClientSpan, isValidRequestId, withActiveTraceparent } from '../observability/trace-propagation';

/**
 * Lo que se SABE de si la llamada que falló llegó a la dependencia (CLAUDE.md regla 11: un resultado ambiguo no prueba que la orden no se ejecutó).
 * Por defecto todo es ambiguo; solo se declara «no llegó» cuando se PRUEBA (`notReached`).
 */
export interface UpstreamEvidence {
  /** Se PRUEBA que esta llamada no salió hacia la dependencia: la conexión no se estableció (rechazada, DNS, red inalcanzable) o el breaker estaba abierto. */
  readonly notReached?: boolean;
  /** Una llamada ANTERIOR del mismo `request()` (el reintento interno del cliente) pudo llegar: el error que se ve es solo el último. */
  readonly earlierAttemptMayHaveReached?: boolean;
}

/** Falla de la dependencia (no una respuesta de negocio): sirve para decidir reintento y circuit breaker. */
export class UpstreamError extends Error {
  /**
   * `true` SOLO si se prueba que NINGUNA llamada de este `request()` llegó a la dependencia: conexión rechazada, DNS que no resuelve, red inalcanzable o
   * breaker abierto, y ninguna llamada anterior ambigua. Un timeout, un corte de socket, un 5xx, un 4xx sin el cuerpo del contrato o un 2xx ilegible son
   * AMBIGUOS: la orden pudo ejecutarse. Quien llama a una operación idempotente que sigue viva en el servidor (riesgo) no puede tratar un error ambiguo como «no hay evaluación».
   */
  readonly provenNotReached: boolean;
  /** Una llamada anterior del mismo `request()` pudo llegar a la dependencia (p. ej. un timeout y, dentro del mismo intento, un 503): este error la enmascara. */
  readonly earlierAttemptMayHaveReached: boolean;

  constructor(
    /** `unexpected_response`: llegó algo que el contrato no declara (un 4xx sin el cuerpo de error exacto, un cuerpo ilegible). */
    readonly kind: 'timeout' | 'network' | 'circuit_open' | 'server_error' | 'unexpected_response',
    readonly upstream: string,
    readonly status?: number,
    /** `code` del cuerpo problem+json si venía bien formado; con él se reconoce un error DEFINITIVO declarado por el contrato. */
    readonly problemCode?: string,
    evidence: UpstreamEvidence = {},
  ) {
    super(`${upstream}: ${kind}${status ? ` (${status})` : ''}`);
    this.name = 'UpstreamError';
    this.earlierAttemptMayHaveReached = evidence.earlierAttemptMayHaveReached === true;
    this.provenNotReached = (evidence.notReached ?? kind === 'circuit_open') && !this.earlierAttemptMayHaveReached;
  }

  /** El mismo error, marcado como visto DESPUÉS de una llamada anterior que pudo llegar (ya no prueba «no llegó»). */
  withEarlierAttempt(): UpstreamError {
    return new UpstreamError(this.kind, this.upstream, this.status, this.problemCode, { notReached: false, earlierAttemptMayHaveReached: true });
  }
}

/** Códigos de `fetch` que prueban que la conexión NUNCA se estableció (no se envió ni un byte de la petición). Un corte posterior (ECONNRESET, UND_ERR_SOCKET, EPIPE) NO está aquí. */
const CONNECTION_NEVER_ESTABLISHED: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * ¿El fallo de `fetch` prueba que la petición no salió? Se lee la causa por propiedades (sin `instanceof`: bajo Jest los errores vienen de otro realm).
 * Con varias direcciones (happy eyeballs) la causa es un `AggregateError`: solo prueba «no llegó» si TODAS fallaron al conectar.
 */
export function connectionNeverEstablished(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; errors?: unknown } } | null)?.cause;
  if (cause === null || typeof cause !== 'object') return false;
  const nested = Array.isArray(cause.errors) ? (cause.errors as { code?: unknown }[]) : [];
  if (nested.length > 0) return nested.every((e) => typeof e?.code === 'string' && CONNECTION_NEVER_ESTABLISHED.has(e.code));
  return typeof cause.code === 'string' && CONNECTION_NEVER_ESTABLISHED.has(cause.code);
}

export interface BreakerOptions {
  readonly failureThreshold: number;
  readonly resetAfterMs: number;
  /**
   * `true`: un `timeout` NO cuenta como falla de la dependencia. Para llamadas idempotentes cuya operación sigue viva en el servidor cuando el cliente
   * se va (riesgo: la evaluación continúa y el reintento con la misma clave recibe el 409 «en curso» y luego la respuesta guardada). Un timeout ahí es un
   * resultado AMBIGUO, no un fallo (CLAUDE.md regla 11); contarlo abre el breaker con los propios reintentos y corta el paso hacia un servicio sano.
   * La red y los 5xx siguen contando.
   */
  readonly ignoreTimeouts?: boolean;
  readonly now?: () => number;
}

/**
 * Circuit breaker mínimo. Cerrado: pasa todo. Tras `failureThreshold` fallos CONSECUTIVOS se abre y rechaza al instante;
 * pasado `resetAfterMs` deja pasar UNA llamada de prueba (semiabierto): si sale bien, cierra; si falla, vuelve a abrir.
 * Solo cuentan las fallas de la dependencia (red, timeout, 5xx), no los 4xx de negocio.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  /**
   * La última sonda del semiabierto VENCIÓ por timeout con `ignoreTimeouts`: no es concluyente (la dependencia no dijo ni sí ni no). Mientras dure, el semiabierto
   * deja pasar las llamadas en vez de admitir UNA sola sonda cuyo timeout rechazaría a todas las demás con `circuit_open` sin que lleguen a la dependencia (REVISION-DINERO F3).
   * Termina con la primera respuesta concluyente: un éxito cierra el breaker; una falla real (red, 5xx) lo reabre. Un timeout nunca abre ni cuenta, así que esto no
   * reintroduce el defecto que `ignoreTimeouts` corrige (los propios timeouts abriendo el breaker).
   */
  private probeInconclusive = false;
  private readonly now: () => number;

  constructor(
    private readonly name: string,
    private readonly options: BreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get state(): 'closed' | 'open' | 'half_open' {
    if (this.openedAt === null) return 'closed';
    return this.now() - this.openedAt >= this.options.resetAfterMs ? 'half_open' : 'open';
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half_open' && this.probing && !this.probeInconclusive)) throw new UpstreamError('circuit_open', this.name);
    const asProbe = state === 'half_open';
    const openedAtStart = this.openedAt;
    if (asProbe) this.probing = true;
    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = null;
      this.probeInconclusive = false;
      return result;
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (this.options.ignoreTimeouts && error.kind === 'timeout') {
          // Ni cuenta ni abre. Si era una sonda del MISMO semiabierto (no se reabrió ni cerró mientras tanto), queda «no concluyente».
          if (asProbe && this.openedAt !== null && this.openedAt === openedAtStart) this.probeInconclusive = true;
        } else {
          this.failures += 1;
          if (this.openedAt !== null || this.failures >= this.options.failureThreshold) {
            this.openedAt = this.now();
            this.probeInconclusive = false;
          }
        }
      }
      throw error;
    } finally {
      if (asProbe) this.probing = false;
    }
  }
}

export interface HttpClientOptions {
  readonly name: string;
  readonly baseUrl: string;
  /** Quién llama (`X-Service-Id`). */
  readonly serviceId: string;
  readonly timeoutMs: number;
  /** Reintentos adicionales SOLO para llamadas seguras de repetir (GET, o con Idempotency-Key). */
  readonly retries?: number;
  readonly breaker: BreakerOptions;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string | undefined>;
  /** Con clave, la llamada es idempotente y se puede reintentar. */
  readonly idempotencyKey?: string;
}

export interface HttpResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Cliente HTTP interno (P3.H2.M2). Política:
 *  - `timeout` por llamada (AbortSignal); nunca espera sin límite.
 *  - Reintenta solo errores de la dependencia (red, timeout, 5xx) y solo si la llamada es segura de repetir.
 *  - Los 4xx de negocio se devuelven tal cual: no se reintentan ni cuentan para el breaker.
 *  - Circuit breaker por dependencia.
 */
export class HttpClient {
  readonly breaker: CircuitBreaker;

  constructor(private readonly options: HttpClientOptions) {
    this.breaker = new CircuitBreaker(options.name, options.breaker);
  }

  async request<T = unknown>(request: HttpRequest): Promise<HttpResponse<T>> {
    const retryable = request.method === 'GET' || request.idempotencyKey !== undefined;
    const attempts = 1 + (retryable ? (this.options.retries ?? 1) : 0);
    let last: unknown;
    // Una llamada anterior de ESTE request pudo llegar a la dependencia (timeout, corte, 5xx…): el error final es solo el último y no puede borrarla (regla 11).
    let earlierMayHaveReached = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.breaker.exec(() => this.once<T>(request));
      } catch (error) {
        const surfaced = earlierMayHaveReached && error instanceof UpstreamError ? error.withEarlierAttempt() : error;
        if (error instanceof UpstreamError && !error.provenNotReached) earlierMayHaveReached = true;
        last = surfaced;
        // Con el breaker abierto reintentar no sirve: se corta.
        if (!(error instanceof UpstreamError) || error.kind === 'circuit_open') throw surfaced;
        if (attempt < attempts - 1) await sleep(50 * 2 ** attempt);
      }
    }
    throw last;
  }

  /**
   * Una llamada: un span CLIENTE (el `fetch` global no se instrumenta solo) y, en las cabeceras, el `traceparent` de ese span y el `x-request-id` de la petición de
   * origen (P1.H2.M3). Los reintentos de `request` reutilizan el mismo id: los distingue el span de cada intento, no la cabecera.
   */
  private once<T>(request: HttpRequest): Promise<HttpResponse<T>> {
    return inClientSpan(`${request.method} ${this.options.name}`, { 'peer.service': this.options.name, 'http.request.method': request.method }, (span) => this.exchange<T>(request, span));
  }

  private async exchange<T>(request: HttpRequest, span: Span): Promise<HttpResponse<T>> {
    const base = serviceHeaders(this.options.serviceId, { ...request.headers, 'idempotency-key': request.idempotencyKey });
    // El id de la petición de origen se conserva de extremo a extremo; sin petición de origen (un timer, un consumidor) esta llamada abre el suyo.
    const requestId = isValidRequestId(base['x-request-id']) ? base['x-request-id'] : (currentRequestId() ?? generateRequestId());
    const headers: Record<string, string> = withActiveTraceparent({ ...base, 'x-request-id': requestId });
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // Sin `instanceof Error`: bajo Jest (vm) los errores de fetch vienen de otro realm y el instanceof da falso.
      const name = (error as { name?: string } | null)?.name ?? '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      // `network` es AMBIGUO salvo que se pruebe que la conexión nunca se estableció (rechazada, DNS, inalcanzable): un corte posterior pudo haber llevado la orden.
      throw new UpstreamError(timedOut ? 'timeout' : 'network', this.options.name, undefined, undefined, { notReached: !timedOut && connectionNeverEstablished(error) });
    }
    // Un resultado ambiguo no es un fallo (CLAUDE.md regla 11): un 5xx, un timeout o un 4xx sin el cuerpo de error exacto del
    // contrato NO prueban que la orden no se ejecutó. Se lanza UpstreamError; solo `connector_unavailable` (502) es definitivo y
    // lo reconoce quien llama mirando `problemCode`.
    span.setAttribute('http.response.status_code', response.status);
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new UpstreamError(response.status >= 500 ? 'server_error' : 'unexpected_response', this.options.name, response.status);
      }
    }
    const code = typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : undefined;
    if (response.status >= 500) throw new UpstreamError('server_error', this.options.name, response.status, code);
    if (response.status >= 400 && code === undefined) throw new UpstreamError('unexpected_response', this.options.name, response.status);
    return { status: response.status, body: body as T };
  }
}
