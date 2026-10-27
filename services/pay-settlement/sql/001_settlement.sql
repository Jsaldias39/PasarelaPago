-- SQL de referencia de pay-settlement (P2.H2.M1). A mover a mantra-core-health-model (D-18): el modelo todavía no existe.
-- pay-settlement NUNCA guarda saldos (los saldos son del ledger): guarda el estado de sus procesos —cortes, payouts, cobros pendientes,
-- corridas de conciliación y excepciones— y las marcas que le permiten repetir cualquier paso sin duplicar efectos.
-- Montos en centavos de BOB (bigint). Las tablas técnicas outbox_events / inbox_events / idempotency_keys vienen de contracts/packages.

-- Modo (D-28): `test` o `live`, el de la CLAVE que hizo la petición (cabecera X-Pay-Mode). Todo registro que mueve o lee dinero lo lleva, toda consulta lo
-- filtra, y se propaga al ledger y a los conectores. Un registro de un modo no se ve, no se cobra y no se paga desde el otro.

-- Comercios que el servicio conoce (los que aparecieron en el ledger). Es un directorio SIN modo: los eventos `ledger.*` todavía no llevan `mode`
-- (el AsyncAPI no lo declara), así que no se puede saber en qué modo vendió. Un comercio sin movimiento en un modo libera 0 en ese modo.
CREATE TABLE settlement_merchants (
  merchant_id      text        NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_merchants_pkey PRIMARY KEY (merchant_id)
);

-- Marcas del corte por (modo, comercio). `watermark_at` y `residual_minor` hacen incremental el corte: lo cobrado antes de `watermark_at` ya se
-- liberó, y `residual_minor` arrastra lo que quedó sin liberar (positivo) o lo que se devolvió de más (negativo) para que la ventana siguiente no lea
-- el ledger desde el principio de los tiempos. Cada modo tiene su propio saldo en el ledger, así que cada uno lleva sus propias marcas.
CREATE TABLE settlement_merchant_marks (
  mode           text   NOT NULL CHECK (mode IN ('test', 'live')),
  merchant_id    text   NOT NULL REFERENCES settlement_merchants (merchant_id),
  watermark_at   timestamptz,
  residual_minor bigint NOT NULL DEFAULT 0,
  CONSTRAINT settlement_merchant_marks_pkey PRIMARY KEY (mode, merchant_id)
);

-- Última versión del tarifario con abono mensual (evento fee_schedule.published). Una versión vieja nunca pisa a una nueva.
CREATE TABLE settlement_fee_plans (
  merchant_id       text        NOT NULL,
  version           integer     NOT NULL CHECK (version >= 1),
  monthly_fee_minor bigint      NOT NULL DEFAULT 0 CHECK (monthly_fee_minor >= 0),
  effective_from    timestamptz NOT NULL,
  effective_to      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_fee_plans_pkey PRIMARY KEY (merchant_id)
);

-- Un lote por modo y fecha de corte: `(mode, cutoff_date)` única es la idempotencia del corte (REQ-P2-5).
CREATE TABLE settlement_batches (
  id             text        NOT NULL,                  -- sb_<base>
  mode           text        NOT NULL CHECK (mode IN ('test', 'live')),
  cutoff_date    date        NOT NULL,
  release_days   integer     NOT NULL CHECK (release_days BETWEEN 0 AND 60),
  release_before timestamptz NOT NULL,
  period_from    timestamptz NOT NULL,
  status         text        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  merchants_count integer    NOT NULL DEFAULT 0,
  released_minor bigint      NOT NULL DEFAULT 0 CHECK (released_minor >= 0),
  payouts_count  integer     NOT NULL DEFAULT 0,
  failed_count   integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CONSTRAINT settlement_batches_pkey PRIMARY KEY (id),
  CONSTRAINT settlement_batches_cutoff_unique UNIQUE (mode, cutoff_date)
);

-- Un renglón por comercio y lote: lo planeado se guarda ANTES de tocar el ledger, así un reintento repite exactamente lo mismo.
CREATE TABLE settlement_batch_items (
  batch_id             text        NOT NULL REFERENCES settlement_batches (id),
  merchant_id          text        NOT NULL,
  status               text        NOT NULL CHECK (status IN ('pending', 'planned', 'released', 'done', 'failed')),
  window_from          timestamptz,
  planned_release_minor bigint     CHECK (planned_release_minor >= 0),
  new_residual_minor   bigint,
  ledger_attempt       integer     NOT NULL DEFAULT 1 CHECK (ledger_attempt >= 1),
  release_ref          text,
  released_minor       bigint      NOT NULL DEFAULT 0 CHECK (released_minor >= 0),
  -- Deuda del comercio en `merchant:{id}:debt` (lo que un contracargo perdido dejó por encima de su saldo pendiente, D-22) que el corte netea moviendo disponible → deuda.
  -- NULL = todavía no planeado; el monto se fija ANTES de llamar al ledger, como el de la liberación.
  netting_minor        bigint      CHECK (netting_minor >= 0),
  netting_attempt      integer     NOT NULL DEFAULT 1 CHECK (netting_attempt >= 1),
  payout_id            text,
  failure_code         text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_batch_items_pkey PRIMARY KEY (batch_id, merchant_id)
);

