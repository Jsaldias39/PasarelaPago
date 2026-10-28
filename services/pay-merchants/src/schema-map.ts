/**
 * Lo que el código de pay-merchants asume de su base: tablas, columnas, tipo de Postgres y nulabilidad (P5.H1.M1, regla 97.2).
 * Este servicio usa `pg` directo con SQL parametrizado, SIN ORM: este mapa es la «capa de entidades» que `test/drift.spec.ts` compara contra la
 * base que sale del SQL vendorizado (`sql/ddl.sql`, generado por el modelo, D-18) y contra lo que el código nombra de verdad en sus sentencias.
 * Si cambia el modelo (y se vendoriza) y no este mapa —o al revés—, `test/drift.spec.ts` falla. Las tablas técnicas (outbox, inbox, idempotencia)
 * son de las librerías @pay/* y no se mapean aquí.
 */
export type ColumnType = 'text' | 'integer' | 'smallint' | 'bigint' | 'numeric' | 'boolean' | 'date' | 'jsonb' | 'uuid' | 'ARRAY' | 'timestamp with time zone';
export interface ColumnMap {
  readonly type: ColumnType;
  /** `true` si la columna admite NULL. */
  readonly nullable: boolean;
}

const col = (type: ColumnType, nullable = false): ColumnMap => ({ type, nullable });

export const MERCHANTS_SCHEMA_MAP: Readonly<Record<string, Readonly<Record<string, ColumnMap>>>> = {
  api_keys: {
    key_id: col('text'),
    merchant_id: col('text'),
    mode: col('text'),
    label: col('text', true),
    last4: col('text'),
    key_hash: col('text'),
    created_at: col('timestamp with time zone'),
    grace_ends_at: col('timestamp with time zone', true),
    revoked_at: col('timestamp with time zone', true),
    revoke_reason: col('text', true),
  },
  contract_acceptances: {
    id: col('text'),
    merchant_id: col('text'),
    version: col('integer'),
    text_sha256: col('text'),
    accepted_by_ref: col('text'),
    recorded_by: col('text'),
    accepted_at: col('timestamp with time zone'),
  },
  contract_versions: {
    version: col('integer'),
    text_sha256: col('text'),
    effective_from: col('timestamp with time zone'),
    published_by: col('text'),
    published_at: col('timestamp with time zone'),
  },
  fee_schedule_channels: {
    merchant_id: col('text'),
    version: col('integer'),
    channel: col('text'),
    percent: col('text'),
    fixed_minor: col('bigint'),
    min_minor: col('bigint', true),
    cap_minor: col('bigint', true),
  },
  fee_schedule_versions: {
    merchant_id: col('text'),
    version: col('integer'),
    currency: col('text'),
    effective_from: col('timestamp with time zone'),
    monthly_fee_minor: col('bigint'),
    published_by: col('text'),
    published_at: col('timestamp with time zone'),
  },
  kyc_documents: {
    id: col('text'),
    merchant_id: col('text'),
    kind: col('text'),
    object_key: col('text'),
    sha256: col('text'),
    size_bytes: col('integer'),
    detected_type: col('text'),
    uploaded_by: col('text'),
    uploaded_at: col('timestamp with time zone'),
  },
  merchant_kyc: {
    merchant_id: col('text'),
    status: col('text'),
    risk_level: col('text', true),
    reviewed_by: col('text', true),
    reviewed_at: col('timestamp with time zone', true),
    review_note: col('text', true),
    updated_at: col('timestamp with time zone'),
  },
  merchants: {
    id: col('text'),
    display_name: col('text'),
    legal_name: col('text'),
    legal_type: col('text'),
    tax_id: col('text'),
    directory_tenant_ref: col('text', true),
    status: col('text'),
    suspension_reason: col('text', true),
    created_at: col('timestamp with time zone'),
    activated_at: col('timestamp with time zone', true),
    suspended_at: col('timestamp with time zone', true),
    closed_at: col('timestamp with time zone', true),
  },
};
