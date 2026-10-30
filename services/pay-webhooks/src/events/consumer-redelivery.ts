import type { ConsumerConfig, JetStreamManager } from 'nats';

/**
 * Reentrega de los consumidores durables (RE-REVISION-DINERO F-B2).
 *
 * Medido contra nats-server 2.10.29: con `max_deliver: N` el mensaje deja de entregarse a ese consumidor tras N entregas (por `nak` o por
 * `ack_wait` vencido), queda en el stream, el consumidor lo da por «no pendiente» (`num_ack_pending: 0`, `ack_floor` atrás) y solo sale un aviso
 * `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.*` que nadie escucha. Para un evento que NO debe perderse y cuyo efecto es idempotente (inbox) eso es
 * un hueco: una caída del destino más larga que N reentregas lo deja varado para siempre.
 *
 * Por eso estos consumidores usan `max_deliver: -1` (sin tope) y la espera tras un fallo la fija el CÓDIGO (`redeliveryDelayMs`: creciente y
 * acotada, según `message.info.deliveryCount`). NO se usa el `backoff` del servidor, aunque la API (`nats` 2.29) lo acepte, porque se midió que
 * choca con el `nak(retardo)`: con `backoff` configurado, el retardo explícito solo vale para la primera reentrega y las siguientes esperan los
 * intervalos del `backoff` (30 s, 60 s…), y un `nak()` sin retardo reentrega al instante (14 529 entregas en 4 s). Sin `backoff`, `nak(retardo)`
 * se respeta en cada entrega. Lo no confirmado (caída del proceso, lote abandonado) se reentrega a los `ack_wait` (30 s): no hay giro en caliente.
 *
 * Lo que sí es definitivo (`term`: JSON ilegible, contrato roto, rechazo del motor) no se reintenta nunca, así que el «sin tope» no hace girar
 * eventos venenosos.
 */
export interface RedeliveryPolicy {
  /** Espera tras el primer fallo; se duplica en cada entrega siguiente. */
  readonly baseMs: number;
  /** Tope de la espera. */
  readonly capMs: number;
}

export const DEFAULT_REDELIVERY: RedeliveryPolicy = { baseMs: 2_000, capMs: 300_000 };

/** A partir de esta entrega un evento sin resolver es una alerta (el log lleva `alert: true`), no un reintento rutinario. */
export const STUCK_ALERT_DELIVERIES = 10;

/** `ack_wait` del servidor para lo no confirmado, en nanosegundos (el mismo valor por defecto de antes, ahora explícito). */
export const ACK_WAIT_NS = 30_000_000_000;

/** Espera antes de la siguiente entrega: `base · 2^(n-1)` acotada por `cap`, con `n` = veces que ya se entregó (mínimo 1). Nunca menos de `floorMs`. */
export function redeliveryDelayMs(deliveryCount: number, policy: RedeliveryPolicy = DEFAULT_REDELIVERY, floorMs = 0): number {
  const n = Number.isFinite(deliveryCount) && deliveryCount >= 1 ? Math.floor(deliveryCount) : 1;
  const exponent = Math.min(n - 1, 30);
  return Math.max(floorMs, Math.min(policy.capMs, policy.baseMs * 2 ** exponent));
}

/** Campos de log de un evento que se reintenta; `alert: true` cuando lleva demasiadas entregas. */
export function retryLogFields(deliveryCount: number): { delivery_count: number; alert?: true } {
  return { delivery_count: deliveryCount, ...(deliveryCount >= STUCK_ALERT_DELIVERIES ? { alert: true as const } : {}) };
}

/** Lo que cada servicio fija de su durable; el resto de la configuración la declara el llamador. */
export type DurableSpec = Partial<Omit<ConsumerConfig, 'max_deliver' | 'backoff' | 'ack_wait'>> & { durable_name: string };

export type EnsureResult = 'created' | 'unchanged' | 'migrated';

interface ErrorLike {
  code?: unknown;
  api_error?: { err_code?: number; code?: number };
}

const isConsumerNotFound = (error: unknown): boolean => {
  const e = error as ErrorLike | null;
  return e?.api_error?.err_code === 10014 || e?.api_error?.code === 404 || String(e?.code) === '404';
};

/**
 * Crea el durable sin tope de entregas, o MIGRA uno ya existente con la configuración vieja (`max_deliver: 20`).
 *
 * Medido: `consumers.add` sobre un durable existente con OTRA configuración falla (`consumer already exists`, 10148) y con la misma es idempotente;
 * `consumers.update` cambia `max_deliver` y `ack_wait` sin tocar la posición del consumidor. Por eso se mira primero y se actualiza solo lo que difiere.
 *
 * Los mensajes que ya agotaron las 20 entregas ANTES de migrar siguen varados (el servidor los dio de baja del consumidor): subir el tope no los
 * revive. Si el consumidor tiene el `ack_floor` atrás sin nada pendiente se avisa (`warn`); el procedimiento está en docs/runbooks/sandbox-a-produccion.md.
 */
export async function ensureUnlimitedDurable(
  manager: JetStreamManager,
  stream: string,
  spec: DurableSpec,
  warn: (fields: Record<string, unknown>, message: string) => void = () => undefined,
): Promise<EnsureResult> {
  const wanted = { max_deliver: -1, ack_wait: ACK_WAIT_NS };
  let existing;
  try {
    existing = await manager.consumers.info(stream, spec.durable_name);
  } catch (error) {
    if (!isConsumerNotFound(error)) throw error;
  }
  if (!existing) {
    await manager.consumers.add(stream, { ...spec, ...wanted });
    return 'created';
  }
  const config = existing.config;
  if (config.max_deliver === -1 && config.ack_wait === wanted.ack_wait && !config.backoff?.length) return 'unchanged';
  const stranded = existing.num_ack_pending === 0 && existing.ack_floor.stream_seq < existing.delivered.stream_seq;
  await manager.consumers.update(stream, spec.durable_name, wanted);
  warn(
    { stream, durable: spec.durable_name, previous_max_deliver: config.max_deliver, ...(stranded ? { possibly_stranded: true, alert: true } : {}) },
    stranded
      ? 'Consumidor migrado a entrega sin tope; el ack_floor está atrás sin pendientes: pueden quedar eventos varados por el tope anterior (ver runbook)'
      : 'Consumidor migrado a entrega sin tope',
  );
  return 'migrated';
}