-- Pagos a comercios. `step` es el avance interno de la máquina (created → held → sent → resolved); `status` es el público.
CREATE TABLE settlement_payouts (
  id                text        NOT NULL,               -- po_<base>
  mode              text        NOT NULL CHECK (mode IN ('test', 'live')),
  merchant_id       text        NOT NULL,
  amount_minor      bigint      NOT NULL CHECK (amount_minor >= 1),
  currency          char(3)     NOT NULL,
  rail              text        NOT NULL CHECK (rail IN ('bank_transfer', 'acquirer_settlement')),
  simulated         boolean     NOT NULL,
  reason            text        NOT NULL CHECK (reason IN ('weekly_cut', 'mandate_obligation', 'mandate_commission', 'manual')),
  status            text        NOT NULL CHECK (status IN ('pending', 'in_transit', 'paid', 'failed')),
  step              text        NOT NULL CHECK (step IN ('created', 'held', 'sent', 'resolved')),
  hold_id           text,
  hold_business_ref text        NOT NULL,
  rail_reference    text,
  batch_id          text        REFERENCES settlement_batches (id),
  requested_by      text        NOT NULL,
  failure_code      text,
  period_from       timestamptz NOT NULL,
  period_to         timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz,
  CONSTRAINT settlement_payouts_pkey PRIMARY KEY (id),
  CONSTRAINT settlement_payouts_terminal_consistency CHECK ((status IN ('paid', 'failed')) = (step = 'resolved')),
  CONSTRAINT settlement_payouts_failure_consistency CHECK ((status = 'failed') = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX settlement_payouts_batch_merchant_unique ON settlement_payouts (batch_id, merchant_id) WHERE batch_id IS NOT NULL;
CREATE INDEX settlement_payouts_merchant_page ON settlement_payouts (mode, merchant_id, created_at DESC, id DESC);
CREATE INDEX settlement_payouts_open ON settlement_payouts (updated_at) WHERE step <> 'resolved';

-- Cobros a un comercio que se netean contra su saldo: abono mensual (D-07), comisión programada de proveedores (7.8) y deuda por
-- contracargo (D-22). Una vez por (comercio, tipo, periodo): ese es el «una sola vez por mes» de P2.H2.M9.
CREATE TABLE settlement_charges (
  id             text        NOT NULL,                  -- cg_<base>
  mode           text        NOT NULL CHECK (mode IN ('test', 'live')),
  merchant_id    text        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('monthly_fee', 'provider_commission', 'chargeback_debt')),
  period_key     text        NOT NULL,                  -- 2026-11 para el abono; la referencia del llamador en los demás
  credit_account text        NOT NULL,                  -- platform:fees (abono, comisión) o connector:<x>:clearing (contracargo)
  ledger_code    text        NOT NULL CHECK (ledger_code IN ('fee', 'refund')),
  amount_minor   bigint      NOT NULL CHECK (amount_minor >= 1),
  collected_minor bigint     NOT NULL DEFAULT 0 CHECK (collected_minor >= 0 AND collected_minor <= amount_minor),
  status         text        NOT NULL CHECK (status IN ('open', 'collected')),
  requested_by   text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  collected_at   timestamptz,
  CONSTRAINT settlement_charges_pkey PRIMARY KEY (id),
  CONSTRAINT settlement_charges_period_unique UNIQUE (mode, merchant_id, kind, period_key),
  CONSTRAINT settlement_charges_status_consistency CHECK ((status = 'collected') = (collected_minor = amount_minor))
);
CREATE INDEX settlement_charges_open ON settlement_charges (mode, merchant_id) WHERE status = 'open';

-- Cada intento de cobro contra el saldo. El monto se fija antes de llamar al ledger y su referencia es única por (cobro, seq).
CREATE TABLE settlement_charge_collections (
  charge_id    text        NOT NULL REFERENCES settlement_charges (id),
  seq          integer     NOT NULL CHECK (seq >= 1),
  amount_minor bigint      NOT NULL CHECK (amount_minor >= 1),
  ledger_ref   text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('planned', 'posted', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_charge_collections_pkey PRIMARY KEY (charge_id, seq)
);

-- Corridas de conciliación.
CREATE TABLE settlement_reconciliation_runs (
  id              text        NOT NULL,                 -- rr_<base>
  mode            text        NOT NULL CHECK (mode IN ('test', 'live')),
  connector       text        NOT NULL,
  period_from     timestamptz NOT NULL,
  period_to       timestamptz NOT NULL,
  source          text        NOT NULL CHECK (source IN ('api', 'csv', 'camt053')),
  status          text        NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  matched_count   integer     NOT NULL DEFAULT 0,
  exception_count integer     NOT NULL DEFAULT 0,
  ignored_count   integer     NOT NULL DEFAULT 0,
  failure_code    text,
  requested_by    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT settlement_reconciliation_runs_pkey PRIMARY KEY (id)
);

-- Las líneas del extracto que se leyeron. Se descarta la glosa del banco (puede traer datos personales).
CREATE TABLE settlement_statement_lines (
  run_id             text        NOT NULL REFERENCES settlement_reconciliation_runs (id),
  line_ref           text        NOT NULL,              -- extracto#n: referencia opaca, nunca el texto de la línea
  provider_reference text        NOT NULL,
  our_reference      text,
  direction          text        NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_minor       bigint      NOT NULL CHECK (amount_minor >= 0),
  value_date         date        NOT NULL,
  booked_at          timestamptz,
  outcome            text        NOT NULL CHECK (outcome IN ('matched', 'exception', 'ignored')),
  CONSTRAINT settlement_statement_lines_pkey PRIMARY KEY (run_id, line_ref)
);

-- Diferencias que una persona tiene que mirar. El ledger NO se ajusta solo (REQ-P2-6). `dedupe_key` evita reabrir la misma
-- diferencia en cada corrida.
CREATE TABLE settlement_exceptions (
  id                     text        NOT NULL,          -- rx_<base>
  mode                   text        NOT NULL CHECK (mode IN ('test', 'live')),
  run_id                 text        NOT NULL REFERENCES settlement_reconciliation_runs (id),
  connector              text        NOT NULL,
  kind                   text        NOT NULL CHECK (kind IN ('missing_in_ledger', 'missing_in_statement', 'amount_mismatch', 'duplicate_in_statement', 'unknown_reference')),
  provider_reference     text,
  business_ref           text,
  statement_amount_minor bigint      CHECK (statement_amount_minor >= 0),
  ledger_amount_minor    bigint      CHECK (ledger_amount_minor >= 0),
  difference_minor       bigint      NOT NULL,
  statement_line_ref     text        NOT NULL,
  merchant_id            text,
  payment_intent_id      text,
  status                 text        NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution             text        CHECK (resolution IN ('request_adjustment', 'dismiss')),
  resolved_by            text,
  resolution_note        text        CHECK (char_length(resolution_note) <= 500),
  resolved_at            timestamptz,
  dedupe_key             char(64)    NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_exceptions_pkey PRIMARY KEY (id),
  CONSTRAINT settlement_exceptions_dedupe_unique UNIQUE (dedupe_key),
  CONSTRAINT settlement_exceptions_resolution_consistency CHECK ((status = 'open') = (resolution IS NULL))
);
CREATE INDEX settlement_exceptions_page ON settlement_exceptions (mode, created_at DESC, id DESC);
CREATE INDEX settlement_exceptions_run ON settlement_exceptions (run_id);

-- Un pedido de ajuste NO mueve dinero: lo toma el flujo normal de asientos con su propia aprobación.
CREATE TABLE settlement_adjustment_requests (
  id           bigint      GENERATED ALWAYS AS IDENTITY,
  exception_id text        NOT NULL REFERENCES settlement_exceptions (id),
  requested_by text        NOT NULL,
  difference_minor bigint  NOT NULL,
  note         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_adjustment_requests_pkey PRIMARY KEY (id),
  CONSTRAINT settlement_adjustment_requests_exception_unique UNIQUE (exception_id)
);

-- Auditoría de las decisiones de personas (quién decidió, con qué rol, sobre qué). Solo se agrega.
CREATE TABLE settlement_audit (
  id      bigint      GENERATED ALWAYS AS IDENTITY,
  actor   text        NOT NULL,
  role    text        NOT NULL,
  action  text        NOT NULL,
  subject text        NOT NULL,
  detail  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_audit_pkey PRIMARY KEY (id)
);
