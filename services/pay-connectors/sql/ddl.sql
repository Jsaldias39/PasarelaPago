-- SALUD v4.0.10 · perfil pay · base pay_connectors · DDL completo en orden (generado de diagram_70_pay_connectors.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 70 · schema pay_connectors
-- Generado de diagram_70_pay_connectors.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "connector_charges" (
    "id" text NOT NULL,
    "caller" text NOT NULL,
    "idempotency_key" text NOT NULL,
    "payment_intent_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "pay_mode" text NOT NULL,
    "connector" text NOT NULL,
    "connector_mode" text NOT NULL,
    "method" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL,
    "provider_status" text NOT NULL DEFAULT 'pending',
    "next_action" jsonb,
    "provider_reference" text,
    "failure_code" text,
    "ambiguous" boolean NOT NULL DEFAULT false,
    "send_claims" integer NOT NULL DEFAULT 0,
    "routing_version" integer NOT NULL,
    "routing_rule" text,
    "expires_at" timestamptz NOT NULL,
    "last_provider_event_at" timestamptz,
    "poll_attempts" integer NOT NULL DEFAULT 0,
    "next_poll_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_connector_charges" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "connector_refunds" (
    "id" text NOT NULL,
    "charge_id" text NOT NULL,
    "refund_id" text,
    "pay_mode" text NOT NULL,
    "caller" text NOT NULL,
    "idempotency_key" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL,
    "status" text NOT NULL DEFAULT 'pending',
    "provider_reference" text,
    "failure_code" text,
    "may_have_reached_provider" boolean NOT NULL DEFAULT false,
    "send_claims" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_connector_refunds" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "connector_callback_events" (
    "id" bigserial NOT NULL,
    "connector" text NOT NULL,
    "provider_event_id" text NOT NULL,
    "charge_id" text,
    "pay_mode" text,
    "status" text NOT NULL,
    "result" text NOT NULL,
    "observed_via" text NOT NULL,
    "occurred_at" timestamptz NOT NULL,
    "received_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_connector_callback_events" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "connector_api_attempts" (
    "id" bigserial NOT NULL,
    "subject_id" text NOT NULL,
    "connector" text NOT NULL,
    "operation" text NOT NULL,
    "outcome" text NOT NULL,
    "latency_ms" integer NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_connector_api_attempts" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "connector_health" (
    "connector" text NOT NULL,
    "connector_mode" text NOT NULL,
    "status" text NOT NULL,
    "consecutive_failures" integer NOT NULL DEFAULT 0,
    "last_reason" text,
    "degraded_since" timestamptz,
    "latency_ms" integer,
    "last_success_at" timestamptz,
    "checked_at" timestamptz NOT NULL,
    CONSTRAINT "pk_connector_health" PRIMARY KEY ("connector")
);

CREATE TABLE IF NOT EXISTS "connector_callback_endpoints" (
    "id" bigserial NOT NULL,
    "connector" text NOT NULL,
    "callback_path" text NOT NULL,
    "active" boolean NOT NULL DEFAULT true,
    "allowed_source_cidrs" jsonb,
    "replay_window_seconds" integer,
    CONSTRAINT "pk_connector_callback_endpoints" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "routing_rule_sets" (
    "version" integer NOT NULL,
    "rules" jsonb NOT NULL,
    "active" boolean NOT NULL DEFAULT false,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_routing_rule_sets" PRIMARY KEY ("version")
);

CREATE TABLE IF NOT EXISTS "bank_transfer_references" (
    "reference" text NOT NULL,
    "charge_id" text NOT NULL,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bank_transfer_references" PRIMARY KEY ("reference")
);

CREATE TABLE IF NOT EXISTS "statement_exceptions" (
    "id" bigserial NOT NULL,
    "connector" text NOT NULL,
    "provider_reference" text NOT NULL,
    "kind" text NOT NULL,
    "charge_id" text,
    "expected_minor" bigint,
    "actual_minor" bigint NOT NULL,
    "detected_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_statement_exceptions" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "connector_transfers" (
    "id" text NOT NULL,
    "business_ref" text NOT NULL,
    "attempt" integer NOT NULL,
    "pay_mode" text NOT NULL,
    "caller" text NOT NULL,
    "connector" text NOT NULL,
    "connector_mode" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL,
    "destination_ref" text NOT NULL,
    "status" text NOT NULL DEFAULT 'pending',
    "provider_reference" text,
    "failure_code" text,
    "may_have_reached_provider" boolean NOT NULL DEFAULT false,
    "send_claims" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_connector_transfers" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "outbox_events" (
    "id" uuid NOT NULL,
    "seq" bigserial NOT NULL,
    "aggregate_type" text NOT NULL,
    "aggregate_id" text NOT NULL,
    "type" text NOT NULL,
    "subject" text NOT NULL,
    "envelope" jsonb NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "published_at" timestamptz,
    "attempts" integer NOT NULL DEFAULT 0,
    "last_error" text,
    CONSTRAINT "pk_outbox_events" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "inbox_events" (
    "consumer" text NOT NULL,
    "event_id" text NOT NULL,
    "processed_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_inbox_events" PRIMARY KEY ("consumer", "event_id")
);

CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "scope" text NOT NULL,
    "key" text NOT NULL,
    "request_hash" text NOT NULL,
    "state" text NOT NULL,
    "recovery_point" text NOT NULL DEFAULT 'started',
    "response_status" integer,
    "response_body" jsonb,
    "locked_at" timestamptz,
    "lock_token" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "expires_at" timestamptz NOT NULL,
    CONSTRAINT "pk_idempotency_keys" PRIMARY KEY ("scope", "key")
);

-- >>> 03_fk_intra.sql
-- SALUD v4.0.10 · módulo 70 · schema pay_connectors
-- Generado de diagram_70_pay_connectors.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "connector_refunds"
        ADD CONSTRAINT "fk_connector_refunds_charge_id" FOREIGN KEY ("charge_id")
        REFERENCES "connector_charges" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "bank_transfer_references"
        ADD CONSTRAINT "fk_bank_transfer_references_charge_id" FOREIGN KEY ("charge_id")
        REFERENCES "connector_charges" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 70 · schema pay_connectors
-- Generado de diagram_70_pay_connectors.puml — NO editar a mano.


CREATE UNIQUE INDEX IF NOT EXISTS "connector_charges_caller_key_uidx" ON "connector_charges" ("caller", "pay_mode", "idempotency_key");

CREATE UNIQUE INDEX IF NOT EXISTS "connector_charges_live_intent_uidx" ON "connector_charges" ("pay_mode", "payment_intent_id") WHERE provider_status IN ('pending', 'authorized', 'captured');

CREATE INDEX IF NOT EXISTS "connector_charges_poll_idx" ON "connector_charges" ("next_poll_at") WHERE provider_status IN ('pending', 'authorized');

CREATE UNIQUE INDEX IF NOT EXISTS "connector_refunds_caller_key_uidx" ON "connector_refunds" ("caller", "pay_mode", "idempotency_key");

CREATE INDEX IF NOT EXISTS "connector_refunds_charge_idx" ON "connector_refunds" ("charge_id");

CREATE UNIQUE INDEX IF NOT EXISTS "connector_refunds_refund_id_uidx" ON "connector_refunds" ("pay_mode", "refund_id") WHERE refund_id IS NOT NULL AND status <> 'failed';

CREATE UNIQUE INDEX IF NOT EXISTS "connector_callback_events_dedup_uidx" ON "connector_callback_events" ("connector", "provider_event_id");

CREATE INDEX IF NOT EXISTS "connector_callback_events_charge_idx" ON "connector_callback_events" ("charge_id");

CREATE INDEX IF NOT EXISTS "connector_api_attempts_subject_idx" ON "connector_api_attempts" ("subject_id", "id");

CREATE UNIQUE INDEX IF NOT EXISTS "connector_callback_endpoints_path_uidx" ON "connector_callback_endpoints" ("connector", "callback_path");

CREATE UNIQUE INDEX IF NOT EXISTS "routing_rule_sets_one_active_uidx" ON "routing_rule_sets" ("active") WHERE active;

CREATE UNIQUE INDEX IF NOT EXISTS "bank_transfer_references_charge_uidx" ON "bank_transfer_references" ("charge_id");

CREATE UNIQUE INDEX IF NOT EXISTS "statement_exceptions_line_uidx" ON "statement_exceptions" ("connector", "provider_reference", "kind");

CREATE UNIQUE INDEX IF NOT EXISTS "connector_transfers_ref_attempt_uidx" ON "connector_transfers" ("pay_mode", "business_ref", "attempt");

CREATE UNIQUE INDEX IF NOT EXISTS "connector_transfers_one_paid_uidx" ON "connector_transfers" ("pay_mode", "business_ref") WHERE status = 'paid';

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_seq_key" ON "outbox_events" ("seq");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx" ON "outbox_events" ("seq") WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 70 · base pay_connectors
-- Generado de diagram_70_pay_connectors.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

-- `may_have_reached_provider` y `send_claims` son MONÓTONOS: una vez que una orden pudo haber llegado, ningún camino (ni una
-- corrección a mano) puede volver a decir que no. Se hace cumplir en la base, no solo en el código.
CREATE OR REPLACE FUNCTION connector_money_flags_monotone() RETURNS trigger AS $$
BEGIN
  IF OLD.may_have_reached_provider AND NOT NEW.may_have_reached_provider THEN
    RAISE EXCEPTION 'may_have_reached_provider es monotono: no puede volver a false' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.send_claims < OLD.send_claims THEN
    RAISE EXCEPTION 'send_claims es monotono: no puede disminuir' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- connector_charges (revisión de seguridad 2026-10-28): `send_claims` solo crece (charges.service.ts lo incrementa y nada lo baja), así que se
-- protege igual que en transfers/refunds. Esta tabla NO tiene `may_have_reached_provider`: su equivalente es `ambiguous`, y `ambiguous` true -> false
-- es una transición LEGÍTIMA y NO se restringe: lo baja un callback o una consulta autoritativa que resuelve el cobro (apply.ts: `ambiguous = false`
-- al aplicar un estado confirmado por el proveedor) o un `Unavailable` cuando NADIE reclamó después (charges.service.ts: `SET ambiguous = false ...
-- WHERE send_claims = mine`). Hacerlo monótono dejaría todo cobro ambiguo ambiguo para siempre y bloquearía su resolución.
CREATE OR REPLACE FUNCTION connector_charges_send_claims_monotone() RETURNS trigger AS $$
BEGIN
  IF NEW.send_claims < OLD.send_claims THEN
    RAISE EXCEPTION 'send_claims es monotono: no puede disminuir' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- TRUNCATE: los tres registros de dinero (cobros, reembolsos, transferencias) son de solo-agregar (CLAUDE.md regla 11); un TRUNCATE no pasa por los
-- triggers de fila. No existía ningún guardián de TRUNCATE en pay_connectors.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_id_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_id_check" CHECK (id ~ '^ch_[a-z0-9]{10,40}$');

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_payment_intent_id_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_payment_intent_id_check" CHECK (payment_intent_id ~ '^pi_[a-z0-9]{10,40}$');

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_merchant_id_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_merchant_id_check" CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$');

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_pay_mode_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_pay_mode_check" CHECK (pay_mode IN ('test', 'live'));

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_connector_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_connector_check" CHECK (connector IN ('mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer'));

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_connector_mode_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_connector_mode_check" CHECK (connector_mode IN ('sandbox', 'live'));

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_method_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_method_check" CHECK (method IN ('qr', 'card', 'bank_transfer'));

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_amount_minor_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_amount_minor_check" CHECK (amount_minor > 0);

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_currency_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_currency_check" CHECK (currency = 'BOB');

ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_provider_status_check";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_provider_status_check" CHECK (provider_status IN ('pending', 'authorized', 'captured', 'failed', 'canceled', 'expired'));

-- Una clave `test` solo opera con un conector `sandbox` y una `live` con uno `live`: jamás se cae en `live` por defecto.
ALTER TABLE "connector_charges" DROP CONSTRAINT IF EXISTS "connector_charges_mode_match_ck";
ALTER TABLE "connector_charges" ADD CONSTRAINT "connector_charges_mode_match_ck" CHECK ((pay_mode = 'test' AND connector_mode = 'sandbox') OR (pay_mode = 'live' AND connector_mode = 'live'));

ALTER TABLE "connector_refunds" DROP CONSTRAINT IF EXISTS "connector_refunds_id_check";
ALTER TABLE "connector_refunds" ADD CONSTRAINT "connector_refunds_id_check" CHECK (id ~ '^cr_[a-z0-9]{10,40}$');

ALTER TABLE "connector_refunds" DROP CONSTRAINT IF EXISTS "connector_refunds_refund_id_check";
ALTER TABLE "connector_refunds" ADD CONSTRAINT "connector_refunds_refund_id_check" CHECK (refund_id IS NULL OR refund_id ~ '^re_[a-z0-9]{10,40}$');

ALTER TABLE "connector_refunds" DROP CONSTRAINT IF EXISTS "connector_refunds_pay_mode_check";
ALTER TABLE "connector_refunds" ADD CONSTRAINT "connector_refunds_pay_mode_check" CHECK (pay_mode IN ('test', 'live'));

ALTER TABLE "connector_refunds" DROP CONSTRAINT IF EXISTS "connector_refunds_amount_minor_check";
ALTER TABLE "connector_refunds" ADD CONSTRAINT "connector_refunds_amount_minor_check" CHECK (amount_minor > 0);

ALTER TABLE "connector_refunds" DROP CONSTRAINT IF EXISTS "connector_refunds_currency_check";
ALTER TABLE "connector_refunds" ADD CONSTRAINT "connector_refunds_currency_check" CHECK (currency = 'BOB');

ALTER TABLE "connector_refunds" DROP CONSTRAINT IF EXISTS "connector_refunds_status_check";
ALTER TABLE "connector_refunds" ADD CONSTRAINT "connector_refunds_status_check" CHECK (status IN ('pending', 'succeeded', 'failed'));

ALTER TABLE "connector_callback_events" DROP CONSTRAINT IF EXISTS "connector_callback_events_provider_event_id_check";
ALTER TABLE "connector_callback_events" ADD CONSTRAINT "connector_callback_events_provider_event_id_check" CHECK (length(provider_event_id) BETWEEN 1 AND 200);

ALTER TABLE "connector_callback_events" DROP CONSTRAINT IF EXISTS "connector_callback_events_pay_mode_check";
ALTER TABLE "connector_callback_events" ADD CONSTRAINT "connector_callback_events_pay_mode_check" CHECK (pay_mode IS NULL OR pay_mode IN ('test', 'live'));

ALTER TABLE "connector_callback_events" DROP CONSTRAINT IF EXISTS "connector_callback_events_result_check";
ALTER TABLE "connector_callback_events" ADD CONSTRAINT "connector_callback_events_result_check" CHECK (result IN ('applied', 'duplicate', 'stale', 'contradiction'));

ALTER TABLE "connector_callback_events" DROP CONSTRAINT IF EXISTS "connector_callback_events_observed_via_check";
ALTER TABLE "connector_callback_events" ADD CONSTRAINT "connector_callback_events_observed_via_check" CHECK (observed_via IN ('callback', 'status_inquiry'));

ALTER TABLE "connector_api_attempts" DROP CONSTRAINT IF EXISTS "connector_api_attempts_operation_check";
ALTER TABLE "connector_api_attempts" ADD CONSTRAINT "connector_api_attempts_operation_check" CHECK (operation IN ('create_charge', 'get_status', 'cancel', 'refund', 'get_refund', 'create_transfer', 'get_transfer'));

ALTER TABLE "connector_api_attempts" DROP CONSTRAINT IF EXISTS "connector_api_attempts_outcome_check";
ALTER TABLE "connector_api_attempts" ADD CONSTRAINT "connector_api_attempts_outcome_check" CHECK (outcome IN ('ok', 'unavailable', 'timeout', 'rejected'));

ALTER TABLE "connector_api_attempts" DROP CONSTRAINT IF EXISTS "connector_api_attempts_latency_ms_check";
ALTER TABLE "connector_api_attempts" ADD CONSTRAINT "connector_api_attempts_latency_ms_check" CHECK (latency_ms >= 0);

ALTER TABLE "connector_health" DROP CONSTRAINT IF EXISTS "connector_health_connector_mode_check";
ALTER TABLE "connector_health" ADD CONSTRAINT "connector_health_connector_mode_check" CHECK (connector_mode IN ('sandbox', 'live'));

ALTER TABLE "connector_health" DROP CONSTRAINT IF EXISTS "connector_health_status_check";
ALTER TABLE "connector_health" ADD CONSTRAINT "connector_health_status_check" CHECK (status IN ('up', 'degraded', 'down'));

ALTER TABLE "connector_health" DROP CONSTRAINT IF EXISTS "connector_health_consecutive_failures_check";
ALTER TABLE "connector_health" ADD CONSTRAINT "connector_health_consecutive_failures_check" CHECK (consecutive_failures >= 0);

ALTER TABLE "connector_health" DROP CONSTRAINT IF EXISTS "connector_health_last_reason_check";
ALTER TABLE "connector_health" ADD CONSTRAINT "connector_health_last_reason_check" CHECK (last_reason IS NULL OR last_reason IN ('timeout', 'error_rate', 'unreachable', 'auth_failed'));

ALTER TABLE "connector_callback_endpoints" DROP CONSTRAINT IF EXISTS "connector_callback_endpoints_replay_window_seconds_check";
ALTER TABLE "connector_callback_endpoints" ADD CONSTRAINT "connector_callback_endpoints_replay_window_seconds_check" CHECK (replay_window_seconds IS NULL OR replay_window_seconds > 0);

ALTER TABLE "routing_rule_sets" DROP CONSTRAINT IF EXISTS "routing_rule_sets_version_check";
ALTER TABLE "routing_rule_sets" ADD CONSTRAINT "routing_rule_sets_version_check" CHECK (version >= 1);

ALTER TABLE "bank_transfer_references" DROP CONSTRAINT IF EXISTS "bank_transfer_references_reference_check";
ALTER TABLE "bank_transfer_references" ADD CONSTRAINT "bank_transfer_references_reference_check" CHECK (reference ~ '^TR[A-Z2-7]{10}$');

ALTER TABLE "statement_exceptions" DROP CONSTRAINT IF EXISTS "statement_exceptions_kind_check";
ALTER TABLE "statement_exceptions" ADD CONSTRAINT "statement_exceptions_kind_check" CHECK (kind IN ('unmatched', 'amount_mismatch', 'late_credit'));

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_id_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_id_check" CHECK (id ~ '^tr_[a-z0-9]{10,40}$');

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_business_ref_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_business_ref_check" CHECK (business_ref ~ '^[A-Za-z0-9:._-]{3,150}$');

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_attempt_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_attempt_check" CHECK (attempt >= 1);

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_pay_mode_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_pay_mode_check" CHECK (pay_mode IN ('test', 'live'));

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_connector_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_connector_check" CHECK (connector IN ('mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer'));

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_connector_mode_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_connector_mode_check" CHECK (connector_mode IN ('sandbox', 'live'));

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_amount_minor_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_amount_minor_check" CHECK (amount_minor > 0);

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_currency_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_currency_check" CHECK (currency = 'BOB');

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_destination_ref_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_destination_ref_check" CHECK (length(destination_ref) BETWEEN 1 AND 100);

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_status_check";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_status_check" CHECK (status IN ('pending', 'in_transit', 'paid', 'failed'));

-- Registro de dinero de solo-agregar: `failed` solo con explicación (la confirmó el proveedor o el conector garantiza que no envió).
ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_failed_reason_ck";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_failed_reason_ck" CHECK (status <> 'failed' OR failure_code IS NOT NULL);

ALTER TABLE "connector_transfers" DROP CONSTRAINT IF EXISTS "connector_transfers_mode_match_ck";
ALTER TABLE "connector_transfers" ADD CONSTRAINT "connector_transfers_mode_match_ck" CHECK ((pay_mode = 'test' AND connector_mode = 'sandbox') OR (pay_mode = 'live' AND connector_mode = 'live'));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));

DROP TRIGGER IF EXISTS "connector_charges_monotone_trg" ON "connector_charges";
CREATE TRIGGER connector_charges_monotone_trg BEFORE UPDATE ON connector_charges FOR EACH ROW EXECUTE FUNCTION connector_charges_send_claims_monotone();

DROP TRIGGER IF EXISTS "connector_charges_no_truncate" ON "connector_charges";
CREATE TRIGGER connector_charges_no_truncate BEFORE TRUNCATE ON connector_charges FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "connector_transfers_no_truncate" ON "connector_transfers";
CREATE TRIGGER connector_transfers_no_truncate BEFORE TRUNCATE ON connector_transfers FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "connector_refunds_no_truncate" ON "connector_refunds";
CREATE TRIGGER connector_refunds_no_truncate BEFORE TRUNCATE ON connector_refunds FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "connector_transfers_monotone_trg" ON "connector_transfers";
CREATE TRIGGER connector_transfers_monotone_trg BEFORE UPDATE ON connector_transfers FOR EACH ROW EXECUTE FUNCTION connector_money_flags_monotone();

DROP TRIGGER IF EXISTS "connector_refunds_monotone_trg" ON "connector_refunds";
CREATE TRIGGER connector_refunds_monotone_trg BEFORE UPDATE ON connector_refunds FOR EACH ROW EXECUTE FUNCTION connector_money_flags_monotone();

-- connector_callback_events (huella de deduplicación y auditoría de lo que dijo el banco) y connector_api_attempts (cada llamada saliente: la evidencia de «timeout, luego ok» de la regla 11)
-- son de SOLO-AGREGAR: apply.ts y provider-gateway.ts solo hacen INSERT (el primero con ON CONFLICT DO NOTHING) y no hay UPDATE/DELETE/TRUNCATE en services/*/src. Guardián solo de
-- UPDATE/DELETE/TRUNCATE, NO de INSERT: connector_api_attempts es de alto volumen y no paga costo por llamada.
DROP TRIGGER IF EXISTS "connector_callback_events_immutable" ON "connector_callback_events";
CREATE TRIGGER connector_callback_events_immutable BEFORE UPDATE OR DELETE ON connector_callback_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "connector_callback_events_no_truncate" ON "connector_callback_events";
CREATE TRIGGER connector_callback_events_no_truncate BEFORE TRUNCATE ON connector_callback_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "connector_api_attempts_immutable" ON "connector_api_attempts";
CREATE TRIGGER connector_api_attempts_immutable BEFORE UPDATE OR DELETE ON connector_api_attempts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "connector_api_attempts_no_truncate" ON "connector_api_attempts";
CREATE TRIGGER connector_api_attempts_no_truncate BEFORE TRUNCATE ON connector_api_attempts FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
