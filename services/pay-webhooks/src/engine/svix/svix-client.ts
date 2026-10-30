/**
 * Cliente REST mínimo del servidor Svix (sin dependencias nuevas: `fetch` de Node). Cada ruta, cabecera y forma de cuerpo se verificó contra el
 * `/api/v1/openapi.json` de svix-server 1.104.0 en ejecución (la imagen que fija platform/compose.yml) y contra su comportamiento real;
 * ver docs/trabajo/ola-5/P1/INFORME.md. Lo que el OpenAPI no dice y se comprobó a mano está marcado «(observado)».
 *
 * Dos clases de fallo, que NO se mezclan (CLAUDE.md, regla 11):
 * - `SvixApiError`: el servidor respondió con un 4xx definitivo. Es una respuesta, no una duda.
 * - `SvixUnavailableError`: timeout, corte de red, 429 o 5xx. El resultado es AMBIGUO: la orden pudo ejecutarse. Se reintenta con los
 *   MISMOS identificadores (`eventId`, `uid`) y, agotados los intentos, se propaga para que el llamador conserve el estado y reintente
 *   más tarde. Nunca se interpreta como «no se ejecutó».
 */

export const SVIX_CLIENT = Symbol('SVIX_CLIENT');

export class SvixApiError extends Error {
  constructor(
    readonly status: number,
    /** `code` del cuerpo de error de Svix (`conflict`, `not_found`…), o `validation` para un 422. */
    readonly code: string,
  ) {
    super(`Svix respondió ${status} ${code}`);
    this.name = 'SvixApiError';
  }
}

export class SvixUnavailableError extends Error {
  constructor(readonly reason: 'timeout' | 'network' | 'server_error' | 'rate_limited', readonly status?: number) {
    super(`Svix no respondió de forma concluyente: ${reason}${status ? ` (${status})` : ''}`);
    this.name = 'SvixUnavailableError';
  }
}

export interface SvixClientOptions {
  /** `http(s)://host[:puerto]`, sin ruta. */
  readonly baseUrl: string;
  /** JWT firmado con `SVIX_JWT_SECRET` del servidor. Es un secreto: nunca se registra ni sale en un error. */
  readonly authToken: string;
  readonly timeoutMs: number;
  /** Intentos por llamada ante un resultado ambiguo (incluido el primero). */
  readonly maxAttempts: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SvixEndpointOut {
  readonly id: string;
  readonly uid: string | null;
  readonly url: string;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly eventTypes: readonly string[] | null;
}

export interface SvixAttemptOut {
  readonly id: string;
  readonly msgId: string;
  readonly endpointId: string;
  readonly responseStatusCode: number;
  /** `success` | `pending` | `fail` | `sending` */
  readonly statusText: string;
  readonly timestamp: string;
}

export interface SvixMessageOut {
  readonly id: string;
  readonly eventId: string | null;
  readonly eventType: string;
}

export interface CreateEndpointInput {
  readonly uid: string;
  readonly url: string;
  /** `null` = todos los tipos. */
  readonly eventTypes: readonly string[] | null;
  /** `whsec_…` (HMAC) o `whsk_…` (Ed25519). El OpenAPI solo documenta `whsec_`; el servidor acepta `whsk_` (observado). */
  readonly secret: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class SvixClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: SvixClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  // ─── Operaciones ────────────────────────────────────────────────────────────────────────────────────────────

  /** `POST /api/v1/app?get_if_exists=true`: 201 si la crea, 200 si ya existía. Idempotente por `uid`. */
  async ensureApp(uid: string, name: string): Promise<void> {
    await this.call('POST', '/api/v1/app', { query: { get_if_exists: 'true' }, body: { uid, name }, expect: [200, 201] });
  }

  /** `POST /api/v1/event-type`: 201 si la crea, 409 `event_type_exists` si ya está (observado). Ambos son éxito. */
  async ensureEventType(name: string, description: string): Promise<void> {
    try {
      await this.call('POST', '/api/v1/event-type', { body: { name, description }, expect: [201] });
    } catch (error) {
      if (error instanceof SvixApiError && error.status === 409) return;
      throw error;
    }
  }

  /** 201 al crear; `SvixApiError` 409 si ya existe un endpoint con ese `uid` (el llamador decide si es el suyo). */
  async createEndpoint(appUid: string, input: CreateEndpointInput): Promise<void> {
    await this.call('POST', `/api/v1/app/${enc(appUid)}/endpoint`, {
      body: { uid: input.uid, url: input.url, eventTypes: input.eventTypes, secret: input.secret },
      expect: [201],
    });
  }

