-- pay-mockbank: BANCO SIMULADO (SANDBOX). Ningún campo de aquí es de un banco real (Q-01, Q-11 siguen abiertas).
-- Esquema propio de la base `pay_mockbank`; ningún otro servicio la lee.

CREATE SEQUENCE IF NOT EXISTS mb_bank_seq;

-- Cobros (QR, tarjeta de un solo paso, transferencia entrante). Clave natural: la referencia que manda la pasarela (`ch_…`).
CREATE TABLE IF NOT EXISTS mb_charges (
  reference      text        PRIMARY KEY CHECK (reference ~ '^ch_[a-z0-9]{10,40}$'),
  bank_reference text        NOT NULL UNIQUE,
  method         text        NOT NULL CHECK (method IN ('qr', 'card', 'bank_transfer')),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  currency       text        NOT NULL CHECK (currency = 'BOB'),
  scenario       text        NOT NULL,
  expires_at     timestamptz NOT NULL,
  -- Instante en que el pagador «paga»; nulo si nunca (rechazado / nunca pagado) o si todavía no pagó (QR sin pagar por el simulador).
  paid_at        timestamptz,
  canceled       boolean     NOT NULL DEFAULT false,
  -- El QR que la pasarela dice haber emitido para este cobro: el pagador simulado lo busca por este texto exacto.
  qr_payload     text,
  -- Un QR que el pagador simulado debe pagar él mismo (ver `payer`): el cobro queda abierto hasta que lo paga.
  awaits_payer   boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mb_charges_qr_payload_uidx ON mb_charges (qr_payload) WHERE qr_payload IS NOT NULL;

CREATE TABLE IF NOT EXISTS mb_refunds (
  reference        text        PRIMARY KEY CHECK (reference ~ '^cr_[a-z0-9]{10,40}$'),
  charge_reference text        NOT NULL REFERENCES mb_charges (reference),
  bank_reference   text        NOT NULL UNIQUE,
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mb_refunds_charge_idx ON mb_refunds (charge_reference);

-- Transferencias salientes. La referencia es la que manda pay-settlement (`po_…:payout:N`); el banco no la interpreta.
CREATE TABLE IF NOT EXISTS mb_transfers (
  reference      text        PRIMARY KEY CHECK (length(reference) BETWEEN 1 AND 200),
  bank_reference text        NOT NULL UNIQUE,
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  scenario       text        NOT NULL,
  delay_ms       integer     NOT NULL,
  created_at     timestamptz NOT NULL
);

-- Autorización / captura / anulación de tarjeta. Solo el token de prueba (`tok_…`): NUNCA un PAN, ni siquiera enmascarado.
CREATE TABLE IF NOT EXISTS mb_card_auths (
  reference       text        PRIMARY KEY CHECK (reference ~ '^ch_[a-z0-9]{10,40}$'),
  bank_reference  text        NOT NULL UNIQUE,
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  captured_minor  bigint      NOT NULL DEFAULT 0 CHECK (captured_minor >= 0 AND captured_minor <= amount_minor),
  status          text        NOT NULL CHECK (status IN ('authorized', 'captured', 'voided', 'declined')),
  scenario        text        NOT NULL,
  failure_code    text,
  created_at      timestamptz NOT NULL
);

-- Callbacks por entregar. Una fila por ENTREGA (el escenario «duplicado» crea tres filas con el mismo `event_id`).
CREATE TABLE IF NOT EXISTS mb_callbacks (
  id              bigserial   PRIMARY KEY,
  event_id        text        NOT NULL,
  reference       text        NOT NULL,
  status          text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  amount_minor    bigint      NOT NULL,
  failure_code    text,
  due_at          timestamptz NOT NULL,
  delivered_at    timestamptz,
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mb_callbacks_pending_idx ON mb_callbacks (due_at, id) WHERE delivered_at IS NULL;

-- Líneas del extracto que NO nacen de un cobro del banco: depósitos del pagador por transferencia y líneas ajenas (por ejemplo un depósito sin referencia).
CREATE TABLE IF NOT EXISTS mb_statement_extra (
  id             bigserial   PRIMARY KEY,
  bank_reference text        NOT NULL UNIQUE,
  our_reference  text,
  direction      text        NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  value_date     date        NOT NULL,
  booked_at      timestamptz NOT NULL,
  description    text,
  -- Cuenta del extracto: `collections` (cobros QR/tarjeta) o `transfers` (depósitos de pagadores por transferencia bancaria).
  account        text        NOT NULL DEFAULT 'collections' CHECK (account IN ('collections', 'transfers'))
);

-- El banco está «caído» (escenario 06 de forma global, para probar salud y ruteo): una sola fila.
CREATE TABLE IF NOT EXISTS mb_switches (
  id   smallint PRIMARY KEY CHECK (id = 1),
  down boolean  NOT NULL DEFAULT false
);
INSERT INTO mb_switches (id, down) VALUES (1, false) ON CONFLICT DO NOTHING;
