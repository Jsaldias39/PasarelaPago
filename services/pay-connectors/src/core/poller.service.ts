import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { ConnectorRejectedError, ConnectorTimeoutError, ConnectorUnavailableError } from '../domain/connector';
import { recordAndApply } from './apply';
import { inTransaction } from './db';
import { ProviderGateway } from './provider-gateway';
import { toChargeRow } from './rows';
import { CLOCK, type Clock } from './tokens';

export interface PollSummary {
  readonly examined: number;
  readonly changed: number;
  readonly failed: number;
}

/**
 * Consulta de estado de los cobros que siguen abiertos (el callback pudo no llegar). Backoff exponencial por cobro
 * (`min(base · 2^intentos, tope)`); `FOR UPDATE SKIP LOCKED` permite varias réplicas sin consultar dos veces el mismo cobro.
 * Lo que descubre entra por el MISMO camino que un callback (`recordAndApply`), con `observed_via = status_inquiry`.
 */
@Injectable()
export class PollerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    private readonly gateway: ProviderGateway,
  ) {}

  async tick(): Promise<PollSummary> {
    const now = this.clock.now();
    const claimed = await inTransaction(this.pool, async (client) => {
      const due = await client.query(
        `SELECT * FROM connector_charges
          WHERE provider_status IN ('pending', 'authorized') AND next_poll_at <= $1
          ORDER BY next_poll_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, this.config.poller.batchSize],
      );
      // Se reserva el siguiente turno YA, dentro de la misma transacción: otra réplica no los toma mientras consultamos.
      for (const raw of due.rows) {
        const row = toChargeRow(raw);
        await client.query('UPDATE connector_charges SET next_poll_at = $2 WHERE id = $1', [row.id, this.after(now, row.poll_attempts + 1)]);
      }
      return due.rows.map(toChargeRow);
    });

    let changed = 0;
    let failed = 0;
    for (const row of claimed) {
      // Cobro que nunca llegó al proveedor (se cayó antes de enviarlo): al vencer se da por vencido localmente.
      if (row.provider_reference === null) {
        if (now.getTime() >= row.expires_at.getTime()) {
          await inTransaction(this.pool, (client) => recordAndApply(client, row.connector, { providerEventId: `inquiry:${row.id}:expired`, chargeReference: row.id, status: 'expired', occurredAt: row.expires_at }, 'status_inquiry', now));
          changed += 1;
        }
        continue;
      }
      try {
        const observed = await this.gateway.call(row.connector, row.id, 'get_status', (c) => c.getStatus(row.id, now));
        if (observed.status !== row.provider_status) {
          const applied = await inTransaction(this.pool, (client) =>
            recordAndApply(client, row.connector, { providerEventId: `inquiry:${row.id}:${observed.status}`, chargeReference: row.id, status: observed.status, occurredAt: observed.occurredAt, ...(observed.failureCode && { failureCode: observed.failureCode }) }, 'status_inquiry', now),
          );
          if (applied.result === 'applied') changed += 1;
        }
        await this.pool.query('UPDATE connector_charges SET poll_attempts = poll_attempts + 1 WHERE id = $1', [row.id]);
      } catch (error) {
        if (error instanceof ConnectorUnavailableError || error instanceof ConnectorTimeoutError || error instanceof ConnectorRejectedError) {
          failed += 1;
          await this.pool.query('UPDATE connector_charges SET poll_attempts = poll_attempts + 1 WHERE id = $1', [row.id]);
          continue;
        }
        throw error;
      }
    }
    return { examined: claimed.length, changed, failed };
  }

  private after(from: Date, attempts: number): Date {
    const { baseBackoffMs, maxBackoffMs } = this.config.poller;
    return new Date(from.getTime() + Math.min(baseBackoffMs * 2 ** attempts, maxBackoffMs));
  }
}
