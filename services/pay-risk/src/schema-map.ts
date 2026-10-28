/**
 * Lo que el código de pay-risk asume de su base: tablas, columnas, tipo de Postgres y nulabilidad (P5.H2.M2, regla 97.2).
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

export const RISK_SCHEMA_MAP: Readonly<Record<string, Readonly<Record<string, ColumnMap>>>> = {
  risk_assessments: {
    id: col('text'),
    caller_service: col('text'),
    request_key: col('text'),
    merchant_id: col('text'),
    payment_intent_id: col('text'),
    amount_minor: col('bigint'),
    currency: col('text'),
    method: col('text'),
    payer_hash: col('text', true),
    decision: col('text'),
    reason_code: col('text'),
    reason_codes: col('ARRAY'),
    rule_version: col('integer'),
    screened: col('boolean'),
    screening_top_score: col('numeric', true),
    screening_list: col('text', true),
    screening_source_id: col('text', true),
    screening_party: col('text', true),
    duration_ms: col('integer'),
    created_at: col('timestamp with time zone'),
  },
  risk_rule_sets: {
    version: col('integer'),
    effective_from: col('timestamp with time zone'),
    max_amount_minor: col('bigint', true),
    merchant_daily_amount_minor: col('bigint', true),
    payer_daily_amount_minor: col('bigint', true),
    payer_velocity_max: col('integer', true),
    payer_velocity_window_seconds: col('integer', true),
    merchant_velocity_max: col('integer', true),
    merchant_velocity_window_seconds: col('integer', true),
    hours_from: col('smallint', true),
    hours_to: col('smallint', true),
    published_by: col('text'),
    created_at: col('timestamp with time zone'),
  },
};
