import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Queryable } from '@pay/outbox';
import { PG_POOL } from '../database.module';
import type { ReplicaEvent } from './replica.events';

export interface KeyRecord {
  readonly keyId: string;
  readonly merchantId: string;
  readonly mode: 'test' | 'live';
  /** `null` si solo se conoce el tombstone de una revocación que llegó antes que la creación. */
  readonly keyHash: string | null;
  /** La revocación ya rige (`revoked_at <= now()` según el reloj de la base). */
  readonly revoked: boolean;
}

export type MerchantStatus = 'active' | 'suspended' | 'closed';

/** Lectura de la réplica (camino caliente de cada petición). */
@Injectable()
export class ReplicaRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findKey(keyId: string): Promise<KeyRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT key_id, merchant_id, mode, key_hash, (revoked_at IS NOT NULL AND revoked_at <= now()) AS revoked
         FROM api_key_replica WHERE key_id = $1`,
      [keyId],
    );
    const row = rows[0];
    return row ? { keyId: row.key_id, merchantId: row.merchant_id, mode: row.mode, keyHash: row.key_hash, revoked: row.revoked } : undefined;
  }

  async merchantStatus(merchantId: string): Promise<MerchantStatus | undefined> {
    const { rows } = await this.pool.query('SELECT status FROM merchant_replica WHERE merchant_id = $1', [merchantId]);
    return rows[0]?.status;
  }
}

/**
 * Aplica un evento a la réplica. Se ejecuta DENTRO de la transacción del inbox (`processOnce`), y es idempotente y
 * tolerante al desorden:
 *
 * - `api_key.created` solo completa una fila sin hash: el hash de una clave es inmutable. Si la revocación llegó antes, la
 *   fila ya existe (tombstone) y el `created` tardío NO la resucita.
 * - `api_key.revoked` conserva la revocación MÁS TEMPRANA (una revocación no se deshace, y la más temprana es la más estricta);
 *   puede llevar un instante futuro (gracia de una rotación).
 * - `merchant.*` solo aplica si es igual o más nuevo que el estado guardado, y `closed` es terminal (y gana aunque llegue
 *   con un instante anterior al estado guardado: en el origen no hay vuelta atrás).
 * - D-32: `merchant.closed` REVOCA todas las claves del comercio que la réplica conoce (la revocación más temprana manda);
 *   las que lleguen después las atrapa el borde por el estado `closed`. Suspender solo bloquea y se revierte con `activated`.
 */
export async function applyReplicaEvent(client: Queryable, event: ReplicaEvent): Promise<void> {
  if (event.kind === 'api_key.created') {
    await client.query(
      `INSERT INTO api_key_replica (key_id, merchant_id, mode, key_hash, last_event_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key_id) DO UPDATE
          SET merchant_id = EXCLUDED.merchant_id, mode = EXCLUDED.mode, key_hash = EXCLUDED.key_hash,
              last_event_id = EXCLUDED.last_event_id, updated_at = now()
        WHERE api_key_replica.key_hash IS NULL`,
      [event.keyId, event.merchantId, event.mode, event.keyHash, event.eventId],
    );
    return;
  }
  if (event.kind === 'api_key.revoked') {
    await client.query(
      `INSERT INTO api_key_replica (key_id, merchant_id, mode, key_hash, revoked_at, last_event_id)
       VALUES ($1, $2, $3, NULL, $4::timestamptz, $5)
       ON CONFLICT (key_id) DO UPDATE
          SET revoked_at = LEAST(api_key_replica.revoked_at, EXCLUDED.revoked_at),
              last_event_id = EXCLUDED.last_event_id, updated_at = now()`,
      [event.keyId, event.merchantId, event.mode, event.revokedAt, event.eventId],
    );
    return;
  }
  await client.query(
    `INSERT INTO merchant_replica (merchant_id, status, status_at, last_event_id)
     VALUES ($1, $2, $3::timestamptz, $4)
     ON CONFLICT (merchant_id) DO UPDATE
        SET status = EXCLUDED.status, status_at = EXCLUDED.status_at, last_event_id = EXCLUDED.last_event_id, updated_at = now()
      WHERE merchant_replica.status <> 'closed' AND (EXCLUDED.status = 'closed' OR merchant_replica.status_at <= EXCLUDED.status_at)`,
    [event.merchantId, event.status, event.at, event.eventId],
  );
  if (event.status === 'closed') {
    await client.query(
      `UPDATE api_key_replica SET revoked_at = LEAST(revoked_at, $2::timestamptz), updated_at = now() WHERE merchant_id = $1`,
      [event.merchantId, event.at],
    );
  }
}
