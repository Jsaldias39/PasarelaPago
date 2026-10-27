-- SQL DE REFERENCIA de pay-schedules (P5.H3.M1). El modelo (D-18) todavía no existe: este archivo se mueve a
-- mantra-core-health-model cuando exista el pipeline `.puml → SQL/ → base → ORM`. Tomado de payment_mandates,
-- installment_plans e installment_schedules del módulo 42 de la API, reducido a lo que esta pasarela necesita.
-- Las tablas técnicas (outbox_events, inbox_events, idempotency_keys) vienen de contracts/packages/{outbox,idempotency}/sql.
-- Ningún nombre, documento ni cuenta de personas: solo ids y montos.

-- Réplica del estado de los comercios, mantenida por eventos `merchant.*` de pay-merchants (esta base no lee la de nadie).
CREATE TABLE merchant_replica (
  merchant_id  text        NOT NULL,
  status       text        NOT NULL,
  as_of        timestamptz NOT NULL,   -- hora del hecho que dejó este estado: un evento viejo no pisa a uno nuevo
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_replica_pkey PRIMARY KEY (merchant_id),
  CONSTRAINT merchant_replica_id_format CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$'),
  CONSTRAINT merchant_replica_status_valid CHECK (status IN ('active', 'suspended', 'closed'))
);

CREATE TABLE mandates (
  id                      text        NOT NULL,
  merchant_id             text        NOT NULL,   -- el pagador (dueño del mandato)
  mode                    text        NOT NULL,   -- D-28: lo fija pay-edge; los datos test y live no se mezclan
  kind                    text        NOT NULL,
  beneficiary_merchant_id text        NOT NULL,
  amount_minor            bigint      NOT NULL,
  currency                text        NOT NULL DEFAULT 'BOB',
  frequency               text        NOT NULL DEFAULT 'monthly',
  day_of_month            smallint    NOT NULL,
  start_date              date        NOT NULL,
  end_date                date,
  description             text,
  status                  text        NOT NULL DEFAULT 'active',
  next_run_on             date,                   -- próxima fecha por materializar; NULL = no quedan periodos
  created_at              timestamptz NOT NULL,
  canceled_at             timestamptz,
  CONSTRAINT mandates_pkey PRIMARY KEY (id),
  CONSTRAINT mandates_id_format CHECK (id ~ '^md_[a-z0-9]{10,40}$'),
  CONSTRAINT mandates_merchant_format CHECK (merchant_id ~ '^mc_[a-z0-9]{10,40}$' AND beneficiary_merchant_id ~ '^mc_[a-z0-9]{10,40}$'),
  CONSTRAINT mandates_mode_valid CHECK (mode IN ('test', 'live')),
  CONSTRAINT mandates_kind_valid CHECK (kind IN ('pay_obligation', 'pay_commission')),
  CONSTRAINT mandates_amount_pos CHECK (amount_minor >= 1),
  CONSTRAINT mandates_currency_bob CHECK (currency = 'BOB'),
  CONSTRAINT mandates_frequency_monthly CHECK (frequency = 'monthly'),
  CONSTRAINT mandates_day_valid CHECK (day_of_month BETWEEN 1 AND 28),
  CONSTRAINT mandates_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT mandates_status_valid CHECK (status IN ('active', 'paused_insufficient_funds', 'canceled', 'completed')),
  CONSTRAINT mandates_not_self CHECK (merchant_id <> beneficiary_merchant_id)
);
CREATE INDEX mandates_owner_idx ON mandates (merchant_id, mode, created_at DESC, id DESC);
CREATE INDEX mandates_due_idx ON mandates (next_run_on) WHERE status = 'active' AND next_run_on IS NOT NULL;

-- Un pago programado por (mandato, periodo): la UNIQUE es la garantía última de «una sola ejecución por periodo».
CREATE TABLE scheduled_payments (
  id                  text        NOT NULL,
  mandate_id          text        NOT NULL,
  period              text        NOT NULL,   -- AAAA-MM
  due_on              date        NOT NULL,
  status              text        NOT NULL DEFAULT 'due',
  phase               text        NOT NULL DEFAULT 'hold',   -- hasta dónde llegó con el libro mayor (recuperación sin repetir efectos)
  attempts            integer     NOT NULL DEFAULT 0,        -- intentos de ejecución (política de reintentos)
  ledger_attempt      integer     NOT NULL DEFAULT 1,        -- `attempt` del libro mayor: sube SOLO tras un rechazo definitivo
  hold_id             text,
  ledger_transaction_id text,
  ledger_transfer_id  text,
  next_attempt_at     timestamptz NOT NULL,
  lease_until         timestamptz,
  last_failure_code   text,
  needs_review        boolean     NOT NULL DEFAULT false,    -- un resultado ambiguo sin resolver: lo mira una persona, nada se anula solo
  created_at          timestamptz NOT NULL,
  executed_at         timestamptz,
  CONSTRAINT scheduled_payments_pkey PRIMARY KEY (id),
  CONSTRAINT scheduled_payments_id_format CHECK (id ~ '^sp_[a-z0-9]{10,40}$'),
  CONSTRAINT scheduled_payments_mandate_fk FOREIGN KEY (mandate_id) REFERENCES mandates (id),
  CONSTRAINT scheduled_payments_period_uq UNIQUE (mandate_id, period),
  CONSTRAINT scheduled_payments_period_format CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT scheduled_payments_status_valid CHECK (status IN ('due', 'waiting_funds', 'executed', 'failed', 'canceled')),
  CONSTRAINT scheduled_payments_phase_valid CHECK (phase IN ('hold', 'post', 'release', 'void', 'reverse', 'done')),
  -- El dinero se movió: un `executed` siempre tiene su asiento. El id `tf_` del evento puede faltar (needs_review) si el libro mayor no lo devuelve.
  CONSTRAINT scheduled_payments_executed_has_transaction CHECK (status <> 'executed' OR (ledger_transaction_id IS NOT NULL AND executed_at IS NOT NULL))
);
CREATE INDEX scheduled_payments_due_idx ON scheduled_payments (next_attempt_at) WHERE status IN ('due', 'waiting_funds');
