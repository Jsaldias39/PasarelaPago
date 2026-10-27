import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { processOnce } from '@pay/outbox';
import { PG_POOL } from '../database.module';
import { DELIVERY_ENGINE, type DeliveryEngine } from '../engine/delivery-engine';
import { PayloadPolicyError, buildPublicPayload } from './payload-policy';
import { isPublicEventType } from './public-events';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MERCHANT_ID = /^mc_[a-z0-9]{10,40}$/;
const EVENT_TYPE = /^[a-z_]+\.[a-z_.]+$/;
const SOURCE = /^\/pay-[a-z]+$/;

export type IngestOutcome =
  | { readonly kind: 'queued'; readonly deliveries: number }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'ignored'; readonly reason: 'internal_event' }
  | { readonly kind: 'rejected'; readonly reason: 'malformed' | 'payload_policy'; readonly detail: string };

export interface IngestMetrics {
  queued: number;
  noEndpoints: number;
  duplicates: number;
  ignored: number;
  rejectedMalformed: number;
  rejectedPolicy: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Convierte un CloudEvent de los streams de la pasarela en entregas de webhook.
 *
 * - Solo los tipos públicos (`public-events.ts`); el resto se ignora y se confirma.
 * - La política de payload (M5) deja pasar ids, estados e importes. Un evento con datos personales se RECHAZA (nunca se entrega).
 * - El inbox (`processOnce`) hace que un mismo evento tenga un solo efecto aunque llegue varias veces; y la tabla de entregas
 *   tiene `UNIQUE (endpoint_id, event_id)` como segunda barrera.
 */
@Injectable()
export class EventIngest {
  private readonly logger = new Logger(EventIngest.name);
  readonly metrics: IngestMetrics = { queued: 0, noEndpoints: 0, duplicates: 0, ignored: 0, rejectedMalformed: 0, rejectedPolicy: 0 };

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine,
    @Inject('PAY_MODE') private readonly mode: 'test' | 'live',
  ) {}

  async ingest(raw: unknown): Promise<IngestOutcome> {
    if (!isRecord(raw) || raw.specversion !== '1.0' || typeof raw.id !== 'string' || !UUID.test(raw.id) || typeof raw.type !== 'string' || !EVENT_TYPE.test(raw.type) || typeof raw.source !== 'string' || !SOURCE.test(raw.source) || !isRecord(raw.data)) {
      return this.reject('malformed', 'sobre inválido');
    }
    if (!isPublicEventType(raw.type)) {
      this.metrics.ignored += 1;
      return { kind: 'ignored', reason: 'internal_event' };
    }
    const merchantId = raw.merchantid ?? raw.data.merchant_id;
    const time = typeof raw.time === 'string' && !Number.isNaN(Date.parse(raw.time)) ? new Date(raw.time).toISOString() : null;
    if (typeof merchantId !== 'string' || !MERCHANT_ID.test(merchantId) || time === null) return this.reject('malformed', 'comercio o fecha inválidos');

    let message;
    try {
      const built = buildPublicPayload({ id: raw.id, type: raw.type, time, merchantId, data: raw.data }, this.mode);
      if (built.dropped.length > 0) this.logger.warn({ event_id: raw.id, type: raw.type, dropped_fields: built.dropped }, 'Campos fuera de la política descartados del payload');
      message = { merchantId, eventId: raw.id, eventType: raw.type, payload: built.payload };
    } catch (error) {
      if (error instanceof PayloadPolicyError) {
        this.logger.error({ event_id: raw.id, type: raw.type, reason: error.reason, field: error.field }, 'Evento rechazado por la política de payload');
        return this.reject('payload_policy', `${error.reason}:${error.field}`);
      }
      throw error;
    }

    let deliveries = 0;
    const result = await processOnce(this.pool, `pay-webhooks.${raw.type}`, raw.id, async (client) => {
      deliveries = await this.engine.publish(client, message);
    });
    if (result === 'duplicate') {
      this.metrics.duplicates += 1;
      return { kind: 'duplicate' };
    }
    if (deliveries === 0) this.metrics.noEndpoints += 1;
    else this.metrics.queued += deliveries;
    return { kind: 'queued', deliveries };
  }

  private reject(reason: 'malformed' | 'payload_policy', detail: string): IngestOutcome {
    if (reason === 'malformed') this.metrics.rejectedMalformed += 1;
    else this.metrics.rejectedPolicy += 1;
    return { kind: 'rejected', reason, detail };
  }
}
