import type { Queryable } from '@pay/outbox';
import type { DisabledReason, EndpointRecord, SignatureScheme } from './endpoint.types';

interface Row {
  id: string;
  merchant_id: string;
  url: string;
  description: string | null;
  enabled_events: string[];
  signature_scheme: SignatureScheme;
  status: 'enabled' | 'disabled';
  disabled_reason: DisabledReason | null;
  created_at: Date;
}

const COLUMNS = 'id, merchant_id, url, description, enabled_events, signature_scheme, status, disabled_reason, created_at';

const fromRow = (row: Row): EndpointRecord => ({
  id: row.id,
  merchantId: row.merchant_id,
  url: row.url,
  description: row.description,
  enabledEvents: row.enabled_events,
  signatureScheme: row.signature_scheme,
  status: row.status,
  disabledReason: row.disabled_reason,
  createdAt: new Date(row.created_at),
});

export interface NewEndpoint {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly description: string | null;
  readonly enabledEvents: readonly string[];
  readonly signatureScheme: SignatureScheme;
}

export async function insertEndpoint(db: Queryable, endpoint: NewEndpoint): Promise<EndpointRecord> {
  const result = await db.query(
    `INSERT INTO webhook_endpoints (id, merchant_id, url, description, enabled_events, signature_scheme)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [endpoint.id, endpoint.merchantId, endpoint.url, endpoint.description, endpoint.enabledEvents, endpoint.signatureScheme],
  );
  return fromRow(result.rows[0] as unknown as Row);
}

export async function countActiveEndpoints(db: Queryable, merchantId: string): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS n FROM webhook_endpoints WHERE merchant_id = $1 AND deleted_at IS NULL', [merchantId]);
  return Number(result.rows[0].n);
}

/** Busca un endpoint SOLO si es del comercio: el de otro comercio es indistinguible de uno inexistente. */
export async function findOwnedEndpoint(db: Queryable, id: string, merchantId: string): Promise<EndpointRecord | undefined> {
  const result = await db.query(`SELECT ${COLUMNS} FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2 AND deleted_at IS NULL`, [id, merchantId]);
  return result.rows[0] ? fromRow(result.rows[0] as unknown as Row) : undefined;
}

export async function findEndpoint(db: Queryable, id: string): Promise<EndpointRecord | undefined> {
  const result = await db.query(`SELECT ${COLUMNS} FROM webhook_endpoints WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return result.rows[0] ? fromRow(result.rows[0] as unknown as Row) : undefined;
}

/** Página de endpoints del comercio, del más nuevo al más viejo (desempate por id: la paginación no repite ni salta). */
export async function listEndpoints(db: Queryable, merchantId: string, limit: number, startingAfter: string | undefined): Promise<{ data: EndpointRecord[]; hasMore: boolean }> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM webhook_endpoints
      WHERE merchant_id = $1 AND deleted_at IS NULL
        AND ($3::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM webhook_endpoints WHERE id = $3 AND merchant_id = $1))
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [merchantId, limit + 1, startingAfter ?? null],
  );
  const rows = result.rows as unknown as Row[];
  return { data: rows.slice(0, limit).map(fromRow), hasMore: rows.length > limit };
}

export async function softDeleteEndpoint(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE webhook_endpoints SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
  // lo que quedaba pendiente para un endpoint borrado no se entrega
  await db.query(`UPDATE webhook_deliveries SET status = 'dead', last_error = 'endpoint_deleted' WHERE endpoint_id = $1 AND status = 'pending'`, [id]);
}

/** Matching de eventos: el endpoint recibe el tipo exacto o `*`. */
export async function enabledEndpointsFor(db: Queryable, merchantId: string, eventType: string): Promise<EndpointRecord[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM webhook_endpoints
      WHERE merchant_id = $1 AND deleted_at IS NULL AND status = 'enabled' AND ($2 = ANY (enabled_events) OR '*' = ANY (enabled_events))
      ORDER BY id`,
    [merchantId, eventType],
  );
  return (result.rows as unknown as Row[]).map(fromRow);
}

export async function disableEndpoint(db: Queryable, id: string, reason: DisabledReason): Promise<void> {
  await db.query(`UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = $2, updated_at = now() WHERE id = $1 AND status = 'enabled'`, [id, reason]);
  await db.query(`UPDATE webhook_deliveries SET status = 'dead', last_error = 'endpoint_disabled' WHERE endpoint_id = $1 AND status = 'pending'`, [id]);
}
