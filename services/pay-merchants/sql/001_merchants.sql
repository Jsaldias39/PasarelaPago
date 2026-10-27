-- SQL DE REFERENCIA de pay-merchants (P5.H1.M1). El modelo (D-18) todavía no existe: este archivo se mueve a
-- mantra-core-health-model cuando exista el pipeline `.puml → SQL/ → base → ORM`. Tomado de las entidades del módulo 42
-- de la API (connected_accounts, kyc_verifications, fee_schedules), reducido a lo que esta pasarela necesita.
-- Las tablas técnicas (outbox_events, inbox_events, idempotency_keys) vienen de contracts/packages/{outbox,idempotency}/sql.

CREATE TABLE merchants (
  id                    text        NOT NULL,
  display_name          text        NOT NULL,
  legal_name            text        NOT NULL,   -- punto 1 del alta legal: razón social
  legal_type            text        NOT NULL,   -- punto 1.1: tipo societario (lista cerrada del registro del stakeholder)
  tax_id                text        NOT NULL,   -- punto 2: NIT
  directory_tenant_ref  text,                   -- referencia opaca al alta legal en `directory` (Q-22); sin copiar sus datos
  status                text        NOT NULL DEFAULT 'pending',
  suspension_reason     text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  suspended_at          timestamptz,
  closed_at             timestamptz,
  CONSTRAINT merchants_pkey PRIMARY KEY (id),
  CONSTRAINT merchants_id_format CHECK (id ~ '^mc_[a-z0-9]{10,40}$'),
  CONSTRAINT merchants_display_name_len CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT merchants_legal_type_valid CHECK (legal_type IN
    ('unipersonal', 'srl', 'ltda', 'sa', 'sociedad_colectiva', 'sociedad_comandita_simple', 'sociedad_comandita_acciones', 'sucursal_sociedad_extranjera')),
  CONSTRAINT merchants_status_valid CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
  CONSTRAINT merchants_suspension_reason_valid CHECK (suspension_reason IS NULL OR suspension_reason IN ('kyc_expired', 'risk_review', 'contract_breach', 'manual'))
);
-- Un NIT, un comercio abierto (supuesto, ver DECISIONES-TOMADAS D5-04).
CREATE UNIQUE INDEX merchants_tax_id_open_uq ON merchants (tax_id) WHERE status <> 'closed';

