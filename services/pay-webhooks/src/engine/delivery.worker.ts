import { randomInt } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { signedHeaders } from '@pay/webhook-signature';
import type { ServiceConfig } from '../config';
import { SecretBox } from '../crypto/secret-box';
import { disableEndpoint, findEndpoint } from '../endpoints/endpoint.repository';
import type { EndpointRecord } from '../endpoints/endpoint.types';
import { TargetGuard, TargetRejectedError } from '../ssrf/target-guard';
import { TransportError, type DeliveryTransport } from '../ssrf/https-transport';
import type { Clock } from './delivery-engine';

interface Claimed {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: string;
  attempts: number;
}

export interface RunSummary {
  readonly claimed: number;
  readonly succeeded: number;
  readonly retrying: number;
  readonly dead: number;
}

const USER_AGENT = 'ALOVIDA-Pay-Webhooks/1';

/**
 * Entrega las notificaciones vencidas del motor en proceso. Cada ejecución:
 * 1. RECLAMA un lote con `FOR UPDATE SKIP LOCKED` y un arriendo (`next_attempt_at` hacia adelante): dos trabajadores nunca
 *    toman la misma entrega, y si uno muere el arriendo vence y otro la retoma;
 * 2. RE-VALIDA el destino (SSRF, rebinding) y fija la IP resuelta: solo se conecta a una IP pública;
 * 3. firma con TODOS los secretos vigentes (durante una rotación, dos firmas), con `webhook-id` fijo y marca de tiempo nueva;
 * 4. aplica el resultado: 2xx ⇒ entregada; 410 ⇒ endpoint deshabilitado y sin reintentos; otro ⇒ reintento con la escalera
 *    (con jitter) o, agotada, `dead`. Un endpoint con demasiadas entregas agotadas seguidas se deshabilita.
 */
export class DeliveryWorker {
  private readonly logger = new Logger(DeliveryWorker.name);

  constructor(
    private readonly pool: Pool,
    private readonly config: ServiceConfig,
    private readonly box: SecretBox,
    private readonly guard: TargetGuard,
    private readonly transport: DeliveryTransport,
    private readonly clock: Clock,
    private readonly random: () => number = () => randomInt(0, 1_000_000) / 1_000_000,
  ) {}

  async runOnce(): Promise<RunSummary> {
    const now = this.clock.now();
    const claimed = await this.claim(now);
    const summary = { claimed: claimed.length, succeeded: 0, retrying: 0, dead: 0 };
    // Endpoints en paralelo entre sí; dentro de un endpoint, hasta `perEndpointConcurrency` a la vez. Así uno lento no frena al resto.
    const byEndpoint = new Map<string, Claimed[]>();
    for (const delivery of claimed) byEndpoint.set(delivery.endpoint_id, [...(byEndpoint.get(delivery.endpoint_id) ?? []), delivery]);
    await Promise.all(
      [...byEndpoint.values()].map(async (queue) => {
        const lanes = Array.from({ length: queue.length }, async () => {
          for (let next = queue.shift(); next; next = queue.shift()) summary[await this.deliver(next)] += 1;
        });
        await Promise.all(lanes);
      }),
    );
    return summary;
  }

  private async claim(now: Date): Promise<Claimed[]> {
    const { batchSize, leaseMs, perEndpointBatch } = this.config.delivery;
    // `due` numera las vencidas de cada endpoint para que ninguno monopolice el lote; el candado (SKIP LOCKED) va en la consulta
    // que además repite `status` y `next_attempt_at`, así un reclamo concurrente que ya cambió la fila no se vuelve a tomar.
    const result = await this.pool.query(
      `WITH due AS (
         SELECT id, row_number() OVER (PARTITION BY endpoint_id ORDER BY next_attempt_at, id) AS rn
           FROM webhook_deliveries
          WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz),
       picked AS (
         SELECT d.id FROM webhook_deliveries d JOIN due ON due.id = d.id
          WHERE d.status = 'pending' AND d.next_attempt_at <= $1::timestamptz AND due.rn <= $4
          ORDER BY d.next_attempt_at, d.id
          LIMIT $2
          FOR UPDATE OF d SKIP LOCKED)
       UPDATE webhook_deliveries d
          SET attempts = d.attempts + 1, next_attempt_at = $1::timestamptz + ($3 || ' milliseconds')::interval
         FROM picked
        WHERE d.id = picked.id
       RETURNING d.id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts`,
      [now.toISOString(), batchSize, String(leaseMs), perEndpointBatch],
    );
    return result.rows as unknown as Claimed[];
  }

