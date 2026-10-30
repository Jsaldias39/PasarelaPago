-- SALUD v4.0.10 · perfil pay · base pay_ledger · DDL completo en orden (generado de diagram_72_pay_ledger.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 72 · schema pay_ledger
-- Generado de diagram_72_pay_ledger.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "ledger_accounts" (
    "mode" text NOT NULL,
    "account" text NOT NULL,
    "kind" text NOT NULL,
    "tb_id" char(32) NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_ledger_accounts" PRIMARY KEY ("mode", "account")
);

CREATE TABLE IF NOT EXISTS "ledger_transactions" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "business_ref" text NOT NULL,
    "attempt" integer NOT NULL,
    "content_hash" char(64) NOT NULL,
    "status" text NOT NULL,
    "reject_code" text,
    "currency" char(3) NOT NULL,
    "legs" jsonb NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_ledger_transactions" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ledger_legs" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "source" text NOT NULL,
    "source_id" text NOT NULL,
    "business_ref" text NOT NULL,
    "attempt" integer NOT NULL,
    "leg_index" integer NOT NULL,
    "debit_account" text NOT NULL,
    "credit_account" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "code" text NOT NULL,
    "posted_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_ledger_legs" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ledger_statement_lines" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "account" text NOT NULL,
    "leg_id" text NOT NULL,
    "business_ref" text NOT NULL,
    "attempt" integer NOT NULL,
    "leg_index" integer NOT NULL,
    "direction" text NOT NULL,
    "counterparty_account" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "code" text NOT NULL,
    "posted_at" timestamptz NOT NULL,
    CONSTRAINT "pk_ledger_statement_lines" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ledger_holds" (
    "id" text NOT NULL,
    "mode" text NOT NULL,
    "business_ref" text NOT NULL,
    "attempt" integer NOT NULL,
    "content_hash" char(64) NOT NULL,
    "status" text NOT NULL,
    "reject_code" text,
    "debit_account" text NOT NULL,
    "credit_account" text NOT NULL,
    "amount_minor" bigint NOT NULL,
    "posted_amount_minor" bigint,
    "currency" char(3) NOT NULL,
    "void_reason" text,
    "expires_at" timestamptz NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "resolved_at" timestamptz,
    CONSTRAINT "pk_ledger_holds" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ledger_rejections" (
    "id" bigserial NOT NULL,
    "mode" text NOT NULL,
    "kind" text NOT NULL,
    "business_ref" text NOT NULL,
    "attempt" integer NOT NULL,
    "reject_code" text NOT NULL,
    "tb_status" text NOT NULL,
    "caller" text NOT NULL,
    "rejected_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_ledger_rejections" PRIMARY KEY ("id")
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
-- SALUD v4.0.10 · módulo 72 · schema pay_ledger
-- Generado de diagram_72_pay_ledger.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "ledger_statement_lines"
        ADD CONSTRAINT "fk_ledger_statement_lines_leg_id" FOREIGN KEY ("leg_id")
        REFERENCES "ledger_legs" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 72 · schema pay_ledger
-- Generado de diagram_72_pay_ledger.puml — NO editar a mano.


CREATE UNIQUE INDEX IF NOT EXISTS "ledger_accounts_tb_id_unique" ON "ledger_accounts" ("tb_id");

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_transactions_ref_attempt_key" ON "ledger_transactions" ("mode", "business_ref", "attempt");

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_legs_source_index_key" ON "ledger_legs" ("source_id", "leg_index");

CREATE INDEX IF NOT EXISTS "ledger_legs_business_ref_idx" ON "ledger_legs" ("mode", "business_ref", "attempt");

CREATE INDEX IF NOT EXISTS "ledger_statement_lines_account_page_idx" ON "ledger_statement_lines" ("mode", "account", "posted_at" DESC, "id" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_holds_ref_attempt_key" ON "ledger_holds" ("mode", "business_ref", "attempt");

CREATE INDEX IF NOT EXISTS "ledger_holds_pending_expiry_idx" ON "ledger_holds" ("expires_at") WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_rejections_ref_attempt_kind_key" ON "ledger_rejections" ("mode", "kind", "business_ref", "attempt");

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_seq_key" ON "outbox_events" ("seq");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx" ON "outbox_events" ("seq") WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 72 · base pay_ledger
-- Generado de diagram_72_pay_ledger.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

ALTER TABLE "ledger_accounts" DROP CONSTRAINT IF EXISTS "ledger_accounts_mode_check";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "ledger_accounts" DROP CONSTRAINT IF EXISTS "ledger_accounts_kind_check";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_kind_check" CHECK (kind IN ('merchant_pending', 'merchant_available', 'merchant_debt', 'user_wallet', 'platform_fees', 'connector_clearing', 'payout_clearing', 'schedule_reserve'));

ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "ledger_transactions_mode_check";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "ledger_transactions_attempt_check";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_attempt_check" CHECK (attempt >= 1);

ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "ledger_transactions_status_check";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_status_check" CHECK (status IN ('posted', 'rejected'));

ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "ledger_transactions_reject_code_check";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reject_code_check" CHECK (reject_code IN ('insufficient_funds', 'validation_failed'));

ALTER TABLE "ledger_transactions" DROP CONSTRAINT IF EXISTS "ledger_transactions_reject_consistency";
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_reject_consistency" CHECK ((status = 'rejected') = (reject_code IS NOT NULL));

ALTER TABLE "ledger_legs" DROP CONSTRAINT IF EXISTS "ledger_legs_mode_check";
ALTER TABLE "ledger_legs" ADD CONSTRAINT "ledger_legs_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "ledger_legs" DROP CONSTRAINT IF EXISTS "ledger_legs_source_check";
ALTER TABLE "ledger_legs" ADD CONSTRAINT "ledger_legs_source_check" CHECK (source IN ('transaction', 'hold'));

ALTER TABLE "ledger_legs" DROP CONSTRAINT IF EXISTS "ledger_legs_leg_index_check";
ALTER TABLE "ledger_legs" ADD CONSTRAINT "ledger_legs_leg_index_check" CHECK (leg_index >= 0);

ALTER TABLE "ledger_legs" DROP CONSTRAINT IF EXISTS "ledger_legs_amount_minor_check";
ALTER TABLE "ledger_legs" ADD CONSTRAINT "ledger_legs_amount_minor_check" CHECK (amount_minor > 0);

ALTER TABLE "ledger_statement_lines" DROP CONSTRAINT IF EXISTS "ledger_statement_lines_mode_check";
ALTER TABLE "ledger_statement_lines" ADD CONSTRAINT "ledger_statement_lines_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "ledger_statement_lines" DROP CONSTRAINT IF EXISTS "ledger_statement_lines_direction_check";
ALTER TABLE "ledger_statement_lines" ADD CONSTRAINT "ledger_statement_lines_direction_check" CHECK (direction IN ('debit', 'credit'));

ALTER TABLE "ledger_statement_lines" DROP CONSTRAINT IF EXISTS "ledger_statement_lines_amount_minor_check";
ALTER TABLE "ledger_statement_lines" ADD CONSTRAINT "ledger_statement_lines_amount_minor_check" CHECK (amount_minor > 0);

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_mode_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_attempt_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_attempt_check" CHECK (attempt >= 1);

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_status_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_status_check" CHECK (status IN ('pending', 'posted', 'voided', 'expired', 'rejected'));

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_reject_code_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_reject_code_check" CHECK (reject_code IN ('insufficient_funds', 'validation_failed'));

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_amount_minor_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_amount_minor_check" CHECK (amount_minor > 0);

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_posted_amount_minor_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_posted_amount_minor_check" CHECK (posted_amount_minor >= 0);

ALTER TABLE "ledger_holds" DROP CONSTRAINT IF EXISTS "ledger_holds_void_reason_check";
ALTER TABLE "ledger_holds" ADD CONSTRAINT "ledger_holds_void_reason_check" CHECK (void_reason IN ('requested', 'downstream_failed'));

ALTER TABLE "ledger_rejections" DROP CONSTRAINT IF EXISTS "ledger_rejections_mode_check";
ALTER TABLE "ledger_rejections" ADD CONSTRAINT "ledger_rejections_mode_check" CHECK (mode IN ('test', 'live'));

ALTER TABLE "ledger_rejections" DROP CONSTRAINT IF EXISTS "ledger_rejections_kind_check";
ALTER TABLE "ledger_rejections" ADD CONSTRAINT "ledger_rejections_kind_check" CHECK (kind IN ('transaction', 'hold'));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));