CREATE TABLE merchant_kyc (
  merchant_id  text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  risk_level   text,
  reviewed_by  text,                 -- `sub` de la credencial del operador, nunca del cuerpo
  reviewed_at  timestamptz,
  review_note  text,                 -- sin datos personales
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_kyc_pkey PRIMARY KEY (merchant_id),
  CONSTRAINT merchant_kyc_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants (id),
  CONSTRAINT merchant_kyc_status_valid CHECK (status IN ('pending', 'in_review', 'approved', 'rejected')),
  CONSTRAINT merchant_kyc_risk_valid CHECK (risk_level IS NULL OR risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT merchant_kyc_approved_has_risk CHECK (status <> 'approved' OR risk_level IS NOT NULL)
);

CREATE TABLE kyc_documents (
  id             text        NOT NULL,
  merchant_id    text        NOT NULL,
  kind           text        NOT NULL,
  object_key     text        NOT NULL,   -- clave en el almacén de objetos: el archivo NO está en la base
  sha256         text        NOT NULL,
  size_bytes     integer     NOT NULL,
  detected_type  text        NOT NULL,   -- tipo REAL por magic bytes, no el que declaró el cliente
  uploaded_by    text        NOT NULL,
  uploaded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kyc_documents_pkey PRIMARY KEY (id),
  CONSTRAINT kyc_documents_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants (id),
  CONSTRAINT kyc_documents_kind_valid CHECK (kind IN ('constitucion', 'nit', 'seprec', 'licencia_funcionamiento', 'certificado_sedes', 'poder_representante')),
  CONSTRAINT kyc_documents_type_valid CHECK (detected_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  CONSTRAINT kyc_documents_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT kyc_documents_size_positive CHECK (size_bytes > 0)
);
CREATE INDEX kyc_documents_merchant_kind_idx ON kyc_documents (merchant_id, kind, uploaded_at DESC);

-- Contratos legales: versiones publicadas y aceptaciones. Ambas tablas son INMUTABLES (REQ-P5-2).
CREATE TABLE contract_versions (
  version         integer     NOT NULL,
  text_sha256     text        NOT NULL,   -- hash del texto legal; el texto lo custodia legal
  effective_from  timestamptz NOT NULL,
  published_by    text        NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_versions_pkey PRIMARY KEY (version),
  CONSTRAINT contract_versions_version_positive CHECK (version >= 1),
  CONSTRAINT contract_versions_sha256_format CHECK (text_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE TABLE contract_acceptances (
  id               text        NOT NULL,
  merchant_id      text        NOT NULL,
  version          integer     NOT NULL,
  text_sha256      text        NOT NULL,  -- copia del hash de la versión aceptada, para que la prueba no dependa de otra tabla
  accepted_by_ref  text        NOT NULL,  -- referencia opaca a quien firma (representante); lo declara el operador que la registra
  recorded_by      text        NOT NULL,  -- `sub` de la credencial del operador que la registró
  accepted_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contract_acceptances_pkey PRIMARY KEY (id),
  CONSTRAINT contract_acceptances_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants (id),
  CONSTRAINT contract_acceptances_version_fk FOREIGN KEY (version) REFERENCES contract_versions (version),
  CONSTRAINT contract_acceptances_merchant_version_uq UNIQUE (merchant_id, version)
);

-- Tarifario: una versión nueva por cada cambio, las viejas quedan intactas (REQ-P5-3). Vigente = la de mayor
-- effective_from que ya empezó; el fin de una versión es el inicio de la siguiente (no se guarda effective_to).
CREATE TABLE fee_schedule_versions (
  merchant_id        text        NOT NULL,
  version            integer     NOT NULL,
  currency           text        NOT NULL DEFAULT 'BOB',
  effective_from     timestamptz NOT NULL,
  monthly_fee_minor  bigint      NOT NULL DEFAULT 0,
  published_by       text        NOT NULL,
  published_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_schedule_versions_pkey PRIMARY KEY (merchant_id, version),
  CONSTRAINT fee_schedule_versions_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants (id),
  CONSTRAINT fee_schedule_versions_currency_bob CHECK (currency = 'BOB'),
  CONSTRAINT fee_schedule_versions_monthly_nonneg CHECK (monthly_fee_minor >= 0)
);

CREATE TABLE fee_schedule_channels (
  merchant_id  text    NOT NULL,
  version      integer NOT NULL,
  channel      text    NOT NULL,
  percent      text    NOT NULL,
  fixed_minor  bigint  NOT NULL DEFAULT 0,
  min_minor    bigint,
  cap_minor    bigint,
  CONSTRAINT fee_schedule_channels_pkey PRIMARY KEY (merchant_id, version, channel),
  CONSTRAINT fee_schedule_channels_version_fk FOREIGN KEY (merchant_id, version) REFERENCES fee_schedule_versions (merchant_id, version),
  CONSTRAINT fee_schedule_channels_channel_valid CHECK (channel IN ('qr', 'card', 'bank_transfer', 'wallet', 'direct')),
  CONSTRAINT fee_schedule_channels_percent_format CHECK (percent ~ '^\d{1,3}(\.\d{1,6})?$'),
  CONSTRAINT fee_schedule_channels_amounts_nonneg CHECK (fixed_minor >= 0 AND (min_minor IS NULL OR min_minor >= 0) AND (cap_minor IS NULL OR cap_minor >= 0)),
  CONSTRAINT fee_schedule_channels_min_le_cap CHECK (min_minor IS NULL OR cap_minor IS NULL OR min_minor <= cap_minor)
);

CREATE TABLE api_keys (
  key_id         text        NOT NULL,
  merchant_id    text        NOT NULL,
  mode           text        NOT NULL,   -- el modo con el que se opera sale SIEMPRE de acá, nunca del token
  label          text,
  last4          text        NOT NULL,
  key_hash       text        NOT NULL,   -- `sha256$<hex>`; el secreto no se guarda
  created_at     timestamptz NOT NULL DEFAULT now(),
  grace_ends_at  timestamptz,            -- si se rotó: hasta cuándo sigue valida la anterior
  revoked_at     timestamptz,
  revoke_reason  text,
  CONSTRAINT api_keys_pkey PRIMARY KEY (key_id),
  CONSTRAINT api_keys_merchant_fk FOREIGN KEY (merchant_id) REFERENCES merchants (id),
  CONSTRAINT api_keys_mode_valid CHECK (mode IN ('test', 'live')),
  CONSTRAINT api_keys_hash_format CHECK (key_hash ~ '^sha256\$[0-9a-f]{64}$'),
  CONSTRAINT api_keys_reason_valid CHECK (revoke_reason IS NULL OR revoke_reason IN ('revoked_by_merchant', 'rotated', 'compromised')),
  CONSTRAINT api_keys_revoked_has_reason CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX api_keys_merchant_created_idx ON api_keys (merchant_id, created_at DESC, key_id DESC);
CREATE INDEX api_keys_grace_pending_idx ON api_keys (grace_ends_at) WHERE revoked_at IS NULL AND grace_ends_at IS NOT NULL;

-- Inmutabilidad: lo aceptado y lo publicado no se edita ni se borra, ni siquiera con acceso a la base de la aplicación.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER contract_versions_immutable BEFORE UPDATE OR DELETE ON contract_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER contract_acceptances_immutable BEFORE UPDATE OR DELETE ON contract_acceptances FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fee_schedule_versions_immutable BEFORE UPDATE OR DELETE ON fee_schedule_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fee_schedule_channels_immutable BEFORE UPDATE OR DELETE ON fee_schedule_channels FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER contract_acceptances_no_truncate BEFORE TRUNCATE ON contract_acceptances FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER fee_schedule_versions_no_truncate BEFORE TRUNCATE ON fee_schedule_versions FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
