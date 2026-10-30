-- SALUD v4.0.10 · perfil pay · base pay_schedules · DDL completo en orden (generado de diagram_77_pay_schedules.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 77 · schema pay_schedules
-- Generado de diagram_77_pay_schedules.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "merchant_replica" (
    "merchant_id" text NOT NULL,
    "status" text NOT NULL,
    "as_of" timestamptz NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_merchant_replica" PRIMARY KEY ("merchant_id")
);

CREATE TABLE IF NOT EXISTS "mandates" (
    "id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "mode" text NOT NULL,
    "kind" text NOT NULL,
    "beneficiary_merchant_id" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL DEFAULT 'BOB',
    "frequency" text NOT NULL DEFAULT 'monthly',
    "day_of_month" smallint NOT NULL,
    "start_date" date NOT NULL,
    "end_date" date,
    "description" text,
    "status" text NOT NULL DEFAULT 'active',
    "next_run_on" date,
    "created_at" timestamptz NOT NULL,
    "canceled_at" timestamptz,
    CONSTRAINT "pk_mandates" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "scheduled_payments" (
    "id" text NOT NULL,
    "mandate_id" text NOT NULL,
    "period" text NOT NULL,
    "due_on" date NOT NULL,
    "status" text NOT NULL DEFAULT 'due',
    "phase" text NOT NULL DEFAULT 'hold',
    "attempts" integer NOT NULL DEFAULT 0,
    "ledger_attempt" integer NOT NULL DEFAULT 1,
    "hold_id" text,
    "ledger_transaction_id" text,
    "ledger_transfer_id" text,
    "next_attempt_at" timestamptz NOT NULL,
    "lease_until" timestamptz,
    "last_failure_code" text,
    "needs_review" boolean NOT NULL DEFAULT false,
    "created_at" timestamptz NOT NULL,
    "executed_at" timestamptz,
    CONSTRAINT "pk_scheduled_payments" PRIMARY KEY ("id")
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
-- SALUD v4.0.10 · módulo 77 · schema pay_schedules
-- Generado de diagram_77_pay_schedules.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "scheduled_payments"
        ADD CONSTRAINT "fk_scheduled_payments_mandate_id" FOREIGN KEY ("mandate_id")
        REFERENCES "mandates" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 77 · schema pay_schedules
-- Generado de diagram_77_pay_schedules.puml — NO editar a mano.


CREATE INDEX IF NOT EXISTS "mandates_owner_idx" ON "mandates" ("merchant_id", "mode", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "mandates_due_idx" ON "mandates" ("next_run_on") WHERE status = 'active' AND next_run_on IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_payments_period_uq" ON "scheduled_payments" ("mandate_id", "period");

CREATE INDEX IF NOT EXISTS "scheduled_payments_due_idx" ON "scheduled_payments" ("next_attempt_at") WHERE status IN ('due', 'waiting_funds');

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_seq_key" ON "outbox_events" ("seq");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx" ON "outbox_events" ("seq") WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 77 · base pay_schedules
-- Generado de diagram_77_pay_schedules.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

ALTER TABLE "merchant_replica" DROP CONSTRAINT IF EXISTS "merchant_replica_id_format";
ALTER TABLE "merchant_replica" ADD CONSTRAINT "merchant_replica_id_format" CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$');

ALTER TABLE "merchant_replica" DROP CONSTRAINT IF EXISTS "merchant_replica_status_valid";
ALTER TABLE "merchant_replica" ADD CONSTRAINT "merchant_replica_status_valid" CHECK (status IN ('active', 'suspended', 'closed'));

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_id_format";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_id_format" CHECK (id ~ '^md_[a-z0-9]{10,40}$');

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_merchant_format";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_merchant_format" CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$' AND beneficiary_merchant_id ~ '^mc_[a-z0-9]{10,40}$');

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_mode_valid";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_mode_valid" CHECK (mode IN ('test', 'live'));

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_kind_valid";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_kind_valid" CHECK (kind IN ('pay_obligation', 'pay_commission'));

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_amount_pos";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_amount_pos" CHECK (amount_minor >= 1);

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_currency_bob";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_currency_bob" CHECK (currency = 'BOB');

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_frequency_monthly";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_frequency_monthly" CHECK (frequency = 'monthly');

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_day_valid";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_day_valid" CHECK (day_of_month BETWEEN 1 AND 28);

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_end_after_start";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_end_after_start" CHECK (end_date IS NULL OR end_date >= start_date);

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_status_valid";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_status_valid" CHECK (status IN ('active', 'paused_insufficient_funds', 'canceled', 'completed'));

ALTER TABLE "mandates" DROP CONSTRAINT IF EXISTS "mandates_not_self";
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_not_self" CHECK (merchant_id <> beneficiary_merchant_id);

ALTER TABLE "scheduled_payments" DROP CONSTRAINT IF EXISTS "scheduled_payments_id_format";
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_id_format" CHECK (id ~ '^sp_[a-z0-9]{10,40}$');

ALTER TABLE "scheduled_payments" DROP CONSTRAINT IF EXISTS "scheduled_payments_period_format";
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_period_format" CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$');

ALTER TABLE "scheduled_payments" DROP CONSTRAINT IF EXISTS "scheduled_payments_status_valid";
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_status_valid" CHECK (status IN ('due', 'waiting_funds', 'executed', 'failed', 'canceled'));

ALTER TABLE "scheduled_payments" DROP CONSTRAINT IF EXISTS "scheduled_payments_phase_valid";
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_phase_valid" CHECK (phase IN ('hold', 'post', 'release', 'void', 'reverse', 'done'));

-- El dinero se movió: un `executed` siempre tiene su asiento (`tx_…`), que es lo que cita `scheduled_payment.executed.ledger_transfer_id`.
ALTER TABLE "scheduled_payments" DROP CONSTRAINT IF EXISTS "scheduled_payments_executed_has_transaction";
ALTER TABLE "scheduled_payments" ADD CONSTRAINT "scheduled_payments_executed_has_transaction" CHECK (status <> 'executed' OR (ledger_transaction_id IS NOT NULL AND executed_at IS NOT NULL));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));