  private async deliver(delivery: Claimed): Promise<'succeeded' | 'retrying' | 'dead'> {
    const started = this.clock.now();
    const endpoint = await findEndpoint(this.pool, delivery.endpoint_id);
    if (!endpoint || endpoint.status !== 'enabled') {
      await this.finish(delivery, 'dead', { error: 'endpoint_disabled' });
      return 'dead';
    }

    let statusCode: number | null = null;
    let errorCode: string | null = null;
    try {
      const target = await this.guard.check(endpoint.url);
      const headers = await this.signedRequestHeaders(endpoint, delivery, started);
      const response = await this.transport.send({ target, headers, body: delivery.payload, timeoutMs: this.config.delivery.timeoutMs, idleTimeoutMs: Math.min(this.config.delivery.timeoutMs, 10_000) });
      statusCode = response.status;
    } catch (error) {
      errorCode = error instanceof TargetRejectedError ? `ssrf_${error.reason}` : error instanceof TransportError ? error.reason : 'internal_error';
      if (errorCode === 'internal_error') this.logger.error({ delivery_id: delivery.id, err: error instanceof Error ? error.name : 'desconocido' }, 'La entrega falló por un error interno');
    }
    const durationMs = Math.max(0, this.clock.now().getTime() - started.getTime());
    await this.pool.query(
      `INSERT INTO webhook_delivery_attempts (delivery_id, attempt, attempted_at, status_code, error_code, duration_ms)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [delivery.id, delivery.attempts, started.toISOString(), statusCode, errorCode, durationMs],
    );

    if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
      await this.finish(delivery, 'succeeded', { status: statusCode, endpointOk: true });
      return 'succeeded';
    }
    if (statusCode === 410) {
      // 410 Gone: el comercio dijo que el endpoint ya no existe. Se deshabilita y no se reintenta (REQ-P1-6).
      await this.finish(delivery, 'dead', { status: statusCode, error: 'gone_410' });
      await disableEndpoint(this.pool, endpoint.id, 'gone_410');
      return 'dead';
    }

    const { scheduleMs } = this.config.delivery;
    if (delivery.attempts >= scheduleMs.length) {
      await this.finish(delivery, 'dead', { status: statusCode, error: errorCode ?? `http_${statusCode}` });
      await this.registerDeadDelivery(endpoint);
      return 'dead';
    }
    const wait = this.withJitter(scheduleMs[delivery.attempts]);
    await this.pool.query(
      `UPDATE webhook_deliveries SET next_attempt_at = $3::timestamptz, last_status = $4, last_error = $5
        WHERE id = $1 AND status = 'pending' AND attempts = $2`,
      [delivery.id, delivery.attempts, new Date(this.clock.now().getTime() + wait).toISOString(), statusCode, errorCode ?? `http_${statusCode}`],
    );
    return 'retrying';
  }

  private async signedRequestHeaders(endpoint: EndpointRecord, delivery: Claimed, at: Date): Promise<Record<string, string>> {
    const rows = await this.pool.query(
      `SELECT sealed_secret FROM webhook_secrets WHERE endpoint_id = $1 AND (expires_at IS NULL OR expires_at > $2::timestamptz) ORDER BY version DESC`,
      [endpoint.id, at.toISOString()],
    );
    const secrets = rows.rows.map((row) => this.box.open(String(row.sealed_secret), endpoint.id));
    if (secrets.length === 0) throw new Error('El endpoint no tiene secretos vigentes');
    const base = { id: delivery.event_id, timestamp: Math.floor(at.getTime() / 1000), payload: delivery.payload };
    const signature = signedHeaders(endpoint.signatureScheme === 'v1a' ? { ...base, secretKeys: secrets } : { ...base, secrets });
    return { ...signature, 'content-type': 'application/json', 'user-agent': USER_AGENT };
  }

  private withJitter(baseMs: number): number {
    const { jitterRatio } = this.config.delivery;
    if (baseMs === 0 || jitterRatio === 0) return baseMs;
    return Math.round(baseMs * (1 + (this.random() * 2 - 1) * jitterRatio));
  }

  private async finish(delivery: Claimed, status: 'succeeded' | 'dead', detail: { status?: number | null; error?: string | null; endpointOk?: boolean }): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_deliveries
          SET status = $3, last_status = $4, last_error = $5, delivered_at = CASE WHEN $3 = 'succeeded' THEN $6::timestamptz ELSE NULL END
        WHERE id = $1 AND status = 'pending' AND attempts = $2`,
      [delivery.id, delivery.attempts, status, detail.status ?? null, detail.error ?? null, this.clock.now().toISOString()],
    );
    if (detail.endpointOk) await this.pool.query('UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0', [delivery.endpoint_id]);
  }

  private async registerDeadDelivery(endpoint: EndpointRecord): Promise<void> {
    const result = await this.pool.query('UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = $1 RETURNING consecutive_failures', [endpoint.id]);
    if (Number(result.rows[0]?.consecutive_failures) >= this.config.delivery.disableAfterDeadDeliveries) await disableEndpoint(this.pool, endpoint.id, 'too_many_failures');
  }
}
