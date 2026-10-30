#!/usr/bin/env python3
"""Sondas de las tres correcciones de la revisión de seguridad (2026-10-28), en tres niveles (correcto / límite / inválido).

Cada sonda corre dos veces en un esquema temporal de `pay_test`, como un rol NO superusuario dueño del esquema (así es como la aplicación toca la
base): contra el SQL de REFERENCIA del monorepo (A) y contra el SQL GENERADO por el modelo (B). Las diferencias A != B son las DECLARADAS: cada
fila dice qué esperaba cada lado. Todo dentro de BEGIN…ROLLBACK. Borra esquemas y rol al terminar.
Uso: pay_hardening_probes.py <raíz del monorepo> <raíz del modelo>
"""
from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path

ROOT, MODEL = Path(sys.argv[1]), Path(sys.argv[2])
ENV = dict(os.environ, PGPASSWORD=os.environ.get("PAY_TEST_PGPASSWORD", "pay"), PGOPTIONS="-c client_min_messages=warning")
CONN = ["-h", os.environ.get("PAY_TEST_PGHOST", "127.0.0.1"), "-p", os.environ.get("PAY_TEST_PGPORT", "54321"), "-U", os.environ.get("PAY_TEST_PGUSER", "postgres"), "-d", "pay_test"]


def psql(args: list[str], stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["psql", "-X", "-q", *CONN, *args], input=stdin, capture_output=True, text=True, env=ENV)


def must(args: list[str]) -> None:
    r = psql(["-v", "ON_ERROR_STOP=1", *args])
    if r.returncode:
        raise RuntimeError(r.stderr.strip()[:1500])


def outcome(role: str, schema: str, sql: str) -> str:
    """'OK' si todas las sentencias pasan, o el SQLSTATE del primer error."""
    r = psql([], f"SET ROLE {role};\nSET search_path TO {schema};\n\\set VERBOSITY verbose\nBEGIN;\n{sql}\nROLLBACK;\n")
    for line in r.stderr.splitlines():
        if "ERROR:" in line:
            return line.split("ERROR:")[1].strip().split(":")[0].strip()
    return "OK"


CHARGE = ("INSERT INTO connector_charges (id, caller, idempotency_key, payment_intent_id, merchant_id, pay_mode, connector, connector_mode, method, "
          "amount_minor, currency, routing_version, expires_at, next_poll_at) VALUES ('ch_abcdefghij1','c','k','pi_abcdefghij1','mc_abcdefghij','test','mock','sandbox','qr',1,'BOB',1,now(),now());")
ACCT = "INSERT INTO ledger_accounts (mode, account, kind, tb_id) VALUES ('{m}','{a}','user_wallet',repeat('{c}',32));"
HOLD = ("INSERT INTO ledger_holds (id, mode, business_ref, attempt, content_hash, status, debit_account, credit_account, amount_minor, currency, expires_at) "
        "VALUES ('hd_x','{m}','b',1,repeat('a',64),'pending','{d}','{c}',1,'BOB',now());")

