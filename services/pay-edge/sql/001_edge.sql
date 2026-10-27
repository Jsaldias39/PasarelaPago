-- SQL de referencia de pay-edge (a mover a mantra-core-health-model, D-18).
-- pay-edge NO es dueño de estos datos: son RÉPLICAS de solo lectura que se llenan con eventos de pay-merchants
-- (api_key.* y merchant.*). La fuente de la verdad es pay-merchants.

CREATE TABLE IF NOT EXISTS api_key_replica (
  key_id        text        NOT NULL,
  merchant_id   text        NOT NULL,
  mode          text        NOT NULL,
  -- null mientras solo se conoce una revocación que llegó ANTES que la creación (tombstone): sin hash, la clave no verifica.
  key_hash      text,
  -- instante desde el que la clave deja de servir; puede ser futuro (periodo de gracia de una rotación).
  revoked_at    timestamptz,
  last_event_id text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_key_replica_pkey PRIMARY KEY (key_id),
  CONSTRAINT api_key_replica_mode_check CHECK (mode IN ('test', 'live')),
  CONSTRAINT api_key_replica_hash_check CHECK (key_hash IS NULL OR key_hash ~ '^sha256\$[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS api_key_replica_merchant_idx ON api_key_replica (merchant_id);

CREATE TABLE IF NOT EXISTS merchant_replica (
  merchant_id   text        NOT NULL,
  status        text        NOT NULL,
  -- instante del evento que fijó el estado: un evento más viejo que este no lo pisa (los eventos llegan desordenados).
  status_at     timestamptz NOT NULL,
  last_event_id text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_replica_pkey PRIMARY KEY (merchant_id),
  CONSTRAINT merchant_replica_status_check CHECK (status IN ('active', 'suspended', 'closed'))
);

-- Inbox de @pay/outbox: un evento, un efecto.
CREATE TABLE IF NOT EXISTS inbox_events (
  consumer     text        NOT NULL,
  event_id     text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_events_pkey PRIMARY KEY (consumer, event_id)
);
