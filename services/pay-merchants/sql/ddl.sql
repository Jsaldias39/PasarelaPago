-- SALUD v4.0.10 · perfil pay · base pay_merchants · DDL completo en orden (generado de diagram_73_pay_merchants.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 73 · schema pay_merchants
-- Generado de diagram_73_pay_merchants.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "merchants" (
    "id" text NOT NULL,
    "display_name" text NOT NULL,
    "legal_name" text NOT NULL,
    "legal_type" text NOT NULL,
    "tax_id" text NOT NULL,
    "directory_tenant_ref" text,
    "status" text NOT NULL DEFAULT 'pending',
    "suspension_reason" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "activated_at" timestamptz,
    "suspended_at" timestamptz,
    "closed_at" timestamptz,
    CONSTRAINT "pk_merchants" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "merchant_kyc" (
    "merchant_id" text NOT NULL,
    "status" text NOT NULL DEFAULT 'pending',
    "risk_level" text,
    "reviewed_by" text,
    "reviewed_at" timestamptz,
    "review_note" text,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_merchant_kyc" PRIMARY KEY ("merchant_id")
);

CREATE TABLE IF NOT EXISTS "kyc_documents" (
    "id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "kind" text NOT NULL,
    "object_key" text NOT NULL,
    "sha256" text NOT NULL,
    "size_bytes" integer NOT NULL,
    "detected_type" text NOT NULL,
    "uploaded_by" text NOT NULL,
    "uploaded_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_kyc_documents" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "contract_versions" (
    "version" integer NOT NULL,
    "text_sha256" text NOT NULL,
    "effective_from" timestamptz NOT NULL,
    "published_by" text NOT NULL,
    "published_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_contract_versions" PRIMARY KEY ("version")
);

CREATE TABLE IF NOT EXISTS "contract_acceptances" (
    "id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "version" integer NOT NULL,
    "text_sha256" text NOT NULL,
    "accepted_by_ref" text NOT NULL,
    "recorded_by" text NOT NULL,
    "accepted_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_contract_acceptances" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "fee_schedule_versions" (
    "merchant_id" text NOT NULL,
    "version" integer NOT NULL,
    "currency" text NOT NULL DEFAULT 'BOB',
    "effective_from" timestamptz NOT NULL,
    "monthly_fee_minor" bigint NOT NULL DEFAULT 0,
    "published_by" text NOT NULL,
    "published_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_fee_schedule_versions" PRIMARY KEY ("merchant_id", "version")
);

CREATE TABLE IF NOT EXISTS "fee_schedule_channels" (
    "merchant_id" text NOT NULL,
    "version" integer NOT NULL,
    "channel" text NOT NULL,
    "percent" text NOT NULL,
    "fixed_minor" bigint NOT NULL DEFAULT 0,
    "min_minor" bigint,
    "cap_minor" bigint,
    CONSTRAINT "pk_fee_schedule_channels" PRIMARY KEY ("merchant_id", "version", "channel")
);

CREATE TABLE IF NOT EXISTS "api_keys" (
    "key_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "mode" text NOT NULL,
    "label" text,
    "last4" text NOT NULL,
    "key_hash" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "grace_ends_at" timestamptz,
    "revoked_at" timestamptz,
    "revoke_reason" text,
    CONSTRAINT "pk_api_keys" PRIMARY KEY ("key_id")
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
-- SALUD v4.0.10 · módulo 73 · schema pay_merchants
-- Generado de diagram_73_pay_merchants.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "merchant_kyc"
        ADD CONSTRAINT "fk_merchant_kyc_merchant_id" FOREIGN KEY ("merchant_id")
        REFERENCES "merchants" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "kyc_documents"
        ADD CONSTRAINT "fk_kyc_documents_merchant_id" FOREIGN KEY ("merchant_id")
        REFERENCES "merchants" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "contract_acceptances"
        ADD CONSTRAINT "fk_contract_acceptances_merchant_id" FOREIGN KEY ("merchant_id")
        REFERENCES "merchants" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "contract_acceptances"
        ADD CONSTRAINT "fk_contract_acceptances_version" FOREIGN KEY ("version")
        REFERENCES "contract_versions" ("version");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "fee_schedule_versions"
        ADD CONSTRAINT "fk_fee_schedule_versions_merchant_id" FOREIGN KEY ("merchant_id")
        REFERENCES "merchants" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "api_keys"
        ADD CONSTRAINT "fk_api_keys_merchant_id" FOREIGN KEY ("merchant_id")
        REFERENCES "merchants" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 73 · schema pay_merchants
-- Generado de diagram_73_pay_merchants.puml — NO editar a mano.


CREATE UNIQUE INDEX IF NOT EXISTS "merchants_tax_id_open_uq" ON "merchants" ("tax_id") WHERE status <> 'closed';

CREATE INDEX IF NOT EXISTS "kyc_documents_merchant_kind_idx" ON "kyc_documents" ("merchant_id", "kind", "uploaded_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "contract_acceptances_merchant_version_uq" ON "contract_acceptances" ("merchant_id", "version");

CREATE INDEX IF NOT EXISTS "api_keys_merchant_created_idx" ON "api_keys" ("merchant_id", "created_at" DESC, "key_id" DESC);

CREATE INDEX IF NOT EXISTS "api_keys_grace_pending_idx" ON "api_keys" ("grace_ends_at") WHERE revoked_at IS NULL AND grace_ends_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "outbox_events_seq_key" ON "outbox_events" ("seq");

CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx" ON "outbox_events" ("seq") WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 73 · base pay_merchants
-- Generado de diagram_73_pay_merchants.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

-- Inmutabilidad: lo aceptado y lo publicado no se edita ni se borra, ni siquiera con acceso a la base de la aplicación.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

ALTER TABLE "merchants" DROP CONSTRAINT IF EXISTS "merchants_id_format";
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_id_format" CHECK (id ~ '^mc_[a-z0-9]{10,40}$');

ALTER TABLE "merchants" DROP CONSTRAINT IF EXISTS "merchants_display_name_len";
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_display_name_len" CHECK (length(display_name) BETWEEN 1 AND 200);

ALTER TABLE "merchants" DROP CONSTRAINT IF EXISTS "merchants_legal_type_valid";
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_legal_type_valid" CHECK (legal_type IN ('unipersonal', 'srl', 'ltda', 'sa', 'sociedad_colectiva', 'sociedad_comandita_simple', 'sociedad_comandita_acciones', 'sucursal_sociedad_extranjera'));

ALTER TABLE "merchants" DROP CONSTRAINT IF EXISTS "merchants_status_valid";
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_status_valid" CHECK (status IN ('pending', 'active', 'suspended', 'closed'));

ALTER TABLE "merchants" DROP CONSTRAINT IF EXISTS "merchants_suspension_reason_valid";
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_suspension_reason_valid" CHECK (suspension_reason IS NULL OR suspension_reason IN ('kyc_expired', 'risk_review', 'contract_breach', 'manual'));

ALTER TABLE "merchant_kyc" DROP CONSTRAINT IF EXISTS "merchant_kyc_status_valid";
ALTER TABLE "merchant_kyc" ADD CONSTRAINT "merchant_kyc_status_valid" CHECK (status IN ('pending', 'in_review', 'approved', 'rejected'));

ALTER TABLE "merchant_kyc" DROP CONSTRAINT IF EXISTS "merchant_kyc_risk_valid";
ALTER TABLE "merchant_kyc" ADD CONSTRAINT "merchant_kyc_risk_valid" CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high'));

ALTER TABLE "merchant_kyc" DROP CONSTRAINT IF EXISTS "merchant_kyc_approved_has_risk";
ALTER TABLE "merchant_kyc" ADD CONSTRAINT "merchant_kyc_approved_has_risk" CHECK (status <> 'approved' OR risk_level IS NOT NULL);

ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_kind_valid";
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_kind_valid" CHECK (kind IN ('constitucion', 'nit', 'seprec', 'licencia_funcionamiento', 'certificado_sedes', 'poder_representante'));

ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_type_valid";
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_type_valid" CHECK (detected_type IN ('application/pdf', 'image/png', 'image/jpeg'));

ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_sha256_format";
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_sha256_format" CHECK (sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE "kyc_documents" DROP CONSTRAINT IF EXISTS "kyc_documents_size_positive";
ALTER TABLE "kyc_documents" ADD CONSTRAINT "kyc_documents_size_positive" CHECK (size_bytes > 0);

ALTER TABLE "contract_versions" DROP CONSTRAINT IF EXISTS "contract_versions_version_positive";
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_version_positive" CHECK (version >= 1);

ALTER TABLE "contract_versions" DROP CONSTRAINT IF EXISTS "contract_versions_sha256_format";
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_sha256_format" CHECK (text_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE "fee_schedule_versions" DROP CONSTRAINT IF EXISTS "fee_schedule_versions_currency_bob";
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_currency_bob" CHECK (currency = 'BOB');

ALTER TABLE "fee_schedule_versions" DROP CONSTRAINT IF EXISTS "fee_schedule_versions_monthly_nonneg";
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_monthly_nonneg" CHECK (monthly_fee_minor >= 0);

ALTER TABLE "fee_schedule_channels" DROP CONSTRAINT IF EXISTS "fee_schedule_channels_channel_valid";
ALTER TABLE "fee_schedule_channels" ADD CONSTRAINT "fee_schedule_channels_channel_valid" CHECK (channel IN ('qr', 'card', 'bank_transfer', 'wallet', 'direct'));

ALTER TABLE "fee_schedule_channels" DROP CONSTRAINT IF EXISTS "fee_schedule_channels_percent_format";
ALTER TABLE "fee_schedule_channels" ADD CONSTRAINT "fee_schedule_channels_percent_format" CHECK (percent ~ '^\d{1,3}(\.\d{1,6})?$');

ALTER TABLE "fee_schedule_channels" DROP CONSTRAINT IF EXISTS "fee_schedule_channels_amounts_nonneg";
ALTER TABLE "fee_schedule_channels" ADD CONSTRAINT "fee_schedule_channels_amounts_nonneg" CHECK (fixed_minor >= 0 AND (min_minor IS NULL OR min_minor >= 0) AND (cap_minor IS NULL OR cap_minor >= 0));

ALTER TABLE "fee_schedule_channels" DROP CONSTRAINT IF EXISTS "fee_schedule_channels_min_le_cap";
ALTER TABLE "fee_schedule_channels" ADD CONSTRAINT "fee_schedule_channels_min_le_cap" CHECK (min_minor IS NULL OR cap_minor IS NULL OR min_minor <= cap_minor);

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_mode_valid";
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_mode_valid" CHECK (mode IN ('test', 'live'));

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_hash_format";
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_hash_format" CHECK (key_hash ~ '^sha256\$[0-9a-f]{64}$');

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_reason_valid";
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_reason_valid" CHECK (revoke_reason IS NULL OR revoke_reason IN ('revoked_by_merchant', 'rotated', 'compromised', 'merchant_closed'));

ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_revoked_has_reason";
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_has_reason" CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));

DO $$ BEGIN
    ALTER TABLE "fee_schedule_channels"
        ADD CONSTRAINT "fee_schedule_channels_version_fk" FOREIGN KEY ("merchant_id", "version")
        REFERENCES "fee_schedule_versions" ("merchant_id", "version");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP TRIGGER IF EXISTS "contract_versions_immutable" ON "contract_versions";
CREATE TRIGGER contract_versions_immutable BEFORE UPDATE OR DELETE ON contract_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "contract_acceptances_immutable" ON "contract_acceptances";
CREATE TRIGGER contract_acceptances_immutable BEFORE UPDATE OR DELETE ON contract_acceptances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "fee_schedule_versions_immutable" ON "fee_schedule_versions";
CREATE TRIGGER fee_schedule_versions_immutable BEFORE UPDATE OR DELETE ON fee_schedule_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "fee_schedule_channels_immutable" ON "fee_schedule_channels";
CREATE TRIGGER fee_schedule_channels_immutable BEFORE UPDATE OR DELETE ON fee_schedule_channels FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- TRUNCATE: no pasa por los triggers de fila, así que cada tabla inmutable necesita el suyo (revisión de seguridad 2026-10-28: faltaba en
-- contract_versions y fee_schedule_channels; el SQL de referencia solo lo tenía en contract_acceptances y fee_schedule_versions).
DROP TRIGGER IF EXISTS "contract_versions_no_truncate" ON "contract_versions";
CREATE TRIGGER contract_versions_no_truncate BEFORE TRUNCATE ON contract_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "contract_acceptances_no_truncate" ON "contract_acceptances";
CREATE TRIGGER contract_acceptances_no_truncate BEFORE TRUNCATE ON contract_acceptances FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "fee_schedule_versions_no_truncate" ON "fee_schedule_versions";
CREATE TRIGGER fee_schedule_versions_no_truncate BEFORE TRUNCATE ON fee_schedule_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "fee_schedule_channels_no_truncate" ON "fee_schedule_channels";
CREATE TRIGGER fee_schedule_channels_no_truncate BEFORE TRUNCATE ON fee_schedule_channels FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
