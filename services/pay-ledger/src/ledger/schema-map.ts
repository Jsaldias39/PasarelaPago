/**
 * Lo que el código de pay-ledger asume de su base (P2.H1.M2): tablas, columnas, tipo de Postgres y nulabilidad.
 * No hay ORM en este servicio (SQL parametrizado con `pg`), así que este mapa es la «capa de entidades» que la verificación de
 * deriva (97.2) compara contra la base aplicada desde `sql/ddl.sql` (vendorizado del modelo, D-18). Si cambia el SQL y no este mapa, `test/drift.spec.ts` falla.
 */
export type ColumnType = 'text' | 'character' | 'integer' | 'bigint' | 'jsonb' | 'timestamp with time zone';
export interface ColumnMap {
  readonly type: ColumnType;
  /** `true` si la columna admite NULL. */
  readonly nullable: boolean;
}

const col = (type: ColumnType, nullable = false): ColumnMap => ({ type, nullable });

export const LEDGER_SCHEMA_MAP: Readonly<Record<string, Readonly<Record<string, ColumnMap>>>> = {
  ledger_accounts: {
    mode: col('text'),
    account: col('text'),
    kind: col('text'),
    tb_id: col('character'),
    created_at: col('timestamp with time zone'),
  },
  ledger_transactions: {
    mode: col('text'),
    id: col('text'),
    business_ref: col('text'),
    attempt: col('integer'),
    content_hash: col('character'),
    status: col('text'),
    reject_code: col('text', true),
    currency: col('character'),
    legs: col('jsonb'),
    created_at: col('timestamp with time zone'),
  },
  ledger_legs: {
    mode: col('text'),
    id: col('text'),
    source: col('text'),
    source_id: col('text'),
    business_ref: col('text'),
    attempt: col('integer'),
    leg_index: col('integer'),
    debit_account: col('text'),
    credit_account: col('text'),
    amount_minor: col('bigint'),
    code: col('text'),
    posted_at: col('timestamp with time zone'),
  },
  ledger_statement_lines: {
    mode: col('text'),
    id: col('text'),
    account: col('text'),
    leg_id: col('text'),
    business_ref: col('text'),
    attempt: col('integer'),
    leg_index: col('integer'),
    direction: col('text'),
    counterparty_account: col('text'),
    amount_minor: col('bigint'),
    code: col('text'),
    posted_at: col('timestamp with time zone'),
  },
  ledger_holds: {
    mode: col('text'),
    id: col('text'),
    business_ref: col('text'),
    attempt: col('integer'),
    content_hash: col('character'),
    status: col('text'),
    reject_code: col('text', true),
    debit_account: col('text'),
    credit_account: col('text'),
    amount_minor: col('bigint'),
    posted_amount_minor: col('bigint', true),
    currency: col('character'),
    void_reason: col('text', true),
    expires_at: col('timestamp with time zone'),
    created_at: col('timestamp with time zone'),
    resolved_at: col('timestamp with time zone', true),
  },
  ledger_rejections: {
    mode: col('text'),
    id: col('bigint'),
    kind: col('text'),
    business_ref: col('text'),
    attempt: col('integer'),
    reject_code: col('text'),
    tb_status: col('text'),
    caller: col('text'),
    rejected_at: col('timestamp with time zone'),
  },
};
