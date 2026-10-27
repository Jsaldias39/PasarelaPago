-- SQL de referencia de pay-connectors (a mover a mantra-core-health-model, D-18). Índices con nombre explícito (regla 97.3.2).
-- Además hay que aplicar las tablas técnicas de las librerías:
--   contracts/packages/idempotency/sql/001_idempotency_keys.sql
--   contracts/packages/outbox/sql/001_outbox_inbox.sql
-- Ninguna columna guarda datos del pagador, número de tarjeta ni credenciales (CLAUDE.md regla 6; regla 90.2).

-- Cobros pedidos a un proveedor. El estado del proveedor usa el vocabulario de los eventos (AsyncAPI); el público se deriva al leer.
CREATE TABLE IF NOT EXISTS connector_charges (
  id                     text        PRIMARY KEY CHECK (id ~ '^ch_[a-z0-9]{10,40}$'),
  caller                 text        NOT NULL,                       -- servicio que pidió el cobro (X-Service-Id)
  idempotency_key        text        NOT NULL,
  payment_intent_id      text        NOT NULL CHECK (payment_intent_id ~ '^pi_[a-z0-9]{10,40}$'),
  merchant_id            text        NOT NULL CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$'),
  connector              text        NOT NULL CHECK (connector IN ('mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer')),
  mode                   text        NOT NULL CHECK (mode IN ('sandbox', 'live')),
  method                 text        NOT NULL CHECK (method IN ('qr', 'card', 'bank_transfer')),
  amount_minor           bigint      NOT NULL CHECK (amount_minor > 0),
  currency               text        NOT NULL CHECK (currency = 'BOB'),
  provider_status        text        NOT NULL DEFAULT 'pending' CHECK (provider_status IN ('pending', 'authorized', 'captured', 'failed', 'canceled', 'expired')),
  next_action            jsonb,
  provider_reference     text,
  failure_code           text,
  -- true si el proveedor pudo haber creado el cobro y no se supo (timeout): no se prueba con otro conector, se reintenta con la misma referencia.
  ambiguous              boolean     NOT NULL DEFAULT false,
  routing_version        integer     NOT NULL,
  routing_rule           text,
  expires_at             timestamptz NOT NULL,
  last_provider_event_at timestamptz,
  poll_attempts          integer     NOT NULL DEFAULT 0,
  next_poll_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_charges_caller_key_uidx ON connector_charges (caller, idempotency_key);
-- Un solo cobro vivo (o cobrado) por intento de pago: un segundo cobro solo es posible cuando el anterior falló, se anuló o venció.
CREATE UNIQUE INDEX IF NOT EXISTS connector_charges_live_intent_uidx ON connector_charges (payment_intent_id) WHERE provider_status IN ('pending', 'authorized', 'captured');
CREATE INDEX IF NOT EXISTS connector_charges_poll_idx ON connector_charges (next_poll_at) WHERE provider_status IN ('pending', 'authorized');

CREATE TABLE IF NOT EXISTS connector_refunds (
  id                 text        PRIMARY KEY CHECK (id ~ '^cr_[a-z0-9]{10,40}$'),
  charge_id          text        NOT NULL REFERENCES connector_charges (id),
  caller             text        NOT NULL,
  idempotency_key    text        NOT NULL,
  amount_minor       bigint      NOT NULL CHECK (amount_minor > 0),
  currency           text        NOT NULL CHECK (currency = 'BOB'),
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  provider_reference text,
  failure_code       text,
  may_have_reached_provider boolean NOT NULL DEFAULT false,   -- ver connector_transfers
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_refunds_caller_key_uidx ON connector_refunds (caller, idempotency_key);
CREATE INDEX IF NOT EXISTS connector_refunds_charge_idx ON connector_refunds (charge_id);

-- Todo hecho que un proveedor informó (por callback o por consulta). `UNIQUE (connector, provider_event_id)` es la deduplicación.
-- No se guarda el cuerpo crudo del callback: puede traer datos del pagador.
CREATE TABLE IF NOT EXISTS connector_callback_events (
  id                bigserial   PRIMARY KEY,
  connector         text        NOT NULL,
  provider_event_id text        NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  charge_id         text,                                              -- null si la referencia no es nuestra
  status            text        NOT NULL,
  result            text        NOT NULL CHECK (result IN ('applied', 'duplicate', 'stale', 'contradiction')),
  observed_via      text        NOT NULL CHECK (observed_via IN ('callback', 'status_inquiry')),
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_callback_events_dedup_uidx ON connector_callback_events (connector, provider_event_id);
CREATE INDEX IF NOT EXISTS connector_callback_events_charge_idx ON connector_callback_events (charge_id);

-- Cada llamada al proveedor, para saber qué pasó con un cobro y alimentar la salud. Sin cuerpos.
CREATE TABLE IF NOT EXISTS connector_api_attempts (
  id         bigserial   PRIMARY KEY,
  subject_id text        NOT NULL,                                    -- id del cobro (`ch_…`) o de la transferencia (`tr_…`)
  connector  text        NOT NULL,
  operation  text        NOT NULL CHECK (operation IN ('create_charge', 'get_status', 'cancel', 'refund', 'create_transfer', 'get_transfer')),
  outcome    text        NOT NULL CHECK (outcome IN ('ok', 'unavailable', 'timeout', 'rejected')),
  latency_ms integer     NOT NULL CHECK (latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_api_attempts_subject_idx ON connector_api_attempts (subject_id, id);

CREATE TABLE IF NOT EXISTS connector_health (
  connector            text        PRIMARY KEY,
  mode                 text        NOT NULL CHECK (mode IN ('sandbox', 'live')),
  status               text        NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
  consecutive_failures integer     NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_reason          text        CHECK (last_reason IS NULL OR last_reason IN ('timeout', 'error_rate', 'unreachable', 'auth_failed')),
  degraded_since       timestamptz,
  latency_ms           integer,
  last_success_at      timestamptz,
  checked_at           timestamptz NOT NULL
);

-- Endpoints de callback registrados por conector (fail-closed: si hay alguno, solo los activos y desde sus redes).
CREATE TABLE IF NOT EXISTS connector_callback_endpoints (
  id                    bigserial PRIMARY KEY,
  connector             text      NOT NULL,
  callback_path         text      NOT NULL,
  active                boolean   NOT NULL DEFAULT true,
  allowed_source_cidrs  jsonb,
  replay_window_seconds integer   CHECK (replay_window_seconds IS NULL OR replay_window_seconds > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_callback_endpoints_path_uidx ON connector_callback_endpoints (connector, callback_path);

-- Reglas de ruteo versionadas. Una sola versión activa; cambiarla es insertar otra y activarla.
CREATE TABLE IF NOT EXISTS routing_rule_sets (
  version    integer     PRIMARY KEY CHECK (version >= 1),
  rules      jsonb       NOT NULL,
  active     boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS routing_rule_sets_one_active_uidx ON routing_rule_sets (active) WHERE active;

-- Referencia única de la transferencia bancaria; el pagador la escribe y con ella se concilia.
CREATE TABLE IF NOT EXISTS bank_transfer_references (
  reference  text        PRIMARY KEY CHECK (reference ~ '^TR[A-Z2-7]{10}$'),
  charge_id  text        NOT NULL REFERENCES connector_charges (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_transfer_references_charge_uidx ON bank_transfer_references (charge_id);

-- Líneas de extracto que no cierran (sin cobro, importe distinto, crédito repetido). Quedan para conciliación humana; no se descartan.
CREATE TABLE IF NOT EXISTS statement_exceptions (
  id                 bigserial   PRIMARY KEY,
  connector          text        NOT NULL,
  provider_reference text        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN ('unmatched', 'amount_mismatch', 'late_credit')),
  charge_id          text,
  expected_minor     bigint,
  actual_minor       bigint      NOT NULL,
  detected_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS statement_exceptions_line_uidx ON statement_exceptions (connector, provider_reference, kind);

-- Transferencias SALIENTES (pagos a comercios). Idempotentes por (business_ref, attempt). El registro se escribe ANTES de llamar al
-- proveedor: si el proceso muere o hay un timeout, la fila existe y `GET /transfers/{reference}` puede preguntar al proveedor.
-- `destination_ref` es una referencia opaca (Q-22): la pasarela no guarda números de cuenta.
CREATE TABLE IF NOT EXISTS connector_transfers (
  id                 text        PRIMARY KEY CHECK (id ~ '^tr_[a-z0-9]{10,40}$'),
  business_ref       text        NOT NULL CHECK (business_ref ~ '^[A-Za-z0-9:._-]{3,150}$'),
  attempt            integer     NOT NULL CHECK (attempt >= 1),
  caller             text        NOT NULL,
  connector          text        NOT NULL CHECK (connector IN ('mock', 'mercantil_qr', 'mercantil_card', 'bank_transfer')),
  mode               text        NOT NULL CHECK (mode IN ('sandbox', 'live')),
  amount_minor       bigint      NOT NULL CHECK (amount_minor > 0),
  currency           text        NOT NULL CHECK (currency = 'BOB'),
  destination_ref    text        NOT NULL CHECK (length(destination_ref) BETWEEN 1 AND 100),
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'paid', 'failed')),
  provider_reference text,
  failure_code       text,
  -- true desde ANTES de la primera llamada al proveedor: a partir de ahí una orden pudo haber llegado y la fila NO se descarta jamás.
  -- Solo mientras sea false un `connector_unavailable` prueba que no se envió nada.
  may_have_reached_provider boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Registro de dinero de solo-agregar: `failed` solo con explicación (la confirmó el proveedor o el conector garantiza que no envió).
  CONSTRAINT connector_transfers_failed_reason_ck CHECK (status <> 'failed' OR failure_code IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS connector_transfers_ref_attempt_uidx ON connector_transfers (business_ref, attempt);
-- Una operación de negocio se paga una sola vez, aunque se ordenen intentos distintos.
CREATE UNIQUE INDEX IF NOT EXISTS connector_transfers_one_paid_uidx ON connector_transfers (business_ref) WHERE status = 'paid';
