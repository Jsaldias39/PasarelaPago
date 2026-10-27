-- SQL de referencia de pay-vault (P3.H3.M2). Hay que moverlo a mantra-core-health-model (D-18, regla 97.1).
-- IMPORTANTE: esta base guarda METADATOS de tokens, nunca el número de tarjeta, el CVV ni el nombre del titular.
-- El dato sensible lo custodia el `VaultBackend` (hyperswitch-card-vault o los campos alojados del banco). Ninguna columna
-- de este archivo puede contener un PAN: el test `pan-leak.spec.ts` lo comprueba recorriendo todas las tablas.
-- Idempotencia: contracts/packages/idempotency/sql/001_idempotency_keys.sql.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id                text        NOT NULL,
  merchant_id       text        NOT NULL,
  payment_intent_id text,
  save_card         boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL DEFAULT 'open',
  capture_url       text        NOT NULL,
  token             text,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT capture_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT capture_sessions_status_chk CHECK (status IN ('open', 'completed', 'expired', 'canceled')),
  CONSTRAINT capture_sessions_token_chk CHECK ((status = 'completed') = (token IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS capture_sessions_merchant_idx ON capture_sessions (merchant_id, created_at);

CREATE TABLE IF NOT EXISTS card_tokens (
  token           text        NOT NULL,
  merchant_id     text        NOT NULL,
  brand           text        NOT NULL,
  last4           text        NOT NULL,
  exp_month       smallint    NOT NULL,
  exp_year        smallint    NOT NULL,
  fingerprint     text        NOT NULL,
  single_use      boolean     NOT NULL,
  -- Un token de un solo uso queda atado al primer cobro que lo revela: otro cobro no puede usarlo.
  bound_charge_id text,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_tokens_pkey PRIMARY KEY (token),
  CONSTRAINT card_tokens_brand_chk CHECK (brand IN ('visa', 'mastercard', 'other')),
  CONSTRAINT card_tokens_last4_chk CHECK (last4 ~ '^[0-9]{4}$'),
  CONSTRAINT card_tokens_exp_chk CHECK (exp_month BETWEEN 1 AND 12 AND exp_year BETWEEN 2026 AND 2100)
);
CREATE INDEX IF NOT EXISTS card_tokens_merchant_idx ON card_tokens (merchant_id, created_at);

-- Cada llamada a `reveal` deja rastro (también las negadas). Sin datos de tarjeta.
CREATE TABLE IF NOT EXISTS reveal_audit (
  id              bigserial   NOT NULL,
  token           text        NOT NULL,
  merchant_id     text        NOT NULL,
  charge_id       text        NOT NULL,
  caller          text        NOT NULL,
  outcome         text        NOT NULL,
  idempotency_key text,
  at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reveal_audit_pkey PRIMARY KEY (id),
  CONSTRAINT reveal_audit_outcome_chk CHECK (outcome IN ('granted', 'denied_not_found', 'denied_bound_to_other_charge', 'backend_error'))
);
CREATE INDEX IF NOT EXISTS reveal_audit_token_idx ON reveal_audit (token, at);