DO $$ BEGIN
    ALTER TABLE "ledger_legs"
        ADD CONSTRAINT "ledger_legs_debit_account_fkey" FOREIGN KEY ("mode", "debit_account")
        REFERENCES "ledger_accounts" ("mode", "account");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ledger_legs"
        ADD CONSTRAINT "ledger_legs_credit_account_fkey" FOREIGN KEY ("mode", "credit_account")
        REFERENCES "ledger_accounts" ("mode", "account");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Las dos cuentas de una retención deben existir en ledger_accounts, como las de una pata (revisión de seguridad 2026-10-28). Compatible con el
-- servicio: hold.service.ts#createHold llama a AccountRegistry.register(client, mode, [debit, credit]) DENTRO de la misma transacción y ANTES de
-- cualquiera de los dos INSERT INTO ledger_holds (el aceptado y el rechazado); ningún otro código escribe en ledger_holds.
DO $$ BEGIN
    ALTER TABLE "ledger_holds"
        ADD CONSTRAINT "ledger_holds_debit_account_fkey" FOREIGN KEY ("mode", "debit_account")
        REFERENCES "ledger_accounts" ("mode", "account");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ledger_holds"
        ADD CONSTRAINT "ledger_holds_credit_account_fkey" FOREIGN KEY ("mode", "credit_account")
        REFERENCES "ledger_accounts" ("mode", "account");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ledger_statement_lines"
        ADD CONSTRAINT "ledger_statement_lines_account_fkey" FOREIGN KEY ("mode", "account")
        REFERENCES "ledger_accounts" ("mode", "account");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Registros de SOLO-AGREGAR del libro mayor (CLAUDE.md reglas 5 y 11: los errores se corrigen con asientos inversos, nunca con UPDATE ni DELETE). Hasta ahora lo
