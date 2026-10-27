import { randomBytes } from 'node:crypto';
import type { Queryable } from '@pay/outbox';
import { generateKeyPair, generateSecret } from '@pay/webhook-signature';
import { SecretBox } from '../crypto/secret-box';
import { enabledEndpointsFor } from '../endpoints/endpoint.repository';
import type { EndpointRecord } from '../endpoints/endpoint.types';
import type { Clock, DeliveryEngine, OutboundMessage, SecretDisclosure } from './delivery-engine';

export interface InProcessEngineOptions {
  readonly rotationGraceMs: number;
}

/**
 * [DOBLE de Svix] Motor de entrega propio sobre Postgres: guarda los secretos sellados y encola una entrega por endpoint.
 * El envío y los reintentos los hace `DeliveryWorker`. NO es Svix: cumple el mismo contrato (`DeliveryEngine`) para poder
 * ejercitar firma, reintentos, rotación y SSRF de punta a punta sin un servidor Svix.
 */
export class InProcessEngine implements DeliveryEngine {
  readonly kind = 'in-process' as const;

  constructor(
    private readonly box: SecretBox,
    private readonly clock: Clock,
    private readonly options: InProcessEngineOptions,
  ) {}

  async provisionEndpoint(db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure> {
    return this.insertSecret(db, endpoint, 1);
  }

  async rotateEndpointSecret(db: Queryable, endpoint: EndpointRecord): Promise<SecretDisclosure> {
    const latest = await db.query('SELECT COALESCE(max(version), 0)::int AS v FROM webhook_secrets WHERE endpoint_id = $1', [endpoint.id]);
    const graceEnd = new Date(this.clock.now().getTime() + this.options.rotationGraceMs);
    // Las versiones anteriores siguen firmando hasta el final de la gracia (o hasta su vencimiento previo, si era menor).
    await db.query(
      `UPDATE webhook_secrets SET expires_at = LEAST(COALESCE(expires_at, 'infinity'::timestamptz), $2::timestamptz) WHERE endpoint_id = $1`,
      [endpoint.id, graceEnd.toISOString()],
    );
    return this.insertSecret(db, endpoint, Number(latest.rows[0].v) + 1);
  }

  async removeEndpoint(): Promise<void> {
    // Los secretos se conservan sellados mientras exista la fila del endpoint (borrado lógico): nada que hacer acá.
  }

  async publish(db: Queryable, message: OutboundMessage): Promise<number> {
    const endpoints = await enabledEndpointsFor(db, message.merchantId, message.eventType);
    const now = this.clock.now().toISOString();
    let created = 0;
    for (const endpoint of endpoints) {
      const result = await db.query(
        `INSERT INTO webhook_deliveries (id, endpoint_id, merchant_id, event_id, event_type, payload, next_attempt_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        [`dl_${randomBytes(10).toString('hex')}`, endpoint.id, message.merchantId, message.eventId, message.eventType, message.payload, now],
      );
      created += result.rowCount ?? 0;
    }
    return created;
  }

  private async insertSecret(db: Queryable, endpoint: EndpointRecord, version: number): Promise<SecretDisclosure> {
    let signing: string;
    let publicKey: string | null = null;
    let disclosed: string;
    if (endpoint.signatureScheme === 'v1a') {
      const pair = generateKeyPair();
      signing = pair.secretKey;
      publicKey = pair.publicKey;
      disclosed = pair.publicKey;
    } else {
      signing = generateSecret();
      disclosed = signing;
    }
    await db.query(
      'INSERT INTO webhook_secrets (endpoint_id, version, sealed_secret, public_key, created_at) VALUES ($1, $2, $3, $4, $5::timestamptz)',
      [endpoint.id, version, this.box.seal(signing, endpoint.id), publicKey, this.clock.now().toISOString()],
    );
    return { secret: disclosed };
  }
}
