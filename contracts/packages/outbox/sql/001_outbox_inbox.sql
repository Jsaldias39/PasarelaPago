-- Tablas técnicas de @pay/outbox. Cada servicio las tiene en SU base. Se declaran en el modelo (D-18).
CREATE TABLE IF NOT EXISTS outbox_events (
  id             uuid        PRIMARY KEY,                -- id del CloudEvent; también es el Nats-Msg-Id
  seq            bigserial   NOT NULL UNIQUE,            -- orden de publicación
  aggregate_type text        NOT NULL,
  aggregate_id   text        NOT NULL,
  type           text        NOT NULL,
  subject        text        NOT NULL,                   -- tema NATS destino
  envelope       jsonb       NOT NULL,                   -- el CloudEvent completo
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       integer     NOT NULL DEFAULT 0,
  last_error     text
);
CREATE INDEX IF NOT EXISTS outbox_events_pending_idx ON outbox_events (seq) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS inbox_events (
  consumer     text        NOT NULL,                     -- qué consumidor procesó el evento
  event_id     text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_events_pkey PRIMARY KEY (consumer, event_id)
);
