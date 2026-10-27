import { createHash, randomUUID } from 'node:crypto';
import { ProblemError, type ProblemDetails } from '@pay/problem';

/**
 * Idempotency-Key sobre PostgreSQL, con fases atómicas y puntos de recuperación
 * (diseño de Brandur Leach, «Implementing Stripe-like Idempotency Keys in Postgres»).
 *
 * - La clave se **reclama con un único `INSERT … ON CONFLICT DO NOTHING`**: nunca «leer y después escribir».
 * - Misma clave + mismo pedido → se repite la respuesta guardada. Misma clave + otro pedido → 422.
 * - Una ejecución en curso responde 409; si su bloqueo venció (el proceso murió), otra la retoma con
 *   compare-and-set desde su último punto de recuperación.
 * - Un error de negocio determinista (`ProblemError` < 500) se guarda y se repite. Un error inesperado o 5xx
 *   libera el bloqueo para que el reintento pueda continuar.
 *
 * ATENCIÓN con los errores transitorios: **todo `ProblemError` con estado < 500 se guarda y se repite para siempre (24 h)**, aunque
 * la causa fuera pasajera. Un fallo que el cliente deba poder reintentar con la misma clave tiene que ser un `5xx` (que NO se guarda);
 * si se lanza como `4xx`, la clave queda inutilizable hasta que venza y el cliente tiene que usar otra.
 */

/** Lo mínimo que se le pide a un cliente de `pg` (o a un `Pool`). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** Cliente con una conexión propia, para las transacciones de las fases atómicas. */
export interface PoolClientLike extends Queryable {
  release(): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
}

export interface IdempotencyOptions {
  /** Cuánto vale un bloqueo antes de considerar muerto al proceso que lo tomó. */
  readonly lockTimeoutMs?: number;
  /** Cuánto se conserva una clave (Stripe: 24 h). */
  readonly ttlMs?: number;
  /** Si > 0, una petición concurrente espera hasta ese tiempo a que termine la primera en vez de recibir 409. */
  readonly waitForCompletionMs?: number;
}

export interface IdempotencyRequest {
  readonly scope: string;
  readonly key: string;
  /** Ver {@link hashRequest}. */
  readonly requestHash: string;
}

export interface HandlerResult<T = unknown> {
  readonly status: number;
  readonly body: T;
}

export interface IdempotencyResult<T = unknown> extends HandlerResult<T> {
  /** `true` si se devolvió la respuesta guardada sin ejecutar nada. */
  readonly replayed: boolean;
}

/** Contexto que recibe el manejador. */
export interface IdempotencyContext {
  /** Último punto de recuperación persistido (`'started'` en la primera ejecución). */
  readonly recoveryPoint: string;
  /**
   * Ejecuta `work` en una transacción y, en la **misma** transacción, avanza el punto de recuperación.
   * O pasan las dos cosas o ninguna.
   */
  atomic<R>(nextRecoveryPoint: string, work: (client: Queryable) => Promise<R>): Promise<R>;
}

interface Row {
  request_hash: string;
  state: 'started' | 'completed';
  recovery_point: string;
  response_status: number | null;
  response_body: unknown;
  locked_at: Date | null;
  lock_token: string | null;
}

const DEFAULTS = { lockTimeoutMs: 30_000, ttlMs: 24 * 60 * 60 * 1000, waitForCompletionMs: 0 } as const;

