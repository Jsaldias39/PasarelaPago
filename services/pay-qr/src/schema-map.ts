/**
 * Lo que el CÓDIGO de pay-qr asume de su base: tablas, columnas, tipo de Postgres y nulabilidad (97.2, P4.H1.M2).
 *
 * ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18).
 *
 * Este mapa NO se copió del SQL: sale del código (`QrRow` en `src/qr/qr.types.ts`, el `INSERT` de `qr.service.ts#create` y el `UPDATE` de la anulación).
 * `test/drift.spec.ts` lo compara con la base que sale del `sql/ddl.sql` VENDORIZADO del modelo (`scripts/vendor-ddl.sh`).
 * `by: 'db'` marca una columna que llena la BASE (DEFAULT) y que el código no escribe.
 */
export type ColumnType = 'text' | 'integer' | 'bigint' | 'boolean' | 'jsonb' | 'timestamp with time zone';

export interface ColumnMap {
  readonly type: ColumnType;
  /** `true` si la columna admite NULL. */
  readonly nullable: boolean;
  /** `db` = la llena la base (DEFAULT); el código no la escribe. */
  readonly by?: 'db';
}

const col = (type: ColumnType, nullable = false): ColumnMap => ({ type, nullable });
const db = (type: ColumnType, nullable = false): ColumnMap => ({ type, nullable, by: 'db' });

export type SchemaMap = Readonly<Record<string, Readonly<Record<string, ColumnMap>>>>;

export const QR_SCHEMA_MAP: SchemaMap = {
  // INSERT INTO qr_codes (id, kind, pay_mode, merchant_id, payment_intent_id, reference, amount_minor, currency, payload, expires_at) en qr.service.ts;
  // UPDATE qr_codes SET canceled_at ... al anular; `created_at` lo pone la base.
  qr_codes: {
    id: col('text'),
    kind: col('text'),
    pay_mode: col('text'),
    merchant_id: col('text'),
    payment_intent_id: col('text', true),
    reference: col('text'),
    amount_minor: col('bigint', true),
    currency: col('text'),
    payload: col('text'),
    expires_at: col('timestamp with time zone', true),
    canceled_at: col('timestamp with time zone', true),
    created_at: db('timestamp with time zone'),
  },
};

/** Tablas técnicas de las librerías (`@pay/outbox`, `@pay/idempotency`): las gobiernan ellas, no este servicio. */
export const TECHNICAL_TABLES: readonly string[] = ['outbox_events', 'inbox_events', 'idempotency_keys'];
