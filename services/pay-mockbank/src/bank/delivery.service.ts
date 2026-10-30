import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { signedHeaders } from '@pay/webhook-signature';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { CLOCK, type Clock } from '../clock';
import { PG_POOL } from '../database.module';

interface CallbackRow {
  id: string;
  event_id: string;
  reference: string;
  status: string;
  occurred_at: Date;
  amount_minor: string;
  failure_code: string | null;
  attempts: number;
}

const MAX_ATTEMPTS = 20;

/**
 * Entrega los callbacks del banco a `pay-connectors`, firmados con Standard Webhooks (secreto SINTÉTICO de sandbox). Reintenta con backoff
 * ante cualquier respuesta que no sea 2xx, como haría un banco real. El cuerpo es el del callback del conector `mock`
 * (`contracts/openapi/internal-connectors-v1.yaml`, `POST /callbacks/mock`); el banco simulado no inventa otro formato.
 */
@Injectable()
export class DeliveryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DeliveryService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.deliveryIntervalMs <= 0 || !this.config.callbackUrl) return;
    this.timer = setInterval(() => {
      this.deliverDue().catch((error: Error) => this.logger.error({ err: error.name }, 'Falló la entrega de callbacks'));
    }, this.config.deliveryIntervalMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Entrega, EN ORDEN, todo lo vencido. Un solo ciclo a la vez. */
  async deliverDue(): Promise<{ delivered: number; failed: number }> {
    if (!this.config.callbackUrl || this.running) return { delivered: 0, failed: 0 };
    this.running = true;
    try {
      const now = this.clock.now();
      // Se reserva el turno de cada fila ANTES de enviarla (otra réplica no la toma); si el envío falla se reprograma con backoff.
      const due = (
        await this.pool.query(
          `UPDATE mb_callbacks SET next_attempt_at = $1::timestamptz + interval '30 seconds'
            WHERE id IN (SELECT id FROM mb_callbacks WHERE delivered_at IS NULL AND due_at <= $1 AND next_attempt_at <= $1 AND attempts < $2 ORDER BY due_at, id LIMIT 50 FOR UPDATE SKIP LOCKED)
            RETURNING *`,
          [now, MAX_ATTEMPTS],
        )
      ).rows as CallbackRow[];
      due.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
      let delivered = 0;
      let failed = 0;
      for (const row of due) {
        if (await this.send(row, now)) delivered += 1;
        else failed += 1;
      }
      return { delivered, failed };
    } finally {
      this.running = false;
    }
  }

  private async send(row: CallbackRow, now: Date): Promise<boolean> {
    const body = JSON.stringify({
      id: row.event_id,
      type: 'charge.status',
      reference: row.reference,
      status: row.status,
      occurred_at: row.occurred_at.toISOString(),
      amount_minor: Number(row.amount_minor),
      ...(row.failure_code ? { failure_code: row.failure_code } : {}),
    });
    const headers = signedHeaders({ id: row.event_id, timestamp: Math.floor(now.getTime() / 1000), payload: body, secrets: [this.config.webhookSecret] });
    let ok = false;
    try {
      const response = await fetch(this.config.callbackUrl as string, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) });
      ok = response.status >= 200 && response.status < 300;
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      ok = false; // sin respuesta: se reintenta (el banco no sabe si llegó)
    }
    if (ok) {
      await this.pool.query('UPDATE mb_callbacks SET delivered_at = $2, attempts = attempts + 1 WHERE id = $1', [row.id, now]);
    } else {
      const backoffSeconds = Math.min(2 ** row.attempts, 60);
      await this.pool.query(`UPDATE mb_callbacks SET attempts = attempts + 1, next_attempt_at = $2::timestamptz + make_interval(secs => $3) WHERE id = $1`, [row.id, now, backoffSeconds]);
    }
    return ok;
  }
}
