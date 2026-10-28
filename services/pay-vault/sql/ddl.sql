-- SALUD v4.0.10 · perfil pay · base pay_vault · DDL completo en orden (generado de diagram_79_pay_vault.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 79 · schema pay_vault
-- Generado de diagram_79_pay_vault.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "capture_sessions" (
    "id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "payment_intent_id" text,
    "save_card" boolean NOT NULL DEFAULT false,
    "status" text NOT NULL DEFAULT 'open',
    "capture_url" text NOT NULL,
    "token" text,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "completed_at" timestamptz,
    CONSTRAINT "pk_capture_sessions" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "card_tokens" (
    "token" text NOT NULL,
    "merchant_id" text NOT NULL,
    "brand" text NOT NULL,
    "last4" text NOT NULL,
    "exp_month" smallint NOT NULL,
    "exp_year" smallint NOT NULL,
    "fingerprint" text NOT NULL,
    "single_use" boolean NOT NULL,
    "bound_charge_id" text,
    "deleted_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_card_tokens" PRIMARY KEY ("token")
);

CREATE TABLE IF NOT EXISTS "reveal_audit" (
    "id" bigserial NOT NULL,
    "token" text NOT NULL,
    "merchant_id" text NOT NULL,
    "charge_id" text NOT NULL,
    "caller" text NOT NULL,
    "outcome" text NOT NULL,
    "idempotency_key" text,
    "at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_reveal_audit" PRIMARY KEY ("id")
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
-- SALUD v4.0.10 · módulo 79 · schema pay_vault
-- Generado de diagram_79_pay_vault.puml — NO editar a mano.


-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 79 · schema pay_vault
-- Generado de diagram_79_pay_vault.puml — NO editar a mano.


CREATE INDEX IF NOT EXISTS "capture_sessions_merchant_idx" ON "capture_sessions" ("merchant_id", "created_at");

CREATE INDEX IF NOT EXISTS "card_tokens_merchant_idx" ON "card_tokens" ("merchant_id", "created_at");

CREATE INDEX IF NOT EXISTS "reveal_audit_token_idx" ON "reveal_audit" ("token", "at");

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 79 · base pay_vault
-- Generado de diagram_79_pay_vault.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

ALTER TABLE "capture_sessions" DROP CONSTRAINT IF EXISTS "capture_sessions_status_chk";
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_status_chk" CHECK (status IN ('open', 'completed', 'expired', 'canceled'));

ALTER TABLE "capture_sessions" DROP CONSTRAINT IF EXISTS "capture_sessions_token_chk";
ALTER TABLE "capture_sessions" ADD CONSTRAINT "capture_sessions_token_chk" CHECK ((status = 'completed') = (token IS NOT NULL));

ALTER TABLE "card_tokens" DROP CONSTRAINT IF EXISTS "card_tokens_brand_chk";
ALTER TABLE "card_tokens" ADD CONSTRAINT "card_tokens_brand_chk" CHECK (brand IN ('visa', 'mastercard', 'other'));

ALTER TABLE "card_tokens" DROP CONSTRAINT IF EXISTS "card_tokens_last4_chk";
ALTER TABLE "card_tokens" ADD CONSTRAINT "card_tokens_last4_chk" CHECK (last4 ~ '^[0-9]{4}$');

ALTER TABLE "card_tokens" DROP CONSTRAINT IF EXISTS "card_tokens_exp_chk";
ALTER TABLE "card_tokens" ADD CONSTRAINT "card_tokens_exp_chk" CHECK (exp_month BETWEEN 1 AND 12 AND exp_year BETWEEN 2026 AND 2100);

ALTER TABLE "reveal_audit" DROP CONSTRAINT IF EXISTS "reveal_audit_outcome_chk";
ALTER TABLE "reveal_audit" ADD CONSTRAINT "reveal_audit_outcome_chk" CHECK (outcome IN ('granted', 'denied_not_found', 'denied_bound_to_other_charge', 'backend_error'));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));
