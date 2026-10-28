-- SALUD v4.0.10 · perfil pay · base pay_qr · DDL completo en orden (generado de diagram_75_pay_qr.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 75 · schema pay_qr
-- Generado de diagram_75_pay_qr.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "qr_codes" (
    "id" text NOT NULL,
    "kind" text NOT NULL,
    "pay_mode" text NOT NULL,
    "merchant_id" text NOT NULL,
    "payment_intent_id" text,
    "reference" text NOT NULL,
    "amount_minor" bigint,
    "currency" text NOT NULL,
    "payload" text NOT NULL,
    "expires_at" timestamptz,
    "canceled_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_qr_codes" PRIMARY KEY ("id")
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
-- SALUD v4.0.10 · módulo 75 · schema pay_qr
-- Generado de diagram_75_pay_qr.puml — NO editar a mano.


-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 75 · schema pay_qr
-- Generado de diagram_75_pay_qr.puml — NO editar a mano.


CREATE UNIQUE INDEX IF NOT EXISTS "qr_codes_reference_uidx" ON "qr_codes" ("reference");

CREATE UNIQUE INDEX IF NOT EXISTS "qr_codes_static_per_merchant_uidx" ON "qr_codes" ("pay_mode", "merchant_id") WHERE kind = 'static' AND canceled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "qr_codes_live_per_intent_uidx" ON "qr_codes" ("pay_mode", "payment_intent_id") WHERE kind = 'dynamic' AND canceled_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 75 · base pay_qr
-- Generado de diagram_75_pay_qr.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_id_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_id_check" CHECK (id ~ '^qr_[a-z0-9]{10,40}$');

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_kind_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_kind_check" CHECK (kind IN ('static', 'dynamic'));

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_pay_mode_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_pay_mode_check" CHECK (pay_mode IN ('test', 'live'));

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_merchant_id_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_merchant_id_check" CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$');

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_payment_intent_id_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_payment_intent_id_check" CHECK (payment_intent_id IS NULL OR payment_intent_id ~ '^pi_[a-z0-9]{10,40}$');

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_reference_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_reference_check" CHECK (reference ~ '^[A-Za-z0-9]{1,25}$');

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_amount_minor_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_amount_minor_check" CHECK (amount_minor IS NULL OR amount_minor > 0);

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_currency_check";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_currency_check" CHECK (currency = 'BOB');

ALTER TABLE "qr_codes" DROP CONSTRAINT IF EXISTS "qr_codes_dynamic_fields_ck";
ALTER TABLE "qr_codes" ADD CONSTRAINT "qr_codes_dynamic_fields_ck" CHECK (kind = 'static' OR (payment_intent_id IS NOT NULL AND amount_minor IS NOT NULL AND expires_at IS NOT NULL));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));
