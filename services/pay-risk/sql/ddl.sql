-- SALUD v4.0.10 · perfil pay · base pay_risk · DDL completo en orden (generado de diagram_76_pay_risk.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 76 · schema pay_risk
-- Generado de diagram_76_pay_risk.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "risk_rule_sets" (
    "version" integer NOT NULL,
    "effective_from" timestamptz NOT NULL,
    "max_amount_minor" bigint,
    "merchant_daily_amount_minor" bigint,
    "payer_daily_amount_minor" bigint,
    "payer_velocity_max" integer,
    "payer_velocity_window_seconds" integer,
    "merchant_velocity_max" integer,
    "merchant_velocity_window_seconds" integer,
    "hours_from" smallint,
    "hours_to" smallint,
    "published_by" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_risk_rule_sets" PRIMARY KEY ("version")
);

CREATE TABLE IF NOT EXISTS "risk_assessments" (
    "id" text NOT NULL,
    "caller_service" text NOT NULL,
    "request_key" text NOT NULL,
    "merchant_id" text NOT NULL,
    "payment_intent_id" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "currency" text NOT NULL,
    "method" text NOT NULL,
    "payer_hash" text,
    "decision" text NOT NULL,
    "reason_code" text NOT NULL,
    "reason_codes" text[] NOT NULL,
    "rule_version" integer NOT NULL,
    "screened" boolean NOT NULL,
    "screening_top_score" numeric(8,6),
    "screening_list" text,
    "screening_source_id" text,
    "screening_party" text,
    "duration_ms" integer NOT NULL,
    "created_at" timestamptz NOT NULL,
    CONSTRAINT "pk_risk_assessments" PRIMARY KEY ("id")
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
-- SALUD v4.0.10 · módulo 76 · schema pay_risk
-- Generado de diagram_76_pay_risk.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "risk_assessments"
        ADD CONSTRAINT "fk_risk_assessments_rule_version" FOREIGN KEY ("rule_version")
        REFERENCES "risk_rule_sets" ("version");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 76 · schema pay_risk
-- Generado de diagram_76_pay_risk.puml — NO editar a mano.


CREATE UNIQUE INDEX IF NOT EXISTS "risk_assessments_request_uq" ON "risk_assessments" ("caller_service", "request_key");

CREATE INDEX IF NOT EXISTS "risk_assessments_merchant_created_idx" ON "risk_assessments" ("merchant_id", "created_at");

CREATE INDEX IF NOT EXISTS "risk_assessments_payer_created_idx" ON "risk_assessments" ("payer_hash", "created_at") WHERE payer_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS "risk_assessments_intent_idx" ON "risk_assessments" ("payment_intent_id", "created_at");

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 76 · base pay_risk
-- Generado de diagram_76_pay_risk.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

-- SQL DE REFERENCIA de pay-risk (P5.H2). El modelo (D-18) todavía no existe: este archivo se mueve a
-- mantra-core-health-model cuando exista el pipeline `.puml → SQL/ → base → ORM`.
-- Las tablas técnicas (idempotency_keys) vienen de contracts/packages/idempotency/sql.
-- Ningún dato personal: el pagador se guarda como huella (HMAC) y el nombre que se criba NO se guarda (regla 90.2).
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_version_pos";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_version_pos" CHECK (version >= 1);

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_max_amount_pos";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_max_amount_pos" CHECK (max_amount_minor IS NULL OR max_amount_minor > 0);

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_merchant_daily_pos";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_merchant_daily_pos" CHECK (merchant_daily_amount_minor IS NULL OR merchant_daily_amount_minor > 0);

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_payer_daily_pos";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_payer_daily_pos" CHECK (payer_daily_amount_minor IS NULL OR payer_daily_amount_minor > 0);

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_payer_velocity_pair";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_payer_velocity_pair" CHECK ((payer_velocity_max IS NULL) = (payer_velocity_window_seconds IS NULL));

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_payer_velocity_pos";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_payer_velocity_pos" CHECK (payer_velocity_max IS NULL OR (payer_velocity_max > 0 AND payer_velocity_window_seconds > 0));

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_merchant_velocity_pair";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_merchant_velocity_pair" CHECK ((merchant_velocity_max IS NULL) = (merchant_velocity_window_seconds IS NULL));

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_merchant_velocity_pos";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_merchant_velocity_pos" CHECK (merchant_velocity_max IS NULL OR (merchant_velocity_max > 0 AND merchant_velocity_window_seconds > 0));

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_hours_pair";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_hours_pair" CHECK ((hours_from IS NULL) = (hours_to IS NULL));

ALTER TABLE "risk_rule_sets" DROP CONSTRAINT IF EXISTS "risk_rule_sets_hours_range";
ALTER TABLE "risk_rule_sets" ADD CONSTRAINT "risk_rule_sets_hours_range" CHECK (hours_from IS NULL OR (hours_from >= 0 AND hours_to <= 24 AND hours_from < hours_to));

ALTER TABLE "risk_assessments" DROP CONSTRAINT IF EXISTS "risk_assessments_id_format";
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_id_format" CHECK (id ~ '^ra_[a-z0-9]{10,40}$');

ALTER TABLE "risk_assessments" DROP CONSTRAINT IF EXISTS "risk_assessments_decision_valid";
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_decision_valid" CHECK (decision IN ('allow', 'review', 'deny'));

ALTER TABLE "risk_assessments" DROP CONSTRAINT IF EXISTS "risk_assessments_amount_pos";
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_amount_pos" CHECK (amount_minor >= 1);

ALTER TABLE "risk_assessments" DROP CONSTRAINT IF EXISTS "risk_assessments_party_valid";
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_party_valid" CHECK (screening_party IS NULL OR screening_party IN ('merchant', 'payer'));

ALTER TABLE "risk_assessments" DROP CONSTRAINT IF EXISTS "risk_assessments_method_valid";
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_method_valid" CHECK (method IN ('qr', 'card', 'bank_transfer', 'wallet'));

-- Nunca `allow` si no se cribó (contrato: «pay-risk nunca responde allow si no pudo cribar»).
ALTER TABLE "risk_assessments" DROP CONSTRAINT IF EXISTS "risk_assessments_allow_requires_screening";
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_allow_requires_screening" CHECK (decision <> 'allow' OR screened);

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));

DROP TRIGGER IF EXISTS "risk_rule_sets_immutable" ON "risk_rule_sets";
CREATE TRIGGER risk_rule_sets_immutable BEFORE UPDATE OR DELETE ON risk_rule_sets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "risk_assessments_immutable" ON "risk_assessments";
CREATE TRIGGER risk_assessments_immutable BEFORE UPDATE OR DELETE ON risk_assessments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "risk_rule_sets_no_truncate" ON "risk_rule_sets";
CREATE TRIGGER risk_rule_sets_no_truncate BEFORE TRUNCATE ON risk_rule_sets FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "risk_assessments_no_truncate" ON "risk_assessments";
CREATE TRIGGER risk_assessments_no_truncate BEFORE TRUNCATE ON risk_assessments FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- >>> 06_seed.sql
-- SALUD v4.0.10 · perfil pay · módulo 76 · base pay_risk
-- Generado de diagram_76_pay_risk.puml — NO editar a mano.

-- Filas de configuración declaradas por el modelo (SEED_SQL). Idempotentes.

-- Versión 1 = SIN límites: es la ausencia declarada de reglas, no un número inventado. Idempotente.
INSERT INTO risk_rule_sets (version, effective_from, published_by) VALUES (1, '2000-01-01T00:00:00Z', 'system:no-limits') ON CONFLICT (version) DO NOTHING;
