import type { CloudEvent } from './cloudevent';

/** Lo mínimo que se le pide a un cliente de `pg` (o a un `Pool`). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface PoolClientLike extends Queryable {
  release(): void;
}

export interface PoolLike extends Queryable {
  connect(): Promise<PoolClientLike>;
}

/** Destino de los eventos (NATS JetStream en producción). */
export interface EventPublisher {
  /** Debe fallar si el evento no quedó persistido en el destino. */
  publish(subject: string, event: CloudEvent): Promise<void>;
}

export interface EnqueueOptions {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Tema NATS destino. Por defecto `<source sin />.<type>`, por ejemplo `pay-payments.payment_intent.succeeded`. */
  readonly subject?: string;
}

/**
 * Registra un evento en el outbox **dentro de la transacción del llamador**: si esa transacción se deshace,
 * el evento no existe. Pasá el cliente que ya tiene el `BEGIN` abierto.
 */
export async function enqueue(client: Queryable, event: CloudEvent, options: EnqueueOptions): Promise<void> {
  const subject = options.subject ?? `${event.source.replace(/^\//, '')}.${event.type}`;
  await client.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, type, subject, envelope)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [event.id, options.aggregateType, options.aggregateId, event.type, subject, JSON.stringify(event)],
  );
}

export interface RelayOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  /** Se invoca con cada fallo de publicación (para métricas y logs sin datos personales). */
  readonly onError?: (error: Error, eventId: string) => void;
}

/** Clave del candado de asesoría que serializa a los relés de una misma base. */
const RELAY_LOCK_KEY = 7_340_001;

/** Tope del retroceso del relé ante fallos consecutivos. */
const MAX_BACKOFF_MS = 10_000;

/**
 * Lee el outbox en orden y publica. Un candado de asesoría hace que, aunque haya varias réplicas del
 * servicio, **un solo relé drene a la vez**: se conserva el orden por agregado (la autorización antes que la
 * captura). El costo es que el caudal de publicación de un servicio lo limita un relé.
 *
 * Entrega **al menos una vez**: si el proceso muere entre `publish` y el `COMMIT`, el evento se vuelve a
 * publicar. El destino deduplica por `Nats-Msg-Id` y los consumidores por inbox.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  /** Ciclo en curso, para que `stop()` pueda esperarlo. */
  private inflight: Promise<void> | undefined;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly pool: PoolLike,
    private readonly publisher: EventPublisher,
    private readonly options: RelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
  }

  /**
   * Publica hasta `batchSize` eventos pendientes.
   *
   * @returns Cuántos quedaron publicados. Ante un fallo se detiene para no saltear el orden y anota el error.
   */
  async drainOnce(): Promise<number> {
    const client = await this.pool.connect();
    let published = 0;
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [RELAY_LOCK_KEY]);
      if (!lock.rows[0]?.ok) {
        await client.query('ROLLBACK');
        return 0;
      }
      const pending = await client.query(
        `SELECT id, subject, envelope FROM outbox_events
          WHERE published_at IS NULL ORDER BY seq LIMIT $1`,
        [this.batchSize],
      );
      for (const row of pending.rows) {
        const id = row.id as string;
        try {
          await this.publisher.publish(row.subject as string, row.envelope as CloudEvent);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          await client.query('UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
            id,
            error.message.slice(0, 500),
          ]);
          this.options.onError?.(error, id);
          break;
        }
        await client.query('UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = $1', [id]);
        published += 1;
      }
      await client.query('COMMIT');
      return published;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Empieza a drenar cada `pollIntervalMs`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    let failures = 0;
    const cycle = async (): Promise<void> => {
      if (!this.running) return;
      let drained = 0;
      try {
        drained = await this.drainOnce();
        failures = 0;
      } catch (error) {
        failures += 1;
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)), '');
      }
      // Ante un fallo persistente (por ejemplo, la base caída) se espacia: 1×, 2×, 4× … hasta 10 s.
      const delay = failures > 0 ? Math.min(this.pollIntervalMs * 2 ** failures, MAX_BACKOFF_MS) : drained > 0 ? 0 : this.pollIntervalMs;
      if (this.running) this.timer = setTimeout(tick, delay);
    };
    const tick = (): Promise<void> => {
      const run = cycle().finally(() => {
        if (this.inflight === run) this.inflight = undefined;
      });
      this.inflight = run;
      return run;
    };
    this.timer = setTimeout(tick, 0);
  }

  /**
   * Detiene el relé y **espera** a que termine el ciclo en curso (si lo hay): al apagar el servicio no queda una consulta
   * a medias contra un pool ya cerrado. Es seguro no esperarlo (`void relay.stop()`), pero el cierre ordenado sí lo hace.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight;
  }
}
