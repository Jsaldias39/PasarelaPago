import type { SecretProvider } from './secrets';

/**
 * [P4.H2.M6] `SecretProvider` respaldado por OpenBao (KV v2). Rutas verificadas contra el servidor 2.7.2 (`sys/internal/specs/openapi`):
 *   GET  /v1/<mount>/data/<ruta>[?version=N]   → 200 {data:{data:{value}, metadata:{version, created_time, deletion_time, destroyed}}}
 *                                              → 404 con `metadata.deletion_time` (versión borrada) o `metadata.destroyed` (destruida); 404 `{"errors":[]}` si no existe
 *                                              → 403 {"errors":["permission denied"]}
 *   POST /v1/auth/approle/login {role_id, secret_id} → {auth:{client_token, lease_duration}}
 * Cabecera de autenticación: `X-Vault-Token`.
 *
 * Disposición: `<mount>/data/<prefijo>/<modo>/<NOMBRE>` con `NOMBRE` = `CONNECTOR_<CODIGO>_<SECRETO>`; el modo (`sandbox` | `live`) sale de la
 * configuración del servicio y jamás de la entrada. Cada conector recibe una política que solo lee `…/<modo>/CONNECTOR_<CODIGO>_*`.
 * El valor vive en el campo `value`.
 *
 * Contrato (el mismo de `SecretProvider`): `[]` ⇒ no hay secreto ⇒ quien verifica rechaza. FAIL-CLOSED: OpenBao caído, lento, 403, 404, versión
 * borrada o destruida, respuesta ilegible, nombre sospechoso ⇒ `[]`. Nunca un valor por defecto, nunca el último valor conocido vencido el caché.
 *
 * Rotación SIN CORTE: cada escritura nueva en KV v2 crea una versión. Son vigentes la última (N) y la anterior (N-1) mientras N-1 no esté borrada ni
 * destruida y N haya sido creada hace menos de `rotationWindowMs`. El operador cierra la ventana antes borrando N-1. Si la última está borrada o
 * destruida NO se cae a una anterior: se rechaza todo (fail-closed) hasta que haya una vigente.
 *
 * Este módulo nunca registra valores: los eventos de diagnóstico (`onEvent`) no tienen campo para ellos, y los mensajes de error no copian cuerpos de respuesta.
 */

export type OpenBaoAuth = { readonly kind: 'token'; readonly token: string } | { readonly kind: 'approle'; readonly roleId: string; readonly secretId: string };

export interface OpenBaoEvent {
  readonly kind: 'rejected_name' | 'unreachable' | 'timeout' | 'login_failed' | 'denied' | 'missing' | 'deleted' | 'malformed' | 'redirect' | 'http_error';
  readonly name?: string;
  readonly status?: number;
}

export interface OpenBaoSecretOptions {
  /** Base de OpenBao, p. ej. `https://openbao.interno:8200` (sin ruta). */
  readonly addr: string;
  /** Modo del servicio: separa las rutas de sandbox y de live. */
  readonly mode: 'sandbox' | 'live';
  readonly mount: string;
  readonly pathPrefix: string;
  readonly auth: OpenBaoAuth;
  /** Vigencia del caché por nombre (0 = sin caché). Es también la demora máxima para ver una rotación. */
  readonly cacheTtlMs: number;
  /** Cuánto sigue vigente la versión anterior tras crearse la nueva. */
  readonly rotationWindowMs: number;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly onEvent?: (event: OpenBaoEvent) => void;
}