# (servicio, nivel, descripción, SQL, esperado en la referencia A, esperado en el modelo B)
PROBES = [
    ("merchants", "límite", "TRUNCATE contract_versions a secas: lo frena la FK de contract_acceptances (0A000), no el trigger", "TRUNCATE contract_versions;", "0A000", "0A000"),
    ("merchants", "límite", "TRUNCATE contract_versions CASCADE: en A lo frena indirectamente el trigger del hijo contract_acceptances", "TRUNCATE contract_versions CASCADE;", "23000", "23000"),
    ("merchants", "inválido", "TRUNCATE contract_versions CASCADE con el guardián del hijo apagado (aísla el guardián PROPIO de contract_versions)", "ALTER TABLE contract_acceptances DISABLE TRIGGER contract_acceptances_no_truncate; TRUNCATE contract_versions CASCADE;", "OK", "23000"),
    ("merchants", "inválido", "TRUNCATE fee_schedule_channels", "TRUNCATE fee_schedule_channels;", "OK", "23000"),
    ("merchants", "correcto", "control existente: TRUNCATE contract_acceptances ya estaba protegido", "TRUNCATE contract_acceptances;", "23000", "23000"),
    ("merchants", "correcto", "control existente: TRUNCATE fee_schedule_versions CASCADE ya estaba protegido", "TRUNCATE fee_schedule_versions CASCADE;", "23000", "23000"),
    ("merchants", "límite", "TRUNCATE de una tabla NO inmutable (api_keys) sigue permitido", "TRUNCATE api_keys;", "OK", "OK"),
    ("merchants", "correcto", "INSERT en la tabla inmutable sigue permitido", "INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES (1, repeat('a',64), now(), 'x');", "OK", "OK"),
    ("merchants", "inválido", "UPDATE de la tabla inmutable sigue rechazado", "INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES (1, repeat('a',64), now(), 'x'); UPDATE contract_versions SET published_by='y';", "23000", "23000"),
    ("connectors", "límite", "TRUNCATE connector_charges a secas: lo frena la FK de refunds (0A000)", "TRUNCATE connector_charges;", "0A000", "0A000"),
    ("connectors", "inválido", "TRUNCATE connector_charges CASCADE (arrastra refunds y referencias de transferencia)", "TRUNCATE connector_charges CASCADE;", "OK", "23000"),
    ("connectors", "inválido", "TRUNCATE connector_transfers", "TRUNCATE connector_transfers;", "OK", "23000"),
    ("connectors", "inválido", "TRUNCATE connector_refunds", "TRUNCATE connector_refunds;", "OK", "23000"),
    ("connectors", "límite", "TRUNCATE de una tabla sin guardián (connector_health) sigue permitido", "TRUNCATE connector_health;", "OK", "OK"),
    ("connectors", "correcto", "send_claims sube en 1", CHARGE + " UPDATE connector_charges SET send_claims = send_claims + 1;", "OK", "OK"),
    ("connectors", "límite", "send_claims igual (UPDATE de otra columna) sigue permitido", CHARGE + " UPDATE connector_charges SET send_claims = send_claims, provider_status = 'authorized';", "OK", "OK"),
    ("connectors", "límite", "send_claims baja en 1 (1 -> 0)", CHARGE + " UPDATE connector_charges SET send_claims = 1; UPDATE connector_charges SET send_claims = 0;", "OK", "23514"),
    ("connectors", "inválido", "send_claims baja a un valor negativo", CHARGE + " UPDATE connector_charges SET send_claims = 5; UPDATE connector_charges SET send_claims = -1;", "OK", "23514"),
    ("connectors", "correcto", "ambiguous true -> false PERMITIDO (lo resuelve un callback o una consulta autoritativa)", CHARGE + " UPDATE connector_charges SET ambiguous = true; UPDATE connector_charges SET ambiguous = false;", "OK", "OK"),
    ("connectors", "límite", "ambiguous false -> true permitido (se marca al reclamar el envío)", CHARGE + " UPDATE connector_charges SET ambiguous = true;", "OK", "OK"),
    ("connectors", "límite", "regresión: transfers sigue rechazando may_have_reached_provider true -> false", "INSERT INTO connector_transfers (id, business_ref, attempt, pay_mode, caller, connector, connector_mode, amount_minor, currency, destination_ref, may_have_reached_provider) VALUES ('tr_abcdefghij1','abc',1,'test','c','mock','sandbox',1,'BOB','d',true); UPDATE connector_transfers SET may_have_reached_provider = false;", "23514", "23514"),
    ("ledger", "correcto", "retención con las dos cuentas registradas en su modo", ACCT.format(m="test", a="a", c="a") + ACCT.format(m="test", a="b", c="b") + HOLD.format(m="test", d="a", c="b"), "OK", "OK"),
    ("ledger", "límite", "cuentas registradas en 'test', retención en 'live'", ACCT.format(m="test", a="a", c="a") + ACCT.format(m="test", a="b", c="b") + HOLD.format(m="live", d="a", c="b"), "OK", "23503"),
    ("ledger", "límite", "solo la cuenta de débito registrada", ACCT.format(m="test", a="a", c="a") + HOLD.format(m="test", d="a", c="b"), "OK", "23503"),
    ("ledger", "límite", "solo la cuenta de crédito registrada", ACCT.format(m="test", a="b", c="b") + HOLD.format(m="test", d="a", c="b"), "OK", "23503"),
    ("ledger", "inválido", "ninguna de las dos cuentas existe", HOLD.format(m="test", d="a", c="b"), "OK", "23503"),
    ("ledger", "inválido", "retención 'rejected' con cuentas inexistentes (el servicio también registra las cuentas antes de insertarla)", HOLD.format(m="test", d="a", c="b").replace("'pending'", "'rejected'"), "OK", "23503"),
]