/** JSON con las claves ordenadas, para que el mismo pedido dé siempre el mismo hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash del pedido: método + ruta + cuerpo canónico. */
export function hashRequest(request: { method: string; path: string; body?: unknown }): string {
  return createHash('sha256')
    .update(`${request.method.toUpperCase()} ${request.path}\n${canonicalJson(request.body ?? null)}`)
    .digest('hex');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class IdempotencyStore {
  private readonly options: Required<IdempotencyOptions>;

  constructor(
    private readonly pool: PoolLike,
    options: IdempotencyOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /**
   * Ejecuta `handler` una sola vez por `(scope, key)`.
   *
   * @throws ProblemError `idempotency_key_reused` (422) si la clave se usó con otro pedido;
   *   `idempotency_request_in_progress` (409) si otra ejecución sigue viva.
   */
  async execute<T>(
    request: IdempotencyRequest,
    handler: (context: IdempotencyContext) => Promise<HandlerResult<T>>,
  ): Promise<IdempotencyResult<T>> {
    const deadline = Date.now() + this.options.waitForCompletionMs;
    for (;;) {
      const claim = await this.claim(request);
      if (claim.kind === 'replay') return { status: claim.status, body: claim.body as T, replayed: true };
      if (claim.kind === 'busy') {
        if (Date.now() < deadline) {
          await sleep(25);
          continue;
        }
        throw new ProblemError('idempotency_request_in_progress');
      }
      return this.run(request, claim.recoveryPoint, claim.token, handler);
    }
  }

  /** Borra las claves vencidas. Pensado para un job periódico. */
  async purgeExpired(): Promise<number> {
    const result = await this.pool.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
    return result.rowCount ?? 0;
  }

  private async claim(request: IdempotencyRequest): Promise<
    | { kind: 'owned'; recoveryPoint: string; token: string }
    | { kind: 'replay'; status: number; body: unknown }
    | { kind: 'busy' }
  > {
    const { scope, key, requestHash } = request;
    // Una clave vencida deja de existir; se borra antes de reclamar.
    await this.pool.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2 AND expires_at < now()', [scope, key]);

    const token = randomUUID();
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash, state, locked_at, lock_token, expires_at)
       VALUES ($1, $2, $3, 'started', now(), $5, now() + ($4 || ' milliseconds')::interval)
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING 1`,
      [scope, key, requestHash, String(this.options.ttlMs), token],
    );
    if (inserted.rows.length === 1) return { kind: 'owned', recoveryPoint: 'started', token };

    const found = await this.pool.query(
      `SELECT request_hash, state, recovery_point, response_status, response_body, locked_at, lock_token
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const row = found.rows[0] as unknown as Row | undefined;
    if (!row) return this.claim(request); // la borró el job de limpieza entre el INSERT y el SELECT
    if (row.request_hash !== requestHash) throw new ProblemError('idempotency_key_reused');
    if (row.state === 'completed') {
      return { kind: 'replay', status: row.response_status as number, body: row.response_body };
    }

    // `started`: viva si el bloqueo es reciente; si no, se retoma con compare-and-set sobre `lock_token`.
    const stale =
      row.locked_at === null || Date.now() - new Date(row.locked_at).getTime() > this.options.lockTimeoutMs;
    if (!stale) return { kind: 'busy' };
    const taken = await this.pool.query(
      `UPDATE idempotency_keys SET locked_at = now(), lock_token = $4
        WHERE scope = $1 AND key = $2 AND state = 'started' AND lock_token IS NOT DISTINCT FROM $3
        RETURNING 1`,
      [scope, key, row.lock_token, token],
    );
    if (taken.rows.length === 0) return { kind: 'busy' }; // otro proceso la retomó primero
    return { kind: 'owned', recoveryPoint: row.recovery_point, token };
  }

  private async run<T>(
    request: IdempotencyRequest,
    startPoint: string,
    token: string,
    handler: (context: IdempotencyContext) => Promise<HandlerResult<T>>,
  ): Promise<IdempotencyResult<T>> {
    const { scope, key } = request;
    let recoveryPoint = startPoint;
    const context: IdempotencyContext = {
      get recoveryPoint() {
        return recoveryPoint;
      },
      atomic: async (nextRecoveryPoint, work) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const outcome = await work(client);
          const moved = await client.query(
            `UPDATE idempotency_keys SET recovery_point = $3
              WHERE scope = $1 AND key = $2 AND state = 'started' AND lock_token = $4`,
            [scope, key, nextRecoveryPoint, token],
          );
          if (moved.rowCount !== 1) throw new Error('Se perdió el bloqueo de la Idempotency-Key');
          await client.query('COMMIT');
          recoveryPoint = nextRecoveryPoint;
          return outcome;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };

    try {
      const result = await handler(context);
      await this.complete(scope, key, token, result.status, result.body);
      return { ...result, replayed: false };
    } catch (error) {
      if (error instanceof ProblemError && error.status < 500) {
        const body: ProblemDetails = error.toProblem();
        await this.complete(scope, key, token, error.status, body);
        return { status: error.status, body: body as unknown as T, replayed: false };
      }
      // Error inesperado o 5xx: se libera el bloqueo para que el reintento retome desde el último punto.
      await this.pool.query(
        `UPDATE idempotency_keys SET locked_at = NULL, lock_token = NULL
          WHERE scope = $1 AND key = $2 AND state = 'started' AND lock_token = $3`,
        [scope, key, token],
      );
      throw error;
    }
  }

  private async complete(scope: string, key: string, token: string, status: number, body: unknown): Promise<void> {
    const done = await this.pool.query(
      `UPDATE idempotency_keys
          SET state = 'completed', recovery_point = 'completed', response_status = $4, response_body = $5::jsonb, locked_at = NULL, lock_token = NULL
        WHERE scope = $1 AND key = $2 AND state = 'started' AND lock_token = $3`,
      [scope, key, token, status, JSON.stringify(body ?? null)],
    );
    if (done.rowCount !== 1) throw new Error('Se perdió el bloqueo de la Idempotency-Key antes de completar');
  }
}