  /**
   * `GET …/endpoint/{id}/secret`. Con una clave HMAC devuelve la `whsec_…`; con una Ed25519 devuelve la PÚBLICA `whpk_…` (observado), que
   * es justamente lo que se le muestra al comercio. `undefined` si el endpoint no existe.
   */
  async getEndpointKey(appUid: string, endpointUid: string): Promise<string | undefined> {
    try {
      const body = await this.call('GET', `/api/v1/app/${enc(appUid)}/endpoint/${enc(endpointUid)}/secret`, { expect: [200] });
      return isRecord(body) && typeof body.key === 'string' ? body.key : undefined;
    } catch (error) {
      if (error instanceof SvixApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** `POST …/secret/rotate` con la clave nueva y la gracia en segundos. Svix firma con la nueva Y la vieja hasta que venza (observado). */
  async rotateSecret(appUid: string, endpointUid: string, key: string, gracePeriodSeconds: number): Promise<void> {
    // Sin reintento propio: ante un resultado ambiguo el llamador MIRA la clave vigente antes de repetir (una rotación repetida a ciegas empuja la misma clave dos veces).
    await this.call('POST', `/api/v1/app/${enc(appUid)}/endpoint/${enc(endpointUid)}/secret/rotate`, { body: { key, gracePeriodSeconds }, expect: [200], attempts: 1 });
  }

  /** `DELETE`: 204. Un 404 es éxito (ya no está), pero NO se infiere de una duda: solo de la respuesta 404 del servidor. */
  async deleteEndpoint(appUid: string, endpointUid: string): Promise<void> {
    try {
      await this.call('DELETE', `/api/v1/app/${enc(appUid)}/endpoint/${enc(endpointUid)}`, { expect: [204] });
    } catch (error) {
      if (error instanceof SvixApiError && error.status === 404) return;
      throw error;
    }
  }

  /** `PATCH` con `disabled`. Svix deja de entregar y descarta los reintentos pendientes de ese endpoint (observado). */
  async setEndpointDisabled(appUid: string, endpointUid: string, disabled: boolean): Promise<void> {
    await this.call('PATCH', `/api/v1/app/${enc(appUid)}/endpoint/${enc(endpointUid)}`, { body: { disabled }, expect: [200] });
  }

  /** Todos los endpoints de la aplicación (páginas de 100). `undefined` si la aplicación no existe. */
  async listEndpoints(appUid: string): Promise<SvixEndpointOut[] | undefined> {
    const out: SvixEndpointOut[] = [];
    let iterator: string | undefined;
    for (let page = 0; page < 1000; page += 1) {
      let body: unknown;
      try {
        body = await this.call('GET', `/api/v1/app/${enc(appUid)}/endpoint`, { query: { limit: '100', ...(iterator ? { iterator } : {}) }, expect: [200] });
      } catch (error) {
        if (error instanceof SvixApiError && error.status === 404) return undefined;
        throw error;
      }
      if (!isRecord(body) || !Array.isArray(body.data)) throw new SvixApiError(200, 'unexpected_shape');
      for (const raw of body.data) {
        if (isRecord(raw) && typeof raw.id === 'string' && typeof raw.url === 'string' && typeof raw.createdAt === 'string') {
          out.push({
            id: raw.id,
            uid: typeof raw.uid === 'string' ? raw.uid : null,
            url: raw.url,
            disabled: raw.disabled === true,
            createdAt: raw.createdAt,
            eventTypes: Array.isArray(raw.eventTypes) ? (raw.eventTypes as string[]) : null,
          });
        }
      }
      if (body.done === true || typeof body.iterator !== 'string') return out;
      iterator = body.iterator;
    }
    throw new SvixApiError(200, 'too_many_pages');
  }

  /**
   * `POST …/msg` con `eventId`. `created` (202) o `exists` (409: ya hay un mensaje con ese `eventId`; el llamador verifica de quién es).
   * 404 = la aplicación no existe; 422 = cuerpo inválido (p. ej. «Payload must be an object»).
   */
  async createMessage(appUid: string, input: { eventId: string; eventType: string; payload: Record<string, unknown> }): Promise<'created' | 'exists'> {
    try {
      await this.call('POST', `/api/v1/app/${enc(appUid)}/msg`, { body: input, expect: [202] });
      return 'created';
    } catch (error) {
      if (error instanceof SvixApiError && error.status === 409) return 'exists';
      throw error;
    }
  }

  /** `GET …/msg/{eventId}`: Svix acepta el `id` (`msg_…`) o el `eventId` (observado). `undefined` si esa aplicación no lo tiene. */
  async getMessage(appUid: string, idOrEventId: string): Promise<SvixMessageOut | undefined> {
    try {
      const body = await this.call('GET', `/api/v1/app/${enc(appUid)}/msg/${enc(idOrEventId)}`, { expect: [200] });
      if (!isRecord(body) || typeof body.id !== 'string' || typeof body.eventType !== 'string') throw new SvixApiError(200, 'unexpected_shape');
      return { id: body.id, eventId: typeof body.eventId === 'string' ? body.eventId : null, eventType: body.eventType };
    } catch (error) {
      if (error instanceof SvixApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Últimos intentos del endpoint con respuesta 4xx (`status_code_class=400`), del más nuevo al más viejo. */
  async listClientErrorAttempts(appUid: string, endpointUid: string, options: { after?: Date; limit?: number } = {}): Promise<SvixAttemptOut[]> {
    const body = await this.call('GET', `/api/v1/app/${enc(appUid)}/attempt/endpoint/${enc(endpointUid)}`, {
      query: { status_code_class: '400', limit: String(options.limit ?? 100), ...(options.after ? { after: options.after.toISOString() } : {}) },
      expect: [200],
    });
    if (!isRecord(body) || !Array.isArray(body.data)) throw new SvixApiError(200, 'unexpected_shape');
    return body.data.flatMap((raw): SvixAttemptOut[] =>
      isRecord(raw) && typeof raw.id === 'string' && typeof raw.msgId === 'string' && typeof raw.endpointId === 'string' && typeof raw.responseStatusCode === 'number' && typeof raw.timestamp === 'string'
        ? [{ id: raw.id, msgId: raw.msgId, endpointId: raw.endpointId, responseStatusCode: raw.responseStatusCode, statusText: String(raw.statusText), timestamp: raw.timestamp }]
        : [],
    );
  }

  // ─── Transporte ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Una llamada con reintento SOLO ante un resultado ambiguo (timeout, red, 429, 5xx), con espera creciente. Un 4xx definitivo sale como
   * `SvixApiError` sin reintentar. `expect` son los 2xx que significan éxito; otro 2xx es una respuesta inesperada (no se adivina).
   * Público para que las pruebas lean el estado de Svix (p. ej. listar mensajes) con la misma autenticación.
   */
  async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, options: { query?: Record<string, string>; body?: unknown; expect: readonly number[]; attempts?: number }): Promise<unknown> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    let last: SvixUnavailableError | undefined;
    const maxAttempts = options.attempts ?? this.options.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) await this.sleep(Math.min(200 * 2 ** (attempt - 2), 2_000));
      try {
        const response = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${this.options.authToken}`, accept: 'application/json', ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: AbortSignal.timeout(this.options.timeoutMs),
          redirect: 'error',
        });
        const text = await response.text();
        if (response.status === 429) {
          last = new SvixUnavailableError('rate_limited', 429);
          continue;
        }
        if (response.status >= 500) {
          last = new SvixUnavailableError('server_error', response.status);
          continue;
        }
        if (options.expect.includes(response.status)) return text === '' ? undefined : (JSON.parse(text) as unknown);
        throw new SvixApiError(response.status, errorCode(response.status, text));
      } catch (error) {
        if (error instanceof SvixApiError) throw error;
        last = new SvixUnavailableError(isTimeout(error) ? 'timeout' : 'network');
      }
    }
    throw last ?? new SvixUnavailableError('network');
  }
}

const enc = encodeURIComponent;

function isTimeout(error: unknown): boolean {
  // Sin `instanceof Error`: el DOMException de `AbortSignal.timeout` puede venir de otro «realm» (VM de pruebas, librerías).
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** `code` del cuerpo de error de Svix; un 422 trae `detail` como lista y se resume como `validation`. Nunca se copia texto del cuerpo. */
function errorCode(status: number, text: string): string {
  try {
    const body = JSON.parse(text) as unknown;
    if (isRecord(body) && typeof body.code === 'string' && /^[a-z_]{1,64}$/.test(body.code)) return body.code;
  } catch {
    /* cuerpo no JSON */
  }
  return status === 422 ? 'validation' : `http_${status}`;
}
