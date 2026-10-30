/**
 * Lo que el código de pay-schedules asume de su base: tablas, columnas, tipo de Postgres y nulabilidad (P5.H3.M1, regla 97.2).
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

export const SCHEDULES_SCHEMA_MAP: Readonly<Record<string, Readonly<Record<string, ColumnMap>>>> = {
  mandates: {
    id: col('text'),
    merchant_id: col('text'),
    mode: col('text'),
    kind: col('text'),
    beneficiary_merchant_id: col('text'),
    amount_minor: col('bigint'),
    currency: col('text'),
    frequency: col('text'),
    day_of_month: col('smallint'),
    start_date: col('date'),
    end_date: col('date', true),
    description: col('text', true),
    status: col('text'),
    next_run_on: col('date', true),
    created_at: col('timestamp with time zone'),
    canceled_at: col('timestamp with time zone', true),
  },
  merchant_replica: {
    merchant_id: col('text'),
    status: col('text'),
    as_of: col('timestamp with time zone'),
    updated_at: col('timestamp with time zone'),
  },
  scheduled_payments: {
    id: col('text'),
    mandate_id: col('text'),
    period: col('text'),
    due_on: col('date'),
    status: col('text'),
    phase: col('text'),
    attempts: col('integer'),
    ledger_attempt: col('integer'),
    hold_id: col('text', true),
    ledger_transaction_id: col('text', true),
    ledger_transfer_id: col('text', true),
    next_attempt_at: col('timestamp with time zone'),
    lease_until: col('timestamp with time zone', true),
    last_failure_code: col('text', true),
    needs_review: col('boolean'),
    created_at: col('timestamp with time zone'),
    executed_at: col('timestamp with time zone', true),
  },
};
