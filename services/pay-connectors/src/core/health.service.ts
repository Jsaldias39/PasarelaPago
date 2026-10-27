import { Inject, Injectable } from '@nestjs/common';
import { enqueue } from '@pay/outbox';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import type { ConnectorCode } from '../domain/connector';
import type { ConnectorRegistry } from '../domain/registry';
import { inTransaction } from './db';
import { healthDegradedEvent, healthRecoveredEvent } from './events';
import { CLOCK, REGISTRY, type Clock } from './tokens';

export type HealthStatus = 'up' | 'degraded' | 'down';
export type HealthReason = 'timeout' | 'error_rate' | 'unreachable' | 'auth_failed';
export type Outcome = { readonly ok: true; readonly latencyMs: number } | { readonly ok: false; readonly reason: HealthReason };

interface HealthRow {
  connector: ConnectorCode;
  status: HealthStatus;
  consecutive_failures: number;
  degraded_since: Date | null;
}

/**
 * Salud por conector (REQ-P4-3). Fallos consecutivos: 1 a N-1 ⇒ `degraded` (sigue en el ruteo, con aviso); N o más ⇒ `down`
 * (sale del ruteo y se publica `connector.health.degraded`). Un solo éxito lo devuelve a `up` y publica `connector.health.recovered`.
 */
@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async downSet(): Promise<Set<ConnectorCode>> {
    const rows = await this.pool.query("SELECT connector FROM connector_health WHERE status = 'down'");
    return new Set(rows.rows.map((r) => r.connector as ConnectorCode));
  }

  async record(code: ConnectorCode, outcome: Outcome): Promise<void> {
    const connector = this.registry.get(code);
    const now = this.clock.now();
    await inTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO connector_health (connector, mode, status, checked_at) VALUES ($1, $2, 'up', $3) ON CONFLICT (connector) DO NOTHING`,
        [code, connector?.mode ?? this.registry.mode, now],
      );
      const found = await client.query('SELECT connector, status, consecutive_failures, degraded_since FROM connector_health WHERE connector = $1 FOR UPDATE', [code]);
      const prev = found.rows[0] as unknown as HealthRow;
      if (outcome.ok) {
        await client.query(
          `UPDATE connector_health SET status = 'up', consecutive_failures = 0, degraded_since = NULL, latency_ms = $2, last_success_at = $3, checked_at = $3 WHERE connector = $1`,
          [code, Math.round(outcome.latencyMs), now],
        );
        if (prev.status === 'down' && prev.degraded_since) {
          await enqueue(client, healthRecoveredEvent(code, prev.degraded_since, now), { aggregateType: 'connector', aggregateId: code });
        }
        return;
      }
      const failures = prev.consecutive_failures + 1;
      const status: HealthStatus = failures >= this.config.health.downAfterFailures ? 'down' : 'degraded';
      const wentDown = status === 'down' && prev.status !== 'down';
      const since = wentDown ? now : prev.degraded_since;
      await client.query(
        `UPDATE connector_health SET status = $2, consecutive_failures = $3, last_reason = $4, degraded_since = $5, checked_at = $6 WHERE connector = $1`,
        [code, status, failures, outcome.reason, since, now],
      );
      if (wentDown) await enqueue(client, healthDegradedEvent(code, now, outcome.reason, failures), { aggregateType: 'connector', aggregateId: code });
    });
  }

  /** Sondea cada conector registrado y registra el resultado. Lo llama el temporizador del módulo. */
  async probeAll(): Promise<void> {
    for (const connector of this.registry.list()) {
      let result;
      try {
        result = await connector.probe(this.clock.now());
      } catch {
        result = { ok: false, latencyMs: 0, reason: 'unreachable' as const };
      }
      await this.record(connector.code, result.ok ? { ok: true, latencyMs: result.latencyMs } : { ok: false, reason: result.reason ?? 'unreachable' });
    }
  }

  /** `GET /connectors/health`: uno por conector registrado. Sin datos todavía ⇒ `up` (nada ha fallado). */
  async list(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.pool.query('SELECT * FROM connector_health');
    const byCode = new Map(rows.rows.map((r) => [r.connector as string, r]));
    const now = this.clock.now();
    return this.registry.list().map((c) => {
      const row = byCode.get(c.code);
      return {
        connector: c.code,
        mode: c.mode,
        status: (row?.status as HealthStatus | undefined) ?? 'up',
        latency_ms: (row?.latency_ms as number | null | undefined) ?? null,
        checked_at: ((row?.checked_at as Date | undefined) ?? now).toISOString(),
      };
    });
  }
}