/** Un nombre de secreto: `CONNECTOR_<CODIGO>_<SECRETO>`, mayúsculas, dígitos y guion bajo. Sin `/`, `.`, `%`, `?` ni espacios: no puede salirse de su ruta. */
export const SECRET_NAME = /^CONNECTOR_[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
const MAX_NAME = 128;
const MAX_VALUE = 8192;
const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

/** Valida mount y prefijo (se concatenan en la URL): segmentos en minúsculas separados por `/`, sin `.` ni `..`. */
export function isSafePath(path: string): boolean {
  return path.split('/').every((segment) => SEGMENT.test(segment));
}

type Read =
  | { readonly kind: 'ok'; readonly version: number; readonly createdAt: number | undefined; readonly value: string }
  | { readonly kind: 'gone' } // borrada, destruida o inexistente
  | { readonly kind: 'failed' }; // no se pudo saber (red, 403, 5xx, ilegible)

interface CacheEntry {
  readonly values: readonly string[];
  readonly expiresAt: number;
}

export class OpenBaoSecretProvider implements SecretProvider {
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly base: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<readonly string[]>>();
  private session: { token: string; refreshAt: number } | undefined;
  private loginInflight: Promise<string | undefined> | undefined;

  constructor(private readonly options: OpenBaoSecretOptions) {
    if (!isSafePath(options.mount) || !isSafePath(options.pathPrefix)) throw new Error('OpenBao: mount o prefijo de ruta inválido');
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.base = `${options.addr.replace(/\/+$/, '')}/v1`;
  }

  /** Olvida lo cacheado (de un nombre, o todo): la siguiente lectura va a OpenBao. Para rotar y ver la versión nueva sin esperar el TTL. */
  invalidate(name?: string): void {
    if (name === undefined) this.cache.clear();
    else this.cache.delete(name);
  }

  async getSecrets(name: string): Promise<readonly string[]> {
    if (typeof name !== 'string' || name.length > MAX_NAME || !SECRET_NAME.test(name)) {
      this.emit({ kind: 'rejected_name' }); // no se registra el nombre recibido: viene de fuera
      return [];
    }
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > this.now()) return hit.values;
    const pending = this.inflight.get(name);
    if (pending) return pending;
    const task = this.load(name).finally(() => this.inflight.delete(name));
    this.inflight.set(name, task);
    return task;
  }

  private async load(name: string): Promise<readonly string[]> {
    const current = await this.read(name);
    if (current.kind !== 'ok') return []; // sin vigente no hay secreto; tampoco se cachea (un fallo no se «recuerda»)
    const values = [current.value];
    let complete = true;
    const inWindow = current.createdAt !== undefined && this.now() - current.createdAt <= this.options.rotationWindowMs;
    if (current.version > 1 && inWindow) {
      const previous = await this.read(name, current.version - 1);
      if (previous.kind === 'ok' && previous.version === current.version - 1 && previous.value !== current.value) values.push(previous.value);
      else if (previous.kind === 'failed') complete = false;
    }
    if (complete && this.options.cacheTtlMs > 0) this.cache.set(name, { values, expiresAt: this.now() + this.options.cacheTtlMs });
    return values;
  }

  private path(name: string, version?: number): string {
    const { mount, pathPrefix, mode } = this.options;
    return `${this.base}/${mount}/data/${pathPrefix}/${mode}/${name}${version === undefined ? '' : `?version=${version}`}`;
  }

  private async read(name: string, version?: number): Promise<Read> {
    const token = await this.token();
    if (token === undefined) return { kind: 'failed' };
    const response = await this.send(this.path(name, version), { method: 'GET', headers: { 'X-Vault-Token': token } }, name);
    if (response === undefined) return { kind: 'failed' };
    if (response.status === 404) {
      const metadata = (await json(response))?.data?.metadata as { deletion_time?: unknown; destroyed?: unknown } | undefined;
      const deleted = metadata !== undefined && ((typeof metadata.deletion_time === 'string' && metadata.deletion_time !== '') || metadata.destroyed === true);
      this.emit({ kind: deleted ? 'deleted' : 'missing', name, status: 404 });
      return { kind: 'gone' };
    }
    if (response.status === 403) {
      this.emit({ kind: 'denied', name, status: 403 });
      this.session = undefined; // un token revocado también da 403: la próxima lectura se reautentica en vez de esperar al vencimiento
      return { kind: 'failed' };
    }
    if (response.status >= 300 && response.status < 400) {
      this.emit({ kind: 'redirect', name, status: response.status }); // no se sigue: el token no viaja a otro destino
      return { kind: 'failed' };
    }
    if (response.status !== 200) {
      this.emit({ kind: 'http_error', name, status: response.status });
      return { kind: 'failed' };
    }
    const body = await json(response);
    const meta = body?.data?.metadata as { version?: unknown; created_time?: unknown } | undefined;
    const value = (body?.data?.data as { value?: unknown } | null | undefined)?.value;
    if (typeof value !== 'string' || value === '' || value.length > MAX_VALUE || typeof meta?.version !== 'number' || !Number.isInteger(meta.version) || meta.version < 1) {
      this.emit({ kind: 'malformed', name, status: 200 });
      return { kind: 'failed' };
    }
    const created = typeof meta.created_time === 'string' ? Date.parse(meta.created_time) : Number.NaN;
    return { kind: 'ok', version: meta.version, createdAt: Number.isNaN(created) ? undefined : created, value };
  }

  /** Una llamada HTTP con tope de tiempo; sin seguir redirecciones. `undefined` = no hubo respuesta. */
  private async send(url: string, init: RequestInit, name?: string): Promise<Response | undefined> {
    try {
      return await this.doFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      // Por nombre y no con `instanceof`: la DOMException del tope de tiempo puede venir de otro «realm» (p. ej. el sandbox de Jest) y no ser `instanceof Error` aquí.
      const errorName = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
      const timedOut = errorName === 'TimeoutError' || errorName === 'AbortError';
      this.emit({ kind: timedOut ? 'timeout' : 'unreachable', ...(name ? { name } : {}) });
      return undefined;
    }
  }

  /** Token vigente: el estático, o el de AppRole (se renueva con el 80 % de su vida; una sola autenticación a la vez). */
  private async token(): Promise<string | undefined> {
    const { auth } = this.options;
    if (auth.kind === 'token') return auth.token;
    if (this.session && this.now() < this.session.refreshAt) return this.session.token;
    this.loginInflight ??= this.login(auth).finally(() => {
      this.loginInflight = undefined;
    });
    return this.loginInflight;
  }

  private async login(auth: Extract<OpenBaoAuth, { kind: 'approle' }>): Promise<string | undefined> {
    this.session = undefined;
    const response = await this.send(`${this.base}/auth/approle/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role_id: auth.roleId, secret_id: auth.secretId }) });
    if (response === undefined) return undefined;
    if (response.status !== 200) {
      this.emit({ kind: 'login_failed', status: response.status });
      return undefined;
    }
    const granted = (await json(response))?.auth as { client_token?: unknown; lease_duration?: unknown } | undefined;
    if (typeof granted?.client_token !== 'string' || granted.client_token === '' || typeof granted.lease_duration !== 'number') {
      this.emit({ kind: 'login_failed', status: 200 });
      return undefined;
    }
    // lease_duration 0 = el token no vence: se reautentica igual cada hora para no depender de ello.
    const lifeMs = granted.lease_duration > 0 ? granted.lease_duration * 1000 : 3_600_000;
    this.session = { token: granted.client_token, refreshAt: this.now() + lifeMs * 0.8 };
    return granted.client_token;
  }

  private emit(event: OpenBaoEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      // el diagnóstico nunca puede romper una lectura
    }
  }
}

/** JSON de una respuesta, o `undefined` si no lo es. Nunca incluye el texto en un error. */
async function json(response: Response): Promise<{ data?: Record<string, unknown>; auth?: Record<string, unknown> } | undefined> {
  try {
    const parsed: unknown = await response.json();
    return parsed !== null && typeof parsed === 'object' ? (parsed as { data?: Record<string, unknown>; auth?: Record<string, unknown> }) : undefined;
  } catch {
    return undefined;
  }
}
