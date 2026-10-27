-- SQL de referencia de pay-payments (P3.H1.M2). El modelo (D-18) todavía no existe: este archivo es lo que hay que mover a
-- mantra-core-health-model. Parte de payment_intents, refunds, payment_disputes y payment_cancellation_requests del módulo 42.
-- Idempotencia, outbox e inbox: contracts/packages/{idempotency,outbox}/sql/. Todo índice lleva nombre explícito.

CREATE TABLE IF NOT EXISTS payment_intents (
  id                      text        NOT NULL,
  merchant_id             text        NOT NULL,
  -- Modo de la CLAVE que originó el cobro (D-28): lo fija pay-edge (X-Pay-Mode), nunca el cliente. Todo acceso filtra por (comercio, modo).
  mode                    text        NOT NULL,
  amount_minor            bigint      NOT NULL,
  currency                text        NOT NULL DEFAULT 'BOB',
  method                  text        NOT NULL,
  status                  text        NOT NULL DEFAULT 'processing',
  fee_minor               bigint      NOT NULL,
  net_minor               bigint      NOT NULL,
  description             text,
  metadata                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  next_action             jsonb,
  failure_code            text,
  -- Motivo fino de un fallo, para el `detail` de la respuesta; el `failure_code` siempre es del catálogo (@pay/problem). Ej.: payment_method_unavailable.
  failure_reason          text,
  connector               text,                                    -- conector que tomó el cobro (mock, mercantil_qr, …)
  charge_id               text,                                    -- id del cargo en pay-connectors
  charge_status           text        NOT NULL DEFAULT 'pending',  -- último estado del cargo que APLICAMOS (máquina decideCallback)
  ledger_attempt          integer     NOT NULL DEFAULT 1,          -- sube SOLO tras un rechazo del ledger (H-TB1)
  ledger_transfer_id      text,                                    -- id del asiento aceptado (tx_… del ledger)
  card_token              text,                                    -- tok_… (nunca el número: el PAN no entra a este servicio)
  wallet_user_ref         text,                                    -- usuario de la billetera, salido de wallet_authorization
  source                  jsonb,                                   -- {kind:'mandate', id, period} si lo inició pay-schedules
  kind                    text,                                    -- obligation | commission (solo mandatos)
  beneficiary_merchant_id text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  succeeded_at            timestamptz,
  completed_at            timestamptz,
  CONSTRAINT payment_intents_pkey PRIMARY KEY (id),
  CONSTRAINT payment_intents_mode_chk CHECK (mode IN ('test', 'live')),
  CONSTRAINT payment_intents_amount_positive_chk CHECK (amount_minor > 0),
  CONSTRAINT payment_intents_fee_net_sum_chk CHECK (fee_minor >= 0 AND net_minor >= 0 AND fee_minor + net_minor = amount_minor),
  CONSTRAINT payment_intents_method_chk CHECK (method IN ('qr', 'card', 'bank_transfer', 'wallet')),
  CONSTRAINT payment_intents_status_chk CHECK (status IN ('requires_action', 'processing', 'succeeded', 'failed', 'canceled', 'expired')),
  CONSTRAINT payment_intents_charge_status_chk CHECK (charge_status IN ('pending', 'authorized', 'captured', 'settled', 'failed', 'canceled', 'expired')),
  CONSTRAINT payment_intents_card_token_chk CHECK (card_token IS NULL OR card_token ~ '^tok_[a-z0-9]{10,60}$'),
  CONSTRAINT payment_intents_terminal_completed_chk CHECK ((status IN ('succeeded', 'failed', 'canceled', 'expired')) = (completed_at IS NOT NULL))
);
-- Listado por comercio: orden determinista (created_at desc, id desc) para paginar por cursor.
CREATE INDEX IF NOT EXISTS payment_intents_merchant_created_idx ON payment_intents (merchant_id, mode, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS payment_intents_merchant_status_idx ON payment_intents (merchant_id, status);
-- Un mandato paga cada periodo una sola vez (idempotencia de negocio de los cobros programados).
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_mandate_period_uidx
  ON payment_intents ((source ->> 'id'), (source ->> 'period')) WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_intents_charge_idx ON payment_intents (charge_id) WHERE charge_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS refunds (
  id                  text        NOT NULL,
  payment_intent_id   text        NOT NULL,
  merchant_id         text        NOT NULL,
  mode                text        NOT NULL,                        -- el del cobro que se reembolsa (D-28)
  amount_minor        bigint      NOT NULL,
  currency            text        NOT NULL DEFAULT 'BOB',
  status              text        NOT NULL DEFAULT 'pending',
  reason              text,
  failure_code        text,
  ledger_hold_id      text,                                        -- retención de la primera fase (hd_…)
  ledger_transfer_id  text,
  connector_refund_id text,                                        -- cr_… que devolvió el conector: con él se consulta GET /refunds/{id}
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT refunds_pkey PRIMARY KEY (id),
  CONSTRAINT refunds_intent_fk FOREIGN KEY (payment_intent_id) REFERENCES payment_intents (id),
  CONSTRAINT refunds_mode_chk CHECK (mode IN ('test', 'live')),
  CONSTRAINT refunds_amount_positive_chk CHECK (amount_minor > 0),
  CONSTRAINT refunds_status_chk CHECK (status IN ('pending', 'succeeded', 'failed'))
);
CREATE INDEX IF NOT EXISTS refunds_intent_idx ON refunds (payment_intent_id);
CREATE INDEX IF NOT EXISTS refunds_merchant_created_idx ON refunds (merchant_id, mode, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS disputes (
  id                  text        NOT NULL,
  payment_intent_id   text        NOT NULL,
  merchant_id         text        NOT NULL,
  mode                text        NOT NULL,                        -- el del cobro disputado (D-28)
  amount_minor        bigint      NOT NULL,
  currency            text        NOT NULL DEFAULT 'BOB',
  status              text        NOT NULL DEFAULT 'open',
  evidence            jsonb       NOT NULL DEFAULT '[]'::jsonb,    -- referencias a documentos (ids), nunca su contenido
  ledger_transfer_id  text,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT disputes_pkey PRIMARY KEY (id),
  CONSTRAINT disputes_mode_chk CHECK (mode IN ('test', 'live')),
  CONSTRAINT disputes_intent_fk FOREIGN KEY (payment_intent_id) REFERENCES payment_intents (id),
  CONSTRAINT disputes_amount_positive_chk CHECK (amount_minor > 0),
  CONSTRAINT disputes_status_chk CHECK (status IN ('open', 'won', 'lost'))
);
-- Una sola disputa abierta por cobro.
CREATE UNIQUE INDEX IF NOT EXISTS disputes_one_open_per_intent_uidx ON disputes (payment_intent_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS payment_cancellation_requests (
  id                  bigserial   NOT NULL,
  payment_intent_id   text        NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  outcome             text        NOT NULL,                        -- canceled | too_late
  CONSTRAINT payment_cancellation_requests_pkey PRIMARY KEY (id),
  CONSTRAINT payment_cancellation_requests_intent_fk FOREIGN KEY (payment_intent_id) REFERENCES payment_intents (id)
);

-- Réplicas locales (regla de separación #5): el estado del comercio y su tarifario llegan por eventos.
CREATE TABLE IF NOT EXISTS merchant_replica (
  merchant_id      text        NOT NULL,
  status           text        NOT NULL,                           -- pending | active | suspended | closed
  occurred_at      timestamptz NOT NULL,                           -- del evento: un evento atrasado no pisa a uno más nuevo
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_replica_pkey PRIMARY KEY (merchant_id),
  CONSTRAINT merchant_replica_status_chk CHECK (status IN ('pending', 'active', 'suspended', 'closed'))
);

CREATE TABLE IF NOT EXISTS fee_schedule_replica (
  merchant_id      text        NOT NULL,
  version          integer     NOT NULL,
  currency         text        NOT NULL,
  channels         jsonb       NOT NULL,                           -- [{channel, percent, fixed_minor?, min_minor?, cap_minor?}]
  effective_from   timestamptz NOT NULL,
  effective_to     timestamptz,
  published_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_schedule_replica_pkey PRIMARY KEY (merchant_id, version)
);
CREATE INDEX IF NOT EXISTS fee_schedule_replica_effective_idx ON fee_schedule_replica (merchant_id, effective_from DESC);

-- Eventos del conector que contradicen un estado terminal (REQ-P3-3): quedan para conciliación humana, no se pisan.
CREATE TABLE IF NOT EXISTS intent_contradictions (
  id                  bigserial   NOT NULL,
  payment_intent_id   text        NOT NULL,
  current_status      text        NOT NULL,
  incoming_status     text        NOT NULL,
  source_event_id     text        NOT NULL,
  -- status_conflict: el conector dice algo incompatible con lo ya aplicado; compensation_failed / refund_pending_timeout: a mano.
  kind                text        NOT NULL DEFAULT 'status_conflict',
  reason              text        NOT NULL DEFAULT '',
  detected_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT intent_contradictions_pkey PRIMARY KEY (id),
  CONSTRAINT intent_contradictions_event_uidx UNIQUE (payment_intent_id, source_event_id)
);

-- Autorizaciones de billetera ya usadas (un solo uso, Q-20). Se guarda el id del token, no el token.
CREATE TABLE IF NOT EXISTS wallet_authorizations_used (
  authorization_id    text        NOT NULL,
  merchant_id         text        NOT NULL,
  payment_intent_id   text        NOT NULL,
  used_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_authorizations_used_pkey PRIMARY KEY (authorization_id)
);