REFERENCE = {
    "merchants": [ROOT / "services/pay-merchants/sql/001_merchants.sql", ROOT / "contracts/packages/outbox/sql/001_outbox_inbox.sql", ROOT / "contracts/packages/idempotency/sql/001_idempotency_keys.sql"],
    "connectors": [ROOT / "services/pay-connectors/sql/001_connectors.sql", ROOT / "contracts/packages/idempotency/sql/001_idempotency_keys.sql", ROOT / "contracts/packages/outbox/sql/001_outbox_inbox.sql"],
    "ledger": [ROOT / "services/pay-ledger/sql/001_ledger.sql", ROOT / "contracts/packages/outbox/sql/001_outbox_inbox.sql", ROOT / "contracts/packages/idempotency/sql/001_idempotency_keys.sql"],
}
GENERATED = {"merchants": MODEL / "SQL/pay/73_pay_merchants/ddl.sql", "connectors": MODEL / "SQL/pay/70_pay_connectors/ddl.sql", "ledger": MODEL / "SQL/pay/72_pay_ledger/ddl.sql"}


def main() -> int:
    hexid = os.urandom(6).hex()
    role = f"t_role_{hexid}"
    schemas: list[str] = []
    must(["-c", f"CREATE ROLE {role} NOSUPERUSER NOCREATEDB NOCREATEROLE"])
    bad = 0
    try:
        env: dict[tuple[str, str], str] = {}
        for svc in REFERENCE:
            for side, files in (("A", [str(f) for f in REFERENCE[svc]]), ("B", [str(GENERATED[svc])])):
                s = "t_" + os.urandom(6).hex()
                schemas.append(s)
                must(["-c", f"CREATE SCHEMA {s} AUTHORIZATION {role}"])
                args = ["-c", f"SET ROLE {role}", "-c", f"SET search_path TO {s}"]
                for f in files:
                    args += ["-f", f]
                must(args)
                env[(svc, side)] = s
        print(f"{'servicio':<10} {'nivel':<9} {'referencia A':<13} {'modelo B':<9} sonda")
        for svc, level, desc, sql, exp_a, exp_b in PROBES:
            got_a, got_b = outcome(role, env[(svc, 'A')], sql), outcome(role, env[(svc, 'B')], sql)
            ok = got_a == exp_a and got_b == exp_b
            decl = "  <- DIFERENCIA DECLARADA" if exp_a != exp_b else ""
            print(f"{svc:<10} {level:<9} {got_a:<13} {got_b:<9} {'OK   ' if ok else 'FALLA'} {desc}{decl}" + ("" if ok else f"  (esperado A={exp_a} B={exp_b})"))
            bad += 0 if ok else 1
        print(f"\nRESUMEN: {'PASS' if bad == 0 else f'FAIL ({bad})'} — {len(PROBES)} sondas; A = SQL de referencia (huecos), B = SQL del modelo (corregido)")
    finally:
        for s in schemas:
            psql(["-c", f"DROP SCHEMA IF EXISTS {s} CASCADE"])
        psql(["-c", f"DROP OWNED BY {role} CASCADE", "-c", f"DROP ROLE IF EXISTS {role}"])
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
