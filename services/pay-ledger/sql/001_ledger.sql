-- SQL de referencia de pay-ledger (P2.H1.M2). A mover a mantra-core-health-model (D-18): el modelo todavía no existe.
-- TigerBeetle guarda saldos y asientos; acá vive lo que TigerBeetle no tiene (H-7 del spike): a qué operación de
-- negocio corresponde cada asiento, el extracto y el rastro de los rechazos (H-2). Montos en centavos de BOB (bigint).
-- Las tablas técnicas outbox_events / inbox_events / idempotency_keys vienen de contracts/packages/{outbox,idempotency}/sql.

-- Cuentas lógicas del plan de cuentas (PLAN-MAESTRO §3.3) y su id determinista de 128 bits en TigerBeetle.
CREATE TABLE ledger_accounts (
  account    text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('merchant_pending', 'merchant_available', 'user_wallet', 'platform_fees', 'connector_clearing', 'payout_clearing', 'schedule_reserve')),
  tb_id      char(32)    NOT NULL,                       -- hex del id de 128 bits
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_pkey PRIMARY KEY (account),
  CONSTRAINT ledger_accounts_tb_id_unique UNIQUE (tb_id)
);

-- Un asiento por (business_ref, attempt). Los rechazados también quedan: son los que fijan el siguiente attempt (H-TB1).
CREATE TABLE ledger_transactions (
  id           text        NOT NULL,                     -- tx_<base>
  business_ref text        NOT NULL,
  attempt      integer     NOT NULL CHECK (attempt >= 1),
  content_hash char(64)    NOT NULL,                     -- sha256 del contenido canónico: mismo attempt con otro contenido ⇒ 422
  status       text        NOT NULL CHECK (status IN ('posted', 'rejected')),
  reject_code  text        CHECK (reject_code IN ('insufficient_funds', 'validation_failed')),
  currency     char(3)     NOT NULL,
  legs         jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_transactions_ref_attempt_key UNIQUE (business_ref, attempt),
  CONSTRAINT ledger_transactions_reject_consistency CHECK ((status = 'rejected') = (reject_code IS NOT NULL))
);

-- Cada pata asentada (una transferencia de TigerBeetle). `id` es el tf_ que viaja en el evento ledger.transfer.posted.
CREATE TABLE ledger_legs (
  id             text        NOT NULL,                   -- tf_<base>
  source         text        NOT NULL CHECK (source IN ('transaction', 'hold')),
  source_id      text        NOT NULL,                   -- tx_… o hd_…
  business_ref   text        NOT NULL,
  attempt        integer     NOT NULL,
  leg_index      integer     NOT NULL CHECK (leg_index >= 0),
  debit_account  text        NOT NULL REFERENCES ledger_accounts (account),
  credit_account text        NOT NULL REFERENCES ledger_accounts (account),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  code           text        NOT NULL,
  posted_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_legs_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_legs_source_index_key UNIQUE (source_id, leg_index)
);
CREATE INDEX ledger_legs_business_ref_idx ON ledger_legs (business_ref, attempt);

-- Extracto: dos líneas por pata (débito y crédito). Orden estable: (posted_at desc, id desc).
CREATE TABLE ledger_statement_lines (
  id                   text        NOT NULL,             -- sl_<base>
  account              text        NOT NULL REFERENCES ledger_accounts (account),
  leg_id               text        NOT NULL REFERENCES ledger_legs (id),
  business_ref         text        NOT NULL,
  attempt              integer     NOT NULL,
  leg_index            integer     NOT NULL,
  direction            text        NOT NULL CHECK (direction IN ('debit', 'credit')),
  counterparty_account text        NOT NULL,
  amount_minor         bigint      NOT NULL CHECK (amount_minor > 0),
  code                 text        NOT NULL,
  posted_at            timestamptz NOT NULL,
  CONSTRAINT ledger_statement_lines_pkey PRIMARY KEY (id)
);
CREATE INDEX ledger_statement_lines_account_page_idx ON ledger_statement_lines (account, posted_at DESC, id DESC);

-- Retenciones (primera fase) con vencimiento.
CREATE TABLE ledger_holds (
  id                  text        NOT NULL,              -- hd_<base>
  business_ref        text        NOT NULL,
  attempt             integer     NOT NULL CHECK (attempt >= 1),
  content_hash        char(64)    NOT NULL,
  status              text        NOT NULL CHECK (status IN ('pending', 'posted', 'voided', 'expired', 'rejected')),
  reject_code         text        CHECK (reject_code IN ('insufficient_funds', 'validation_failed')),
  debit_account       text        NOT NULL,
  credit_account      text        NOT NULL,
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  posted_amount_minor bigint      CHECK (posted_amount_minor >= 0),
  currency            char(3)     NOT NULL,
  void_reason         text        CHECK (void_reason IN ('requested', 'downstream_failed')),
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  CONSTRAINT ledger_holds_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_holds_ref_attempt_key UNIQUE (business_ref, attempt)
);
CREATE INDEX ledger_holds_pending_expiry_idx ON ledger_holds (expires_at) WHERE status = 'pending';

-- Rastro de rechazos (P2.H1.M9): TigerBeetle NO guarda las transferencias rechazadas (H-2 del spike).
CREATE TABLE ledger_rejections (
  id           bigserial   NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('transaction', 'hold')),
  business_ref text        NOT NULL,
  attempt      integer     NOT NULL,
  reject_code  text        NOT NULL,
  tb_status    text        NOT NULL,                     -- nombre del estado de TigerBeetle (sin datos personales)
  caller       text        NOT NULL,                     -- X-Service-Id
  rejected_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_rejections_pkey PRIMARY KEY (id),
  CONSTRAINT ledger_rejections_ref_attempt_kind_key UNIQUE (kind, business_ref, attempt)
);
