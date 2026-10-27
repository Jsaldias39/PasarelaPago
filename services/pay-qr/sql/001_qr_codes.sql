-- SQL de referencia de pay-qr (a mover a mantra-core-health-model, D-18). Índices con nombre explícito.
-- Además hay que aplicar la tabla técnica de idempotencia: contracts/packages/idempotency/sql/001_idempotency_keys.sql
CREATE TABLE IF NOT EXISTS qr_codes (
  id                text        PRIMARY KEY CHECK (id ~ '^qr_[a-z0-9]{10,40}$'),
  kind              text        NOT NULL CHECK (kind IN ('static', 'dynamic')),
  -- Modo de la CLAVE que pidió el QR (D-28, `X-Pay-Mode`): lo fija pay-edge. Toda lectura filtra por (id, modo).
  pay_mode          text        NOT NULL CHECK (pay_mode IN ('test', 'live')),
  merchant_id       text        NOT NULL CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$'),
  payment_intent_id text        CHECK (payment_intent_id IS NULL OR payment_intent_id ~ '^pi_[a-z0-9]{10,40}$'),
  reference         text        NOT NULL CHECK (reference ~ '^[A-Za-z0-9]{1,25}$'),
  amount_minor      bigint      CHECK (amount_minor IS NULL OR amount_minor > 0),
  currency          text        NOT NULL CHECK (currency = 'BOB'),
  payload           text        NOT NULL,
  expires_at        timestamptz,
  canceled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qr_codes_dynamic_fields_ck CHECK (kind = 'static' OR (payment_intent_id IS NOT NULL AND amount_minor IS NOT NULL AND expires_at IS NOT NULL))
);
-- La referencia viaja DENTRO del QR que se escanea: es única entre modos, para que un QR identifique un solo registro.
CREATE UNIQUE INDEX IF NOT EXISTS qr_codes_reference_uidx ON qr_codes (reference);
-- Un solo QR estático vigente por comercio, y un solo QR dinámico vigente por intento de pago.
CREATE UNIQUE INDEX IF NOT EXISTS qr_codes_static_per_merchant_uidx ON qr_codes (pay_mode, merchant_id) WHERE kind = 'static' AND canceled_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS qr_codes_live_per_intent_uidx ON qr_codes (pay_mode, payment_intent_id) WHERE kind = 'dynamic' AND canceled_at IS NULL;
