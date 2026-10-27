-- Tabla técnica de @pay/idempotency. Cada servicio la tiene en SU base (regla de separación #1).
-- Se declara en el modelo (mantra-core-health-model, D-18) y se aplica por el pipeline; este archivo es la referencia.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           text        NOT NULL,                    -- quién: el id del comercio
  key             text        NOT NULL,                    -- la Idempotency-Key del cliente
  request_hash    text        NOT NULL,                    -- sha256 de método + ruta + cuerpo canónico
  state           text        NOT NULL CHECK (state IN ('started', 'completed')),
  recovery_point  text        NOT NULL DEFAULT 'started',  -- hasta dónde llegó la ejecución
  response_status integer,
  response_body   jsonb,
  locked_at       timestamptz,                             -- null = nadie la está ejecutando
  lock_token      text,                                    -- identifica a quien la ejecuta (compare-and-set)
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (scope, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);