-- cumplía el código y NO la base: `UPDATE ledger_legs SET amount_minor = …` a mano pasaba. Evidencia de que el servicio solo hace INSERT (grep en services/*/src, test/ y e2e/):
-- ledger_transactions ledger.service.ts#INSERT; ledger_legs ledger.service.ts#INSERT; ledger_statement_lines ledger.service.ts#INSERT; ledger_rejections ledger.service.ts y
-- hold.service.ts#INSERT; ninguna sentencia UPDATE/DELETE/TRUNCATE ni INSERT … ON CONFLICT DO UPDATE sobre ellas. NO se guarda `ledger_holds` (máquina de estados:
-- pending -> posted/voided/expired) ni `ledger_accounts`. UPDATE/DELETE por fila y TRUNCATE por sentencia (que no pasa por los triggers de fila); DROP SCHEMA/DROP TABLE de las
-- bases descartables de prueba no se ven afectados. Mismo SQLSTATE (23000) y mensaje que forbid_mutation() de pay_merchants/pay_risk/pay_connectors.
DROP TRIGGER IF EXISTS "ledger_transactions_immutable" ON "ledger_transactions";
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_transactions_no_truncate" ON "ledger_transactions";
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_legs_immutable" ON "ledger_legs";
CREATE TRIGGER ledger_legs_immutable BEFORE UPDATE OR DELETE ON ledger_legs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_legs_no_truncate" ON "ledger_legs";
CREATE TRIGGER ledger_legs_no_truncate BEFORE TRUNCATE ON ledger_legs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_statement_lines_immutable" ON "ledger_statement_lines";
CREATE TRIGGER ledger_statement_lines_immutable BEFORE UPDATE OR DELETE ON ledger_statement_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_statement_lines_no_truncate" ON "ledger_statement_lines";
CREATE TRIGGER ledger_statement_lines_no_truncate BEFORE TRUNCATE ON ledger_statement_lines FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_rejections_immutable" ON "ledger_rejections";
CREATE TRIGGER ledger_rejections_immutable BEFORE UPDATE OR DELETE ON ledger_rejections FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "ledger_rejections_no_truncate" ON "ledger_rejections";
CREATE TRIGGER ledger_rejections_no_truncate BEFORE TRUNCATE ON ledger_rejections FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
