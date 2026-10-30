-- SALUD v4.0.10 · perfil pay · base pay_webhooks · DDL completo en orden (generado de diagram_80_pay_webhooks.puml)
-- Archivo SQL plano, apto para `pool.query(readFileSync(...))`. NO editar a mano.

-- >>> 02_tables.sql
-- SALUD v4.0.10 · módulo 80 · schema pay_webhooks
-- Generado de diagram_80_pay_webhooks.puml — NO editar a mano.


CREATE TABLE IF NOT EXISTS "webhook_endpoints" (
    "id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "url" text NOT NULL,
    "description" text,
    "enabled_events" text[] NOT NULL,
    "signature_scheme" text NOT NULL DEFAULT 'v1',
    "status" text NOT NULL DEFAULT 'enabled',
    "disabled_reason" text,
    "consecutive_failures" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "deleted_at" timestamptz,
    CONSTRAINT "pk_webhook_endpoints" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "webhook_secrets" (
    "endpoint_id" text NOT NULL,
    "version" integer NOT NULL,
    "sealed_secret" text NOT NULL,
    "public_key" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "expires_at" timestamptz,
    CONSTRAINT "pk_webhook_secrets" PRIMARY KEY ("endpoint_id", "version")
);

CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
    "id" text NOT NULL,
    "endpoint_id" text NOT NULL,
    "merchant_id" text NOT NULL,
    "event_id" text NOT NULL,
    "event_type" text NOT NULL,
    "payload" text NOT NULL,
    "status" text NOT NULL DEFAULT 'pending',
    "attempts" integer NOT NULL DEFAULT 0,
    "next_attempt_at" timestamptz NOT NULL,
    "last_status" integer,
    "last_error" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "delivered_at" timestamptz,
    CONSTRAINT "pk_webhook_deliveries" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "webhook_delivery_attempts" (
    "delivery_id" text NOT NULL,
    "attempt" integer NOT NULL,
    "attempted_at" timestamptz NOT NULL,
    "status_code" integer,
    "error_code" text,
    "duration_ms" integer NOT NULL,
    CONSTRAINT "pk_webhook_delivery_attempts" PRIMARY KEY ("delivery_id", "attempt")
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
-- SALUD v4.0.10 · módulo 80 · schema pay_webhooks
-- Generado de diagram_80_pay_webhooks.puml — NO editar a mano.


DO $$ BEGIN
    ALTER TABLE "webhook_secrets"
        ADD CONSTRAINT "fk_webhook_secrets_endpoint_id" FOREIGN KEY ("endpoint_id")
        REFERENCES "webhook_endpoints" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "webhook_deliveries"
        ADD CONSTRAINT "fk_webhook_deliveries_endpoint_id" FOREIGN KEY ("endpoint_id")
        REFERENCES "webhook_endpoints" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "webhook_delivery_attempts"
        ADD CONSTRAINT "fk_webhook_delivery_attempts_delivery_id" FOREIGN KEY ("delivery_id")
        REFERENCES "webhook_deliveries" ("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- >>> 04_indexes.sql
-- SALUD v4.0.10 · módulo 80 · schema pay_webhooks
-- Generado de diagram_80_pay_webhooks.puml — NO editar a mano.


CREATE INDEX IF NOT EXISTS "webhook_endpoints_merchant_idx" ON "webhook_endpoints" ("merchant_id", "created_at" DESC, "id" DESC) WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_event_key" ON "webhook_deliveries" ("endpoint_id", "event_id");

CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx" ON "webhook_deliveries" ("next_attempt_at") WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys" ("expires_at");

-- >>> 05_constraints.sql
-- SALUD v4.0.10 · perfil pay · módulo 80 · base pay_webhooks
-- Generado de diagram_80_pay_webhooks.puml — NO editar a mano.

-- Complementos del perfil pay (gen_ddl_pay.py): funciones, CHECK, FK compuestas y triggers.
-- Aplicar DESPUÉS de 04_indexes.sql. Idempotente.

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_id_check";
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_id_check" CHECK (id ~ '^we_[a-z0-9]{10,40}$');

ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_events_check";
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_events_check" CHECK (cardinality(enabled_events) >= 1);

ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_scheme_check";
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_scheme_check" CHECK (signature_scheme IN ('v1', 'v1a'));

ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_status_check";
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_status_check" CHECK (status IN ('enabled', 'disabled'));

ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_reason_check";
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_reason_check" CHECK (disabled_reason IS NULL OR disabled_reason IN ('gone_410', 'too_many_failures', 'manual'));

ALTER TABLE "webhook_endpoints" DROP CONSTRAINT IF EXISTS "webhook_endpoints_reason_status_check";
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_reason_status_check" CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL));

ALTER TABLE "webhook_deliveries" DROP CONSTRAINT IF EXISTS "webhook_deliveries_status_check";
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_check" CHECK (status IN ('pending', 'succeeded', 'dead'));

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_state_check";
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_state_check" CHECK (state IN ('started', 'completed'));

-- Un intento de entrega es un hecho ya ocurrido: delivery.worker.ts solo hace INSERT … ON CONFLICT DO NOTHING (el estado que cambia vive en webhook_deliveries, que SÍ se actualiza y
-- NO se guarda). No hay UPDATE/DELETE/TRUNCATE sobre esta tabla en services/*/src; las pruebas la vacían dentro de una transacción que apaga SOLO este trigger (ver test/harness.ts).
DROP TRIGGER IF EXISTS "webhook_delivery_attempts_immutable" ON "webhook_delivery_attempts";
CREATE TRIGGER webhook_delivery_attempts_immutable BEFORE UPDATE OR DELETE ON webhook_delivery_attempts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS "webhook_delivery_attempts_no_truncate" ON "webhook_delivery_attempts";
CREATE TRIGGER webhook_delivery_attempts_no_truncate BEFORE TRUNCATE ON webhook_delivery_attempts FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
