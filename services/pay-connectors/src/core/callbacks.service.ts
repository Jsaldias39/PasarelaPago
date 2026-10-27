import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@pay/problem';
import type { Pool } from 'pg';
import { SERVICE_CONFIG, type ServiceConfig } from '../config';
import { PG_POOL } from '../database.module';
import type { ConnectorCode } from '../domain/connector';
import { evaluateCallbackEndpoint } from '../domain/endpoint-policy';
import type { ConnectorRegistry } from '../domain/registry';
import { badRequest } from '../raw-problem';
import { recordAndApply, type CallbackOutcome } from './apply';
import { inTransaction } from './db';
import { CLOCK, REGISTRY, type Clock } from './tokens';

const CODES = new Set<string>(['mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer']);
/** Más significativo primero: una contradicción no se esconde detrás de un duplicado. */
const RANK: Record<CallbackOutcome, number> = { contradiction: 3, applied: 2, stale: 1, duplicate: 0 };

export interface CallbackRequest {
  readonly connectorId: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Buffer;
  /** IP de origen resuelta por el servidor (nunca una cabecera del proveedor). */
  readonly sourceIp?: string;
}

/**
 * `POST /callbacks/{connectorId}` — público hacia el proveedor. Orden: conector conocido → límite de velocidad → política de
 * endpoint (red de origen y ventana) → verificación propia del conector. Cualquier fallo de autenticación es `401` SIN EFECTO.
 */
@Injectable()
export class CallbacksService {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REGISTRY) private readonly registry: ConnectorRegistry,
    @Inject(SERVICE_CONFIG) private readonly config: ServiceConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async receive(request: CallbackRequest): Promise<{ result: CallbackOutcome; chargeId: string | null }> {
    if (!CODES.has(request.connectorId)) throw new ProblemError('resource_not_found');
    const code = request.connectorId as ConnectorCode;
    const connector = this.registry.get(code);
    if (!connector) throw new ProblemError('resource_not_found'); // no está cargado en este modo
    const now = this.clock.now();
    this.limit(code, request.sourceIp, now);

    const endpoints = await this.pool.query('SELECT callback_path, active, allowed_source_cidrs, replay_window_seconds FROM connector_callback_endpoints WHERE connector = $1', [code]);
    const decision = evaluateCallbackEndpoint(
      endpoints.rows.map((r) => ({ callbackPath: r.callback_path as string, active: r.active as boolean, allowedSourceCidrs: r.allowed_source_cidrs, replayWindowSeconds: r.replay_window_seconds as number | null })),
      { callbackPath: `/callbacks/${code}`, ...(request.sourceIp && { sourceIp: request.sourceIp }), ...(request.headers['webhook-timestamp'] && { timestamp: request.headers['webhook-timestamp'] }), now },
    );
    if (!decision.allowed) throw new ProblemError('unauthorized');

    const verified = await connector.verifyCallback({ headers: request.headers, rawBody: request.rawBody, now });
    if (!verified.ok) {
      if (verified.malformed) throw badRequest('El cuerpo del callback no se pudo interpretar');
      throw new ProblemError('unauthorized');
    }

    let best: { result: CallbackOutcome; chargeId: string | null } = { result: 'duplicate', chargeId: null };
    let first = true;
    for (const event of verified.events) {
      const applied = await inTransaction(this.pool, (client) => recordAndApply(client, code, event, 'callback', now));
      if (first || RANK[applied.result] > RANK[best.result]) best = applied;
      first = false;
    }
    return best;
  }

  /** Ventana fija de un minuto por conector y origen. En memoria: con varias réplicas el límite efectivo es por réplica (ver README). */
  private limit(code: ConnectorCode, ip: string | undefined, now: Date): void {
    const key = `${code}|${ip ?? '-'}`;
    const window = this.windows.get(key);
    // Un reloj que retrocede (ajuste de NTP) también abre ventana nueva: no deja el contador congelado.
    const elapsed = window ? now.getTime() - window.startedAt : 0;
    if (!window || elapsed >= 60_000 || elapsed < 0) {
      this.windows.set(key, { startedAt: now.getTime(), count: 1 });
      if (this.windows.size > 10_000) this.windows.clear(); // tope de memoria ante un barrido de orígenes
      return;
    }
    window.count += 1;
    if (window.count > this.config.callbackRatePerMinute) throw new ProblemError('rate_limited');
  }
}
