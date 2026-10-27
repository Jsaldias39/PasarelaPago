import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import { ConnectorTimeoutError, ConnectorUnavailableError, type Connector, type ConnectorCode } from '../domain/connector';
import type { ConnectorRegistry } from '../domain/registry';
import { CLOCK, REGISTRY, type Clock } from './tokens';
import { HealthService } from './health.service';

type Operation = 'create_charge' | 'get_status' | 'cancel' | 'refund' | 'create_transfer' | 'get_transfer';

/**
 * Única puerta hacia los adaptadores: registra cada intento (sin cuerpos) y alimenta la salud del conector.
 * Un rechazo definitivo del proveedor (`ConnectorRejectedError`) cuenta como «respondió»: no daña la salud.
 */
@Injectable()
export class ProviderGateway {
  private readonly logger = new Logger(ProviderGateway.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly health: HealthService,
  ) {}

  connector(code: ConnectorCode): Connector {
    const connector = this.registry.get(code);
    if (!connector) throw new ConnectorUnavailableError('unreachable'); // registrado en la base pero no cargado en este modo
    return connector;
  }

  async call<T>(code: ConnectorCode, subjectId: string, operation: Operation, work: (connector: Connector) => Promise<T>): Promise<T> {
    const started = Date.now();
    let outcome: 'ok' | 'unavailable' | 'timeout' | 'rejected' = 'ok';
    try {
      const result = await work(this.connector(code));
      await this.health.record(code, { ok: true, latencyMs: Date.now() - started });
      return result;
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) {
        outcome = 'unavailable';
        await this.health.record(code, { ok: false, reason: error.reason === 'error_rate' ? 'error_rate' : error.reason });
      } else if (error instanceof ConnectorTimeoutError) {
        outcome = 'timeout';
        await this.health.record(code, { ok: false, reason: 'timeout' });
      } else {
        outcome = 'rejected';
        await this.health.record(code, { ok: true, latencyMs: Date.now() - started });
      }
      throw error;
    } finally {
      await this.log(subjectId, code, operation, outcome, Date.now() - started);
    }
  }

  /** Para operaciones idempotentes por referencia (cobro, reembolso): un timeout ambiguo se reintenta con la MISMA referencia. */
  async callIdempotent<T>(code: ConnectorCode, subjectId: string, operation: Operation, work: (connector: Connector) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.call(code, subjectId, operation, work);
      } catch (error) {
        if (!(error instanceof ConnectorTimeoutError) || attempt >= this.config.timeoutRetries) throw error;
      }
    }
  }

  private async log(subjectId: string, code: ConnectorCode, operation: Operation, outcome: string, latencyMs: number): Promise<void> {
    try {
      await this.pool.query('INSERT INTO connector_api_attempts (subject_id, connector, operation, outcome, latency_ms, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [subjectId, code, operation, outcome, latencyMs, this.clock.now()]);
    } catch (error) {
      // El registro de intentos es secundario: no tumba el cobro. Solo nombre y SQLSTATE (regla 90.2.1).
      this.logger.warn({ err: (error as Error).name, code: (error as { code?: string }).code }, 'No se pudo registrar el intento');
    }
  }
}
