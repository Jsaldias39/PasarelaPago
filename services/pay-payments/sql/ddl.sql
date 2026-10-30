-- SALUD v4.0.10 · perfil pay · base pay_payments · DDL completo en orden (generado de diagram_74_pay_payments.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 74 · schema pay_payments
-- Generado de diagram_74_pay_payments.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "payment_intents" (
    "id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "mode" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL DEFAULT 'BOB',
    "method" text NOT NULL,
    "status" text NOT NULL DEFAULT 'processing',
    "fee_minor" bigint NOT NULL,
    "net_minor" bigint NOT NULL,
    "description" text,
    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "next_action" jsonb,
    "failure_code" text,
    "failure_reason" text,
    "connector" text,
    "charge_id" text,
    "charge_status" text NOT NULL DEFAULT 'pending',
    "ledger_attempt" integer NOT NULL DEFAULT 1,
    "ledger_transfer_id" text,
    "card_token" text,
    "wallet_user_ref" text,
    "source" jsonb,
    "kind" text,
    "beneficiary_merchant_id" text,
    "payer_name" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "expires_at" timestamptz NOT NULL,
    "succeeded_at" timestamptz,
    "completed_at" timestamptz,
    CONSTRAINT "pk_payment_intents" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "refunds" (
    "id" text NOT NULL,
    "payment_intent_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "mode" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL DEFAULT 'BOB',
    "status" text NOT NULL DEFAULT 'pending',
    "reason" text,
    "failure_code" text,
    "ledger_hold_id" text,
    "ledger_transfer_id" text,
    "connector_refund_id" text,
    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "completed_at" timestamptz,
    CONSTRAINT "pk_refunds" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "disputes" (
    "id" text NOT NULL,
    "payment_intent_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "mode" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL DEFAULT 'BOB',
    "status" text NOT NULL DEFAULT 'open',
    "evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "ledger_transfer_id" text,
    "opened_at" timestamptz NOT NULL DEFAULT now(),
    "resolved_at" timestamptz,
    CONSTRAINT "pk_disputes" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_cancellation_requests" (
    "id" bigserial NOT NULL,
    "payment_intent_id" text NOT NULL,
    "requested_at" timestamptz NOT NULL DEFAULT now(),
    "outcome" text NOT NULL,
    CONSTRAINT "pk_payment_cancellation_requests" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "merchant_replica" (
    "merchant_id" text NOT NULL,
    "status" text NOT NULL,
    "occurred_at" timestamptz NOT NULL,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "legal_name" text,
    CONSTRAINT "pk_merchant_replica" PRIMARY KEY ("merchant_id")
);

CREATE TABLE IF NOT EXISTS "fee_schedule_replica" (
    "merchant_id" text NOT NULL,
    "version" integer NOT NULL,
    "currency" text NOT NULL,
    "channels" jsonb NOT NULL,
    "effective_from" timestamptz NOT NULL,
    "effective_to" timestamptz,
    "published_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_fee_schedule_replica" PRIMARY KEY ("merchant_id", "version")
);

CREATE TABLE IF NOT EXISTS "intent_contradictions" (
    "id" bigserial NOT NULL,
    "payment_intent_id" text NOT NULL,
    "current_status" text NOT NULL,
    "incoming_status" text NOT NULL,
    "source_event_id" text NOT NULL,
    "kind" text NOT NULL DEFAULT 'status_conflict',
    "reason" text NOT NULL DEFAULT '',
    "detected_at" timestamptz NOT NULL DEFAULT now(),
    "resolved_at" timestamptz,
    CONSTRAINT "pk_intent_contradictions" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wallet_authorizations_used" (
    "authorization_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "payment_intent_id" text NOT NULL,
    "used_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_wallet_authorizations_used" PRIMARY KEY ("authorization_id")
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
-- SALUD v4.0.10 · módulo 74 · schema pay_payments
-- Generado de diagram_74_pay_payments.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "refunds"
        ADD CONSTRAINT "fk_refunds_payment_intent_id" FOREIGN KEY ("payment_intent_id")
        REFERENCES "payment_intents" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "disputes"
        ADD CONSTRAINT "fk_disputes_payment_intent_id" FOREIGN KEY ("payment_intent_id")
        REFERENCES "payment_intents" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "payment_cancellation_requests"
        ADD CONSTRAINT "fk_payment_cancellation_requests_payment_intent_id" FOREIGN KEY ("payment_intent_id")
        REFERENCES "payment_intents" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 74 · schema pay_payments
-- Generado de diagram_74_pay_payments.puml — NO editar a mano.


CREATE INDEX IF NOT EXISTS "payment_intents_merchant_created_idx" ON "payment_intents" ("merchant_id", "mode", "created_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "payment_intents_merchant_status_idx" ON "payment_intents" ("merchant_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "payment_intents_mandate_period_uidx" ON "payment_intents" ((source ->> 'id'), (source ->> 'period')) WHERE source IS NOT NULL;

CREATE INDEX IF NOT EXISTS "payment_intents_charge_idx" ON "payment_intents" ("charge_id") WHERE charge_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS "refunds_intent_idx" ON "refunds" ("payment_intent_id");

CREATE INDEX IF NOT EXISTS "refunds_merchant_created_idx" ON "refunds" ("merchant_id", "mode", "created_at" DESC, "id" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "disputes_one_open_per_intent_uidx" ON "disputes" ("payment_intent_id") WHERE status = 'open';

CREATE INDEX IF NOT EXISTS "fee_schedule_replica_effective_idx" ON "fee_schedule_replica" ("merchant_id", "effective_from" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "intent_contradictions_event_uidx" ON "intent_contradictions" ("payment_intent_id", "source_event_id");

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_seq_key" ON "outbox_events" ("seq");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx" ON "outbox_events" ("seq") WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 74 · base pay_payments
-- Generado de diagram_74_pay_payments.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_mode_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_mode_chk" CHECK (mode IN ('test', 'live'));

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_amount_positive_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_amount_positive_chk" CHECK (amount_minor > 0);

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_fee_net_sum_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_fee_net_sum_chk" CHECK (fee_minor >= 0 AND net_minor >= 0 AND fee_minor + net_minor = amount_minor);

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_method_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_method_chk" CHECK (method IN ('qr', 'card', 'bank_transfer', 'wallet'));

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_status_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_status_chk" CHECK (status IN ('requires_action', 'processing', 'succeeded', 'failed', 'canceled', 'expired'));

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_charge_status_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_charge_status_chk" CHECK (charge_status IN ('pending', 'authorized', 'captured', 'settled', 'failed', 'canceled', 'expired'));

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_card_token_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_card_token_chk" CHECK (card_token IS NULL OR card_token ~ '^tok_[a-z0-9]{10,60}$');

ALTER TABLE "payment_intents" DROP CONSTRAINT IF EXISTS "payment_intents_terminal_completed_chk";
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_terminal_completed_chk" CHECK ((status IN ('succeeded', 'failed', 'canceled', 'expired')) = (completed_at IS NOT NULL));

ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_mode_chk";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_mode_chk" CHECK (mode IN ('test', 'live'));

ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_amount_positive_chk";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive_chk" CHECK (amount_minor > 0);

ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_status_chk";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_chk" CHECK (status IN ('pending', 'succeeded', 'failed'));

ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_mode_chk";
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_mode_chk" CHECK (mode IN ('test', 'live'));

ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_amount_positive_chk";
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_amount_positive_chk" CHECK (amount_minor > 0);

ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_status_chk";
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_status_chk" CHECK (status IN ('open', 'won', 'lost'));

ALTER TABLE "merchant_replica" DROP CONSTRAINT IF EXISTS "merchant_replica_status_chk";
ALTER TABLE "merchant_replica" ADD CONSTRAINT "merchant_replica_status_chk" CHECK (status IN ('pending', 'active', 'suspended', 'closed'));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));
