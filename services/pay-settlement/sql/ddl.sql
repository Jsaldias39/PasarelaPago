-- SALUD v4.0.10 · perfil pay · base pay_settlement · DDL completo en orden (generado de diagram_78_pay_settlement.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 78 · schema pay_settlement
-- Generado de diagram_78_pay_settlement.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "settlement_merchants" (
    "merchant_id" text NOT NULL,
    "first_seen_at" timestamptz NOT NULL DEFAULT now(),
    "last_activity_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_merchants" PRIMARY KEY ("merchant_id")
);

CREATE TABLE IF NOT EXISTS "settlement_merchant_marks" (
    "mode" text NOT NULL,
    "merchant_id" text NOT NULL,
    "watermark_at" timestamptz,
    "residual_minor" bigint NOT NULL DEFAULT 0,
    CONSTRAINT "pk_settlement_merchant_marks" PRIMARY KEY ("mode", "merchant_id")
);

CREATE TABLE IF NOT EXISTS "settlement_fee_plans" (
    "merchant_id" text NOT NULL,
    "version" integer NOT NULL,
    "monthly_fee_minor" bigint NOT NULL DEFAULT 0,
    "effective_from" timestamptz NOT NULL,
    "effective_to" timestamptz,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_fee_plans" PRIMARY KEY ("merchant_id")
);

CREATE TABLE IF NOT EXISTS "settlement_batches" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "cutoff_date" date NOT NULL,
    "release_days" integer NOT NULL,
    "release_before" timestamptz NOT NULL,
    "period_from" timestamptz NOT NULL,
    "status" text NOT NULL,
    "merchants_count" integer NOT NULL DEFAULT 0,
    "released_minor" bigint NOT NULL DEFAULT 0,
    "payouts_count" integer NOT NULL DEFAULT 0,
    "failed_count" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "completed_at" timestamptz,
    CONSTRAINT "pk_settlement_batches" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "settlement_batch_items" (
    "batch_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "status" text NOT NULL,
    "window_from" timestamptz,
    "planned_release_minor" bigint,
    "new_residual_minor" bigint,
    "ledger_attempt" integer NOT NULL DEFAULT 1,
    "release_ref" text,
    "released_minor" bigint NOT NULL DEFAULT 0,
    "netting_minor" bigint,
    "netting_attempt" integer NOT NULL DEFAULT 1,
    "payout_id" text,
    "failure_code" text,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_batch_items" PRIMARY KEY ("batch_id", "merchant_id")
);

CREATE TABLE IF NOT EXISTS "settlement_payouts" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "merchant_id" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" char(3) NOT NULL,
    "rail" text NOT NULL,
    "simulated" boolean NOT NULL,
    "reason" text NOT NULL,
    "status" text NOT NULL,
    "step" text NOT NULL,
    "hold_id" text,
    "hold_business_ref" text NOT NULL,
    "rail_reference" text,
    "batch_id" text,
    "requested_by" text NOT NULL,
    "failure_code" text,
    "period_from" timestamptz NOT NULL,
    "period_to" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "paid_at" timestamptz,
    CONSTRAINT "pk_settlement_payouts" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "settlement_charges" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "merchant_id" text NOT NULL,
    "kind" text NOT NULL,
    "period_key" text NOT NULL,
    "credit_account" text NOT NULL,
    "ledger_code" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "collected_minor" bigint NOT NULL DEFAULT 0,
    "status" text NOT NULL,
    "requested_by" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "collected_at" timestamptz,
    CONSTRAINT "pk_settlement_charges" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "settlement_charge_collections" (
    "charge_id" text NOT NULL,
    "seq" integer NOT NULL,
    "amount_minor" bigint NOT NULL,
    "ledger_ref" text NOT NULL,
    "status" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_charge_collections" PRIMARY KEY ("charge_id", "seq")
);

CREATE TABLE IF NOT EXISTS "settlement_reconciliation_runs" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "connector" text NOT NULL,
    "period_from" timestamptz NOT NULL,
    "period_to" timestamptz NOT NULL,
    "source" text NOT NULL,
    "status" text NOT NULL,
    "matched_count" integer NOT NULL DEFAULT 0,
    "exception_count" integer NOT NULL DEFAULT 0,
    "ignored_count" integer NOT NULL DEFAULT 0,
    "failure_code" text,
    "requested_by" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "completed_at" timestamptz,
    CONSTRAINT "pk_settlement_reconciliation_runs" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "settlement_statement_lines" (
    "run_id" text NOT NULL,
    "line_ref" text NOT NULL,
    "provider_reference" text NOT NULL,
    "our_reference" text,
    "direction" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "value_date" date NOT NULL,
    "booked_at" timestamptz,
    "outcome" text NOT NULL,
    CONSTRAINT "pk_settlement_statement_lines" PRIMARY KEY ("run_id", "line_ref")
);

CREATE TABLE IF NOT EXISTS "settlement_exceptions" (
    "id" text NOT NULL,
    "mode" text,
    "run_id" text,
    "connector" text,
    "kind" text NOT NULL,
    "provider_reference" text,
    "business_ref" text,
    "statement_amount_minor" bigint,
    "ledger_amount_minor" bigint,
    "difference_minor" bigint NOT NULL,
    "statement_line_ref" text NOT NULL,
    "merchant_id" text,
    "payment_intent_id" text,
    "source_detail" jsonb,
    "status" text NOT NULL,
    "resolution" text,
    "resolved_by" text,
    "resolution_note" text,
    "resolved_at" timestamptz,
    "dedupe_key" char(64) NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_exceptions" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "settlement_adjustment_requests" (
    "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    "exception_id" text NOT NULL,
    "requested_by" text NOT NULL,
    "difference_minor" bigint NOT NULL,
    "note" text NOT NULL,
    "status" text NOT NULL DEFAULT 'requested',
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_adjustment_requests" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "settlement_audit" (
    "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
    "actor" text NOT NULL,
    "role" text NOT NULL,
    "action" text NOT NULL,
    "subject" text NOT NULL,
    "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_settlement_audit" PRIMARY KEY ("id")
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
-- SALUD v4.0.10 · módulo 78 · schema pay_settlement
-- Generado de diagram_78_pay_settlement.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "settlement_merchant_marks"
        ADD CONSTRAINT "fk_settlement_merchant_marks_merchant_id" FOREIGN KEY ("merchant_id")
        REFERENCES "settlement_merchants" ("merchant_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "settlement_batch_items"
        ADD CONSTRAINT "fk_settlement_batch_items_batch_id" FOREIGN KEY ("batch_id")
        REFERENCES "settlement_batches" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "settlement_payouts"
        ADD CONSTRAINT "fk_settlement_payouts_batch_id" FOREIGN KEY ("batch_id")
        REFERENCES "settlement_batches" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "settlement_charge_collections"
        ADD CONSTRAINT "fk_settlement_charge_collections_charge_id" FOREIGN KEY ("charge_id")
        REFERENCES "settlement_charges" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "settlement_statement_lines"
        ADD CONSTRAINT "fk_settlement_statement_lines_run_id" FOREIGN KEY ("run_id")
        REFERENCES "settlement_reconciliation_runs" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "settlement_exceptions"
        ADD CONSTRAINT "fk_settlement_exceptions_run_id" FOREIGN KEY ("run_id")
        REFERENCES "settlement_reconciliation_runs" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "settlement_adjustment_requests"
        ADD CONSTRAINT "fk_settlement_adjustment_requests_exception_id" FOREIGN KEY ("exception_id")
        REFERENCES "settlement_exceptions" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 78 · schema pay_settlement
-- Generado de diagram_78_pay_settlement.puml — NO editar a mano.


CREATE UNIQUE INDEX IF NOT EXISTS "settlement_batches_cutoff_unique" ON "settlement_batches" ("mode", "cutoff_date");

CREATE UNIQUE INDEX IF NOT EXISTS "settlement_payouts_batch_merchant_unique" ON "settlement_payouts" ("batch_id", "merchant_id") WHERE batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS "settlement_payouts_merchant_page" ON "settlement_payouts" ("mode", "merchant_id", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "settlement_payouts_open" ON "settlement_payouts" ("updated_at") WHERE step <> 'resolved';

CREATE UNIQUE INDEX IF NOT EXISTS "settlement_charges_period_unique" ON "settlement_charges" ("mode", "merchant_id", "kind", "period_key");

CREATE INDEX IF NOT EXISTS "settlement_charges_open" ON "settlement_charges" ("mode", "merchant_id") WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS "settlement_exceptions_dedupe_unique" ON "settlement_exceptions" ("dedupe_key");

CREATE INDEX IF NOT EXISTS "settlement_exceptions_page" ON "settlement_exceptions" ("mode", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "settlement_exceptions_run" ON "settlement_exceptions" ("run_id");

CREATE UNIQUE INDEX IF NOT EXISTS "settlement_adjustment_requests_exception_unique" ON "settlement_adjustment_requests" ("exception_id");

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_seq_key" ON "outbox_events" ("seq");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx" ON "outbox_events" ("seq") WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 78 · base pay_settlement
-- Generado de diagram_78_pay_settlement.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

ALTER TABLE "settlement_merchant_marks" DROP CONSTRAINT IF EXISTS "settlement_merchant_marks_mode_check";
ALTER TABLE "settlement_merchant_marks" ADD CONSTRAINT "settlement_merchant_marks_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "settlement_fee_plans" DROP CONSTRAINT IF EXISTS "settlement_fee_plans_version_check";
ALTER TABLE "settlement_fee_plans" ADD CONSTRAINT "settlement_fee_plans_version_check" CHECK (version >= 1);

ALTER TABLE "settlement_fee_plans" DROP CONSTRAINT IF EXISTS "settlement_fee_plans_monthly_fee_minor_check";
ALTER TABLE "settlement_fee_plans" ADD CONSTRAINT "settlement_fee_plans_monthly_fee_minor_check" CHECK (monthly_fee_minor >= 0);

ALTER TABLE "settlement_batches" DROP CONSTRAINT IF EXISTS "settlement_batches_mode_check";
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "settlement_batches" DROP CONSTRAINT IF EXISTS "settlement_batches_release_days_check";
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_release_days_check" CHECK (release_days BETWEEN 0 AND 60);

ALTER TABLE "settlement_batches" DROP CONSTRAINT IF EXISTS "settlement_batches_status_check";
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_status_check" CHECK (status IN ('running', 'completed', 'failed'));

ALTER TABLE "settlement_batches" DROP CONSTRAINT IF EXISTS "settlement_batches_released_minor_check";
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_released_minor_check" CHECK (released_minor >= 0);

ALTER TABLE "settlement_batch_items" DROP CONSTRAINT IF EXISTS "settlement_batch_items_status_check";
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_status_check" CHECK (status IN ('pending', 'planned', 'released', 'done', 'failed'));

ALTER TABLE "settlement_batch_items" DROP CONSTRAINT IF EXISTS "settlement_batch_items_planned_release_minor_check";
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_planned_release_minor_check" CHECK (planned_release_minor >= 0);

ALTER TABLE "settlement_batch_items" DROP CONSTRAINT IF EXISTS "settlement_batch_items_ledger_attempt_check";
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_ledger_attempt_check" CHECK (ledger_attempt >= 1);

ALTER TABLE "settlement_batch_items" DROP CONSTRAINT IF EXISTS "settlement_batch_items_released_minor_check";
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_released_minor_check" CHECK (released_minor >= 0);

ALTER TABLE "settlement_batch_items" DROP CONSTRAINT IF EXISTS "settlement_batch_items_netting_minor_check";
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_netting_minor_check" CHECK (netting_minor >= 0);

ALTER TABLE "settlement_batch_items" DROP CONSTRAINT IF EXISTS "settlement_batch_items_netting_attempt_check";
ALTER TABLE "settlement_batch_items" ADD CONSTRAINT "settlement_batch_items_netting_attempt_check" CHECK (netting_attempt >= 1);

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_mode_check";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_amount_minor_check";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_amount_minor_check" CHECK (amount_minor >= 1);

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_rail_check";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_rail_check" CHECK (rail IN ('bank_transfer', 'acquirer_settlement'));

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_reason_check";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_reason_check" CHECK (reason IN ('weekly_cut', 'mandate_obligation', 'mandate_commission', 'manual'));

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_status_check";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_status_check" CHECK (status IN ('pending', 'in_transit', 'paid', 'failed'));

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_step_check";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_step_check" CHECK (step IN ('created', 'held', 'sent', 'resolved'));

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_terminal_consistency";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_terminal_consistency" CHECK ((status IN ('paid', 'failed')) = (step = 'resolved'));

ALTER TABLE "settlement_payouts" DROP CONSTRAINT IF EXISTS "settlement_payouts_failure_consistency";
ALTER TABLE "settlement_payouts" ADD CONSTRAINT "settlement_payouts_failure_consistency" CHECK ((status = 'failed') = (failure_code IS NOT NULL));

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_mode_check";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_kind_check";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_kind_check" CHECK (kind IN ('monthly_fee', 'provider_commission', 'chargeback_debt'));

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_ledger_code_check";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_ledger_code_check" CHECK (ledger_code IN ('fee', 'refund'));

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_amount_minor_check";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_amount_minor_check" CHECK (amount_minor >= 1);

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_check";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_check" CHECK (collected_minor >= 0 AND collected_minor <= amount_minor);

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_status_check";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_status_check" CHECK (status IN ('open', 'collected'));

ALTER TABLE "settlement_charges" DROP CONSTRAINT IF EXISTS "settlement_charges_status_consistency";
ALTER TABLE "settlement_charges" ADD CONSTRAINT "settlement_charges_status_consistency" CHECK ((status = 'collected') = (collected_minor = amount_minor));

ALTER TABLE "settlement_charge_collections" DROP CONSTRAINT IF EXISTS "settlement_charge_collections_seq_check";
ALTER TABLE "settlement_charge_collections" ADD CONSTRAINT "settlement_charge_collections_seq_check" CHECK (seq >= 1);

ALTER TABLE "settlement_charge_collections" DROP CONSTRAINT IF EXISTS "settlement_charge_collections_amount_minor_check";
ALTER TABLE "settlement_charge_collections" ADD CONSTRAINT "settlement_charge_collections_amount_minor_check" CHECK (amount_minor >= 1);

ALTER TABLE "settlement_charge_collections" DROP CONSTRAINT IF EXISTS "settlement_charge_collections_status_check";
ALTER TABLE "settlement_charge_collections" ADD CONSTRAINT "settlement_charge_collections_status_check" CHECK (status IN ('planned', 'posted', 'rejected'));

ALTER TABLE "settlement_reconciliation_runs" DROP CONSTRAINT IF EXISTS "settlement_reconciliation_runs_mode_check";
ALTER TABLE "settlement_reconciliation_runs" ADD CONSTRAINT "settlement_reconciliation_runs_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "settlement_reconciliation_runs" DROP CONSTRAINT IF EXISTS "settlement_reconciliation_runs_source_check";
ALTER TABLE "settlement_reconciliation_runs" ADD CONSTRAINT "settlement_reconciliation_runs_source_check" CHECK (source IN ('api', 'csv', 'camt053'));

ALTER TABLE "settlement_reconciliation_runs" DROP CONSTRAINT IF EXISTS "settlement_reconciliation_runs_status_check";
ALTER TABLE "settlement_reconciliation_runs" ADD CONSTRAINT "settlement_reconciliation_runs_status_check" CHECK (status IN ('running', 'completed', 'failed'));

ALTER TABLE "settlement_statement_lines" DROP CONSTRAINT IF EXISTS "settlement_statement_lines_direction_check";
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_direction_check" CHECK (direction IN ('credit', 'debit'));

ALTER TABLE "settlement_statement_lines" DROP CONSTRAINT IF EXISTS "settlement_statement_lines_amount_minor_check";
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_amount_minor_check" CHECK (amount_minor >= 0);

ALTER TABLE "settlement_statement_lines" DROP CONSTRAINT IF EXISTS "settlement_statement_lines_outcome_check";
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_outcome_check" CHECK (outcome IN ('matched', 'exception', 'ignored'));

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_mode_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_kind_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_kind_check" CHECK (kind IN ('missing_in_ledger', 'missing_in_statement', 'amount_mismatch', 'duplicate_in_statement', 'unknown_reference', 'payment_contradiction'));

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_statement_amount_minor_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_statement_amount_minor_check" CHECK (statement_amount_minor >= 0);

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_ledger_amount_minor_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_ledger_amount_minor_check" CHECK (ledger_amount_minor >= 0);

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_status_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_status_check" CHECK (status IN ('open', 'resolved', 'dismissed'));

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_resolution_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_resolution_check" CHECK (resolution IN ('request_adjustment', 'dismiss'));

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_resolution_note_check";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_resolution_note_check" CHECK (char_length(resolution_note) <= 500);

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_origin_shape";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_origin_shape" CHECK ((kind = 'payment_contradiction' AND run_id IS NULL AND connector IS NULL AND source_detail IS NOT NULL) OR (kind <> 'payment_contradiction' AND run_id IS NOT NULL AND connector IS NOT NULL AND mode IS NOT NULL AND source_detail IS NULL));

ALTER TABLE "settlement_exceptions" DROP CONSTRAINT IF EXISTS "settlement_exceptions_resolution_consistency";
ALTER TABLE "settlement_exceptions" ADD CONSTRAINT "settlement_exceptions_resolution_consistency" CHECK ((status = 'open') = (resolution IS NULL));

ALTER TABLE "settlement_adjustment_requests" DROP CONSTRAINT IF EXISTS "settlement_adjustment_requests_status_check";
ALTER TABLE "settlement_adjustment_requests" ADD CONSTRAINT "settlement_adjustment_requests_status_check" CHECK (status IN ('requested'));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));

-- Rastro de auditoría de SOLO-AGREGAR (CLAUDE.md regla 11): payout.service.ts (INSERT … SELECT … WHERE NOT EXISTS) y reconciliation.service.ts (INSERT) son los únicos que escriben
-- y no hay UPDATE/DELETE/TRUNCATE sobre ella en services/*/src, test/ ni e2e/. Una política de retención o de supresión sería un procedimiento aparte (decisión de legal), no un DELETE suelto.
DROP TRIGGER IF EXISTS "settlement_audit_immutable" ON "settlement_audit";
CREATE TRIGGER settlement_audit_immutable BEFORE UPDATE OR DELETE ON settlement_audit FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "settlement_audit_no_truncate" ON "settlement_audit";
CREATE TRIGGER settlement_audit_no_truncate BEFORE TRUNCATE ON settlement_audit FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
