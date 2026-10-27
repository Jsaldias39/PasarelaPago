-- SQL DE REFERENCIA de pay-risk (P5.H2). El modelo (D-18) todavía no existe: este archivo se mueve a
-- mantra-core-health-model cuando exista el pipeline `.puml → SQL/ → base → ORM`.
-- Las tablas técnicas (idempotency_keys) vienen de contracts/packages/idempotency/sql.
-- Ningún dato personal: el pagador se guarda como huella (HMAC) y el nombre que se criba NO se guarda (regla 90.2).

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'la tabla % es inmutable (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- Conjuntos de reglas versionados (D-23). NINGÚN límite tiene valor por defecto: NULL = regla apagada.
CREATE TABLE risk_rule_sets (
  version                          integer     NOT NULL,
  effective_from                   timestamptz NOT NULL,
  max_amount_minor                 bigint,     -- por transacción
  merchant_daily_amount_minor      bigint,     -- por comercio, ventana móvil de 24 h
  payer_daily_amount_minor         bigint,     -- por pagador, ventana móvil de 24 h
  payer_velocity_max               integer,    -- evaluaciones de intentos distintos por pagador en la ventana
  payer_velocity_window_seconds    integer,
  merchant_velocity_max            integer,
  merchant_velocity_window_seconds integer,
  hours_from                       smallint,   -- horario permitido [from, to) en hora de La Paz (UTC-4, sin horario de verano)
  hours_to                         smallint,
  published_by                     text        NOT NULL,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT risk_rule_sets_pkey PRIMARY KEY (version),
  CONSTRAINT risk_rule_sets_version_pos CHECK (version >= 1),
  CONSTRAINT risk_rule_sets_max_amount_pos CHECK (max_amount_minor IS NULL OR max_amount_minor > 0),
  CONSTRAINT risk_rule_sets_merchant_daily_pos CHECK (merchant_daily_amount_minor IS NULL OR merchant_daily_amount_minor > 0),
  CONSTRAINT risk_rule_sets_payer_daily_pos CHECK (payer_daily_amount_minor IS NULL OR payer_daily_amount_minor > 0),
  CONSTRAINT risk_rule_sets_payer_velocity_pair CHECK ((payer_velocity_max IS NULL) = (payer_velocity_window_seconds IS NULL)),
  CONSTRAINT risk_rule_sets_payer_velocity_pos CHECK (payer_velocity_max IS NULL OR (payer_velocity_max > 0 AND payer_velocity_window_seconds > 0)),
  CONSTRAINT risk_rule_sets_merchant_velocity_pair CHECK ((merchant_velocity_max IS NULL) = (merchant_velocity_window_seconds IS NULL)),
  CONSTRAINT risk_rule_sets_merchant_velocity_pos CHECK (merchant_velocity_max IS NULL OR (merchant_velocity_max > 0 AND merchant_velocity_window_seconds > 0)),
  CONSTRAINT risk_rule_sets_hours_pair CHECK ((hours_from IS NULL) = (hours_to IS NULL)),
  CONSTRAINT risk_rule_sets_hours_range CHECK (hours_from IS NULL OR (hours_from >= 0 AND hours_to <= 24 AND hours_from < hours_to))
);
-- Versión 1 = SIN límites: es la ausencia declarada de reglas, no un número inventado. Idempotente.
INSERT INTO risk_rule_sets (version, effective_from, published_by) VALUES (1, '2000-01-01T00:00:00Z', 'system:no-limits') ON CONFLICT (version) DO NOTHING;

-- Rastro auditable de cada decisión. Inmutable. Sin nombres, sin huellas en claro.
CREATE TABLE risk_assessments (
  id                   text        NOT NULL,
  caller_service       text        NOT NULL,
  request_key          text        NOT NULL,  -- Idempotency-Key del llamador: una evaluación por (servicio, clave)
  merchant_id          text        NOT NULL,
  payment_intent_id    text        NOT NULL,
  amount_minor         bigint      NOT NULL,
  currency             text        NOT NULL,
  method               text        NOT NULL,
  payer_hash           text,                  -- HMAC-SHA256 de la huella opaca del pagador
  decision             text        NOT NULL,
  reason_code          text        NOT NULL,  -- el motivo principal (el que se devuelve)
  reason_codes         text[]      NOT NULL,  -- todas las reglas que se activaron, para auditar
  rule_version         integer     NOT NULL,
  screened             boolean     NOT NULL,
  screening_top_score  numeric(8,6),          -- el mayor puntaje que devolvió Watchman, si cribó
  screening_list       text,                  -- lista pública de la coincidencia (por ejemplo us_ofac)
  screening_source_id  text,                  -- id de la entrada de la lista pública; NO es dato del pagador
  duration_ms          integer     NOT NULL,
  created_at           timestamptz NOT NULL,
  CONSTRAINT risk_assessments_pkey PRIMARY KEY (id),
  CONSTRAINT risk_assessments_request_uq UNIQUE (caller_service, request_key),
  CONSTRAINT risk_assessments_id_format CHECK (id ~ '^ra_[a-z0-9]{10,40}$'),
  CONSTRAINT risk_assessments_decision_valid CHECK (decision IN ('allow', 'review', 'deny')),
  CONSTRAINT risk_assessments_amount_pos CHECK (amount_minor >= 1),
  CONSTRAINT risk_assessments_method_valid CHECK (method IN ('qr', 'card', 'bank_transfer', 'wallet')),
  CONSTRAINT risk_assessments_rule_version_fk FOREIGN KEY (rule_version) REFERENCES risk_rule_sets (version),
  -- Nunca `allow` si no se cribó (contrato: «pay-risk nunca responde allow si no pudo cribar»).
  CONSTRAINT risk_assessments_allow_requires_screening CHECK (decision <> 'allow' OR screened)
);
CREATE INDEX risk_assessments_merchant_created_idx ON risk_assessments (merchant_id, created_at);
CREATE INDEX risk_assessments_payer_created_idx ON risk_assessments (payer_hash, created_at) WHERE payer_hash IS NOT NULL;
CREATE INDEX risk_assessments_intent_idx ON risk_assessments (payment_intent_id, created_at);

CREATE TRIGGER risk_rule_sets_immutable BEFORE UPDATE OR DELETE ON risk_rule_sets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER risk_assessments_immutable BEFORE UPDATE OR DELETE ON risk_assessments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER risk_rule_sets_no_truncate BEFORE TRUNCATE ON risk_rule_sets FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER risk_assessments_no_truncate BEFORE TRUNCATE ON risk_assessments FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
