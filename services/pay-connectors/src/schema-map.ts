/**
 * Lo que el CÓDIGO de pay-connectors asume de su base: tablas, columnas, tipo de Postgres y nulabilidad (97.2, P4.H1.M2).
 *
 * ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18).
 *
 * Este mapa NO se copió del SQL: sale del código. Cada tabla cita DÓNDE el código la usa (las interfaces de fila y las sentencias `INSERT`/`UPDATE`/`SELECT`
 * de `src/`). `test/drift.spec.ts` lo compara con la base que sale del `sql/ddl.sql` VENDORIZADO del modelo (`scripts/vendor-ddl.sh`): si el modelo cambia una
 * columna que el código usa (o agrega una obligatoria que el código no llena), la prueba falla. Si cambia el código y no este mapa, también.
 *
 * `by: 'db'` marca una columna que llena la BASE (identidad o `DEFAULT`) y que el código no escribe: está en el mapa porque existe y el código no la ignora
 * por descuido (si fuera obligatoria y sin default, el código no podría insertar y sería deriva).
 */
export type ColumnType = 'text' | 'integer' | 'bigint' | 'boolean' | 'jsonb' | 'timestamp with time zone';

export interface ColumnMap {
  readonly type: ColumnType;
  /** `true` si la columna admite NULL. */
  readonly nullable: boolean;
  /** `db` = la llena la base (identidad / DEFAULT); el código no la escribe. */
  readonly by?: 'db';
}

const col = (type: ColumnType, nullable = false): ColumnMap => ({ type, nullable });
const db = (type: ColumnType, nullable = false): ColumnMap => ({ type, nullable, by: 'db' });

export type SchemaMap = Readonly<Record<string, Readonly<Record<string, ColumnMap>>>>;

export const CONNECTORS_SCHEMA_MAP: SchemaMap = {
  // src/core/rows.ts `ChargeRow`; INSERT en charges.service.ts (create); UPDATE en charges.service.ts, apply.ts, poller.service.ts.
  connector_charges: {
    id: col('text'),
    caller: col('text'),
    idempotency_key: col('text'),
    payment_intent_id: col('text'),
    merchant_id: col('text'),
    pay_mode: col('text'),
    connector: col('text'),
    connector_mode: col('text'),
    method: col('text'),
    amount_minor: col('bigint'),
    currency: col('text'),
    provider_status: db('text'),
    next_action: col('jsonb', true),
    provider_reference: col('text', true),
    failure_code: col('text', true),
    ambiguous: db('boolean'),
    send_claims: db('integer'),
    routing_version: col('integer'),
    routing_rule: col('text', true),
    expires_at: col('timestamp with time zone'),
    last_provider_event_at: col('timestamp with time zone', true),
    poll_attempts: db('integer'),
    next_poll_at: col('timestamp with time zone'),
    created_at: col('timestamp with time zone'),
    updated_at: col('timestamp with time zone'),
  },
  // src/core/rows.ts `RefundRow`; INSERT/UPDATE en refunds.service.ts.
  connector_refunds: {
    id: col('text'),
    charge_id: col('text'),
    pay_mode: col('text'),
    refund_id: col('text', true),
    caller: col('text'),
    idempotency_key: col('text'),
    amount_minor: col('bigint'),
    currency: col('text'),
    status: db('text'),
    provider_reference: col('text', true),
    failure_code: col('text', true),
    may_have_reached_provider: db('boolean'),
    send_claims: db('integer'),
    created_at: col('timestamp with time zone'),
    updated_at: col('timestamp with time zone'),
  },
  // src/core/transfers.service.ts `TransferRow`; INSERT/UPDATE en el mismo archivo.
  connector_transfers: {
    id: col('text'),
    business_ref: col('text'),
    attempt: col('integer'),
    pay_mode: col('text'),
    caller: col('text'),
    connector: col('text'),
    connector_mode: col('text'),
    amount_minor: col('bigint'),
    currency: col('text'),
    destination_ref: col('text'),
    status: db('text'),
    provider_reference: col('text', true),
    failure_code: col('text', true),
    may_have_reached_provider: db('boolean'),
    send_claims: db('integer'),
    created_at: col('timestamp with time zone'),
    updated_at: col('timestamp with time zone'),
  },
  // INSERT en apply.ts (`recordAndApply`): la deduplicación por (connector, provider_event_id).
  connector_callback_events: {
    id: db('bigint'),
    connector: col('text'),
    provider_event_id: col('text'),
    charge_id: col('text', true),
    pay_mode: col('text', true),
    status: col('text'),
    result: col('text'),
    observed_via: col('text'),
    occurred_at: col('timestamp with time zone'),
    received_at: col('timestamp with time zone'),
  },
  // INSERT en provider-gateway.ts (una fila por llamada saliente).
  connector_api_attempts: {
    id: db('bigint'),
    subject_id: col('text'),
    connector: col('text'),
    operation: col('text'),
    outcome: col('text'),
    latency_ms: col('integer'),
    created_at: col('timestamp with time zone'),
  },
  // health.service.ts: INSERT (connector, connector_mode, status, checked_at) y UPDATE de los demás.
  connector_health: {
    connector: col('text'),
    connector_mode: col('text'),
    status: col('text'),
    consecutive_failures: db('integer'),
    last_reason: col('text', true),
    degraded_since: col('timestamp with time zone', true),
    latency_ms: col('integer', true),
    last_success_at: col('timestamp with time zone', true),
    checked_at: col('timestamp with time zone'),
  },
  // callbacks.service.ts: SELECT callback_path, active, allowed_source_cidrs, replay_window_seconds WHERE connector = $1.
  connector_callback_endpoints: {
    id: db('bigint'),
    connector: col('text'),
    callback_path: col('text'),
    active: col('boolean'),
    allowed_source_cidrs: col('jsonb', true),
    replay_window_seconds: col('integer', true),
  },
  // routing.service.ts: INSERT (version, rules, active) y SELECT version, rules WHERE active.
  routing_rule_sets: {
    version: col('integer'),
    rules: col('jsonb'),
    active: col('boolean'),
    created_at: db('timestamp with time zone'),
  },
  // connectors/bank-transfer/bank-transfer.connector.ts (`DbTransferReferenceStore`): INSERT (reference, charge_id, expires_at).
  bank_transfer_references: {
    reference: col('text'),
    charge_id: col('text'),
    expires_at: col('timestamp with time zone'),
    created_at: db('timestamp with time zone'),
  },
  // statements.service.ts: INSERT (connector, provider_reference, kind, charge_id, expected_minor, actual_minor, detected_at).
  statement_exceptions: {
    id: db('bigint'),
    connector: col('text'),
    provider_reference: col('text'),
    kind: col('text'),
    charge_id: col('text', true),
    expected_minor: col('bigint', true),
    actual_minor: col('bigint'),
    detected_at: col('timestamp with time zone'),
  },
};

/** Tablas técnicas de las librerías (`@pay/outbox`, `@pay/idempotency`): las gobiernan ellas, no este servicio. */
export const TECHNICAL_TABLES: readonly string[] = ['outbox_events', 'inbox_events', 'idempotency_keys'];
