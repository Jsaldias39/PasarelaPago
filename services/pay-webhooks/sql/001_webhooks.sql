-- SQL de referencia de pay-webhooks (a mover a mantra-core-health-model, D-18).
-- pay-webhooks es dueño de los endpoints de los comercios, de sus secretos de firma y de las entregas de eventos públicos.
-- Los secretos NUNCA se guardan en claro: `sealed_secret` es AES-256-GCM con la clave de cifrado del servicio.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                   text        NOT NULL,
  merchant_id          text        NOT NULL,
  url                  text        NOT NULL,
  description          text,
  enabled_events       text[]      NOT NULL,
  signature_scheme     text        NOT NULL DEFAULT 'v1',
  status               text        NOT NULL DEFAULT 'enabled',
  disabled_reason      text,
  -- entregas agotadas seguidas; una entrega correcta lo vuelve a cero. Al llegar al tope el endpoint se deshabilita.
  consecutive_failures integer     NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_endpoints_id_check CHECK (id ~ '^we_[a-z0-9]{10,40}$'),
  CONSTRAINT webhook_endpoints_events_check CHECK (cardinality(enabled_events) >= 1),
  CONSTRAINT webhook_endpoints_scheme_check CHECK (signature_scheme IN ('v1', 'v1a')),
  CONSTRAINT webhook_endpoints_status_check CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT webhook_endpoints_reason_check CHECK (disabled_reason IS NULL OR disabled_reason IN ('gone_410', 'too_many_failures', 'manual')),
  CONSTRAINT webhook_endpoints_reason_status_check CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

-- Una fila por versión del secreto. Durante una rotación conviven dos: la nueva (expires_at NULL) y la vieja con su gracia.
CREATE TABLE IF NOT EXISTS webhook_secrets (
  endpoint_id   text        NOT NULL,
  version       integer     NOT NULL,
  -- `whsec_…` (v1) o `whsk_…` (v1a), sellado con AES-256-GCM: `v1.<iv>.<tag>.<texto cifrado>` en base64url.
  sealed_secret text        NOT NULL,
  -- `whpk_…` solo para v1a: es lo que el comercio verifica.
  public_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- último instante en que todavía se firma con esta versión; NULL = vigente sin vencimiento.
  expires_at    timestamptz,
  CONSTRAINT webhook_secrets_pkey PRIMARY KEY (endpoint_id, version),
  CONSTRAINT webhook_secrets_endpoint_fk FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              text        NOT NULL,
  endpoint_id     text        NOT NULL,
  merchant_id     text        NOT NULL,
  -- `id` del CloudEvent: es también el `webhook-id` que ve el comercio, igual en todos los reintentos.
  event_id        text        NOT NULL,
  event_type      text        NOT NULL,
  -- cuerpo JSON exacto que se firma y se envía (texto, no jsonb: los bytes no cambian entre reintentos).
  payload         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_status     integer,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_deliveries_endpoint_fk FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints (id),
  CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending', 'succeeded', 'dead')),
  -- republicar el mismo evento no duplica la entrega
  CONSTRAINT webhook_deliveries_endpoint_event_key UNIQUE (endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- Historial de intentos: sin cuerpos ni mensajes de error de la red, solo códigos.
CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  delivery_id text        NOT NULL,
  attempt     integer     NOT NULL,
  attempted_at timestamptz NOT NULL,
  status_code integer,
  error_code  text,
  duration_ms integer     NOT NULL,
  CONSTRAINT webhook_delivery_attempts_pkey PRIMARY KEY (delivery_id, attempt),
  CONSTRAINT webhook_delivery_attempts_delivery_fk FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries (id)
);

-- Inbox de @pay/outbox: un evento, un efecto.
CREATE TABLE IF NOT EXISTS inbox_events (
  consumer     text        NOT NULL,
  event_id     text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_events_pkey PRIMARY KEY (consumer, event_id)
);
