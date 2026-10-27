#!/usr/bin/env python3
"""Consultas de verificación (regla 97.7.4) y sondas de comportamiento sobre el SQL GENERADO por el modelo.

Aplica SQL/pay/<NN>_pay_<svc>/ddl.sql DOS veces a un esquema temporal de `pay_test` y verifica: conteos de tablas / FK / CHECK / índices
contra lo declarado en el .puml, huérfanos por FK (0), nulos en columnas NOT NULL (0), y un puñado de sondas negativas que ejercitan lo que
el DDL de referencia protege (FK compuesta, CHECK, trigger de inmutabilidad, identidad, semilla idempotente, índice único parcial).
Borra el esquema al terminar. No toca las bases pay_<servicio>.
"""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import pay_catalog_diff as cd  # noqa: E402

MODEL = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("../mantra-core-health-model")
PUML = MODEL / "Mantra Core Health Context" / "pay-modules"
SQLD = MODEL / "SQL" / "pay"


def expected_from_puml(puml: Path) -> dict:
    t = puml.read_text(encoding="utf-8")
    tables = len(re.findall(r'^entity (?!")[a-z_]+ \{', t, re.M))
    checks = len(re.findall(r"^\s*CHECK_SQL ", t, re.M))
    fk_single = len(re.findall(r"^[a-z_]+ \}o--\|\| [a-z_]+ : [a-z_]+$", t, re.M))
    fk_comp = len(re.findall(r"^\s*FK_SQL ", t, re.M))
    idx = len(re.findall(r"^\s+(?:UK|IX) ", t, re.M))
    triggers = len(re.findall(r"^\s*TRIGGER ", t, re.M))
    return dict(tablas=tables, check=checks, fk=fk_single + fk_comp, indices_no_pk=idx, triggers=triggers)


def q(schema: str, sql: str) -> str:
    return cd.psql(["-At", "-c", f"SET search_path TO {schema}; {sql}"]).strip().splitlines()[-1]


def expect_error(schema: str, sql: str, sqlstate: str) -> tuple[bool, str]:
    """Ejecuta `sql` en una transacción que se descarta; devuelve (falló con el SQLSTATE esperado, detalle)."""
    wrapped = f"SET search_path TO {schema}; \\set VERBOSITY verbose\nBEGIN;\n{sql}\nROLLBACK;"
    import os, subprocess
    env = dict(os.environ, PGPASSWORD=cd.PG["password"])
    r = subprocess.run(["psql", "-X", "-q", "-h", cd.PG["host"], "-p", cd.PG["port"], "-U", cd.PG["user"], "-d", cd.PG["db"]], input=wrapped, capture_output=True, text=True, env=env)
    out = r.stderr
    ok = f"ERROR:  {sqlstate}" in out
    first = next((l for l in out.splitlines() if "ERROR" in l), "(sin error)")
    return ok, first.strip()


# sondas: (servicio, descripción, SQL, SQLSTATE esperado)
PROBES = {
    "ledger": [
        ("FK compuesta: una pata con una cuenta que no existe en ese modo", "INSERT INTO ledger_legs (id, mode, source, source_id, business_ref, attempt, leg_index, debit_account, credit_account, amount_minor, code) VALUES ('tf_x','test','transaction','tx_x','b',1,0,'a','b',1,'c');", "23503"),
        ("CHECK compuesto: rechazado sin reject_code", "INSERT INTO ledger_transactions (id, mode, business_ref, attempt, content_hash, status, currency, legs) VALUES ('tx_x','test','b',1,repeat('a',64),'rejected','BOB','[]');", "23514"),
        ("CHECK de lista: modo inválido", "INSERT INTO ledger_accounts (mode, account, kind, tb_id) VALUES ('prod','a','user_wallet',repeat('a',32));", "23514"),
    ],
    "merchants": [
        ("trigger de inmutabilidad: UPDATE de una versión de contrato", "INSERT INTO contract_versions (version, text_sha256, effective_from, published_by) VALUES (1, repeat('a',64), now(), 'x'); UPDATE contract_versions SET published_by = 'y';", "23000"),
        ("trigger de inmutabilidad: TRUNCATE de aceptaciones", "TRUNCATE contract_acceptances;", "23000"),
        ("FK compuesta: canal de un tarifario inexistente", "INSERT INTO fee_schedule_channels (merchant_id, version, channel, percent) VALUES ('mc_x', 1, 'qr', '1.5');", "23503"),
    ],
    "risk": [
        ("trigger de inmutabilidad: UPDATE de la versión 1 de reglas", "UPDATE risk_rule_sets SET published_by = 'otro';", "23000"),
        ("CHECK: nunca allow si no se cribó", "INSERT INTO risk_assessments (id, caller_service, request_key, merchant_id, payment_intent_id, amount_minor, currency, method, decision, reason_code, reason_codes, rule_version, screened, duration_ms, created_at) VALUES ('ra_abcdefghij1','s','k','m','p',1,'BOB','qr','allow','x','{}',1,false,1,now());", "23514"),
    ],
    "settlement": [
        ("identidad GENERATED ALWAYS: no se puede fijar el id a mano", "INSERT INTO settlement_audit (id, actor, role, action, subject) VALUES (5, 'a','r','x','y');", "428C9"),
        ("CHECK compuesto: cobrado mayor que el importe", "INSERT INTO settlement_charges (id, mode, merchant_id, kind, period_key, credit_account, ledger_code, amount_minor, collected_minor, status, requested_by) VALUES ('cg_x','test','m','monthly_fee','2026-11','a','fee',5,9,'open','x');", "23514"),
    ],
    "connectors": [
        ("trigger de monotonía: may_have_reached_provider no vuelve a false", "INSERT INTO connector_transfers (id, business_ref, attempt, pay_mode, caller, connector, connector_mode, amount_minor, currency, destination_ref, may_have_reached_provider) VALUES ('tr_abcdefghij1','abc',1,'test','c','mock','sandbox',1,'BOB','d',true); UPDATE connector_transfers SET may_have_reached_provider = false;", "23514"),
        ("CHECK de coherencia de modo: clave test con conector live", "INSERT INTO connector_transfers (id, business_ref, attempt, pay_mode, caller, connector, connector_mode, amount_minor, currency, destination_ref) VALUES ('tr_abcdefghij2','abc',1,'test','c','mock','live',1,'BOB','d');", "23514"),
    ],
    "qr": [
        ("índice único parcial: un solo QR estático vigente por comercio", "INSERT INTO qr_codes (id, kind, pay_mode, merchant_id, reference, currency, payload) VALUES ('qr_abcdefghij1','static','test','mc_abcdefghij','R1','BOB','p'); INSERT INTO qr_codes (id, kind, pay_mode, merchant_id, reference, currency, payload) VALUES ('qr_abcdefghij2','static','test','mc_abcdefghij','R2','BOB','p');", "23505"),
    ],
    "vault": [
        ("CHECK: last4 con letras", "INSERT INTO card_tokens (token, merchant_id, brand, last4, exp_month, exp_year, fingerprint, single_use) VALUES ('t','m','visa','12ab',1,2030,'f',false);", "23514"),
    ],
}


def main() -> int:
    nums = {"connectors": 70, "edge": 71, "ledger": 72, "merchants": 73, "payments": 74, "qr": 75, "risk": 76, "schedules": 77, "settlement": 78, "vault": 79, "webhooks": 80, "lib": 81}
    bad = 0
    for svc, num in nums.items():
        puml = PUML / f"diagram_{num}_pay_{svc}.puml"
        ddl = SQLD / f"{num}_pay_{svc}" / "ddl.sql"
        exp = expected_from_puml(puml)
        schema = cd.new_schema()
        try:
            cd.apply(schema, [str(ddl)], times=2)
            got = dict(
                tablas=int(q(schema, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r'")),
                check=int(q(schema, "SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname=current_schema() AND k.contype='c'")),
                fk=int(q(schema, "SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname=current_schema() AND k.contype='f'")),
                indices_no_pk=int(q(schema, "SELECT count(*) FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT x.indisprimary")),
                triggers=int(q(schema, "SELECT count(*) FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT g.tgisinternal")),
            )
            # los TRIGGER del .puml incluyen los de TRUNCATE (cuentan como triggers en pg_trigger: sí)
            # huérfanos: un anti-join por FK (por construcción deben dar 0: la FK no deja crearlos)
            fks = cd.psql(["-At", "-F", "|", "-c", f"SET search_path TO {schema}; SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND k.contype='f' ORDER BY 1,2"]).strip().splitlines()
            fks = [l for l in fks if "|" in l]
            orphans = 0
            for line in fks:
                tbl, name, d = line.split("|", 2)
                m = re.match(r"FOREIGN KEY \((.*?)\) REFERENCES (\w+)\((.*?)\)", d)
                cols, rt, rc = [x.strip() for x in m.group(1).split(",")], m.group(2), [x.strip() for x in m.group(3).split(",")]
                on = " AND ".join(f"c.{a} = p.{b}" for a, b in zip(cols, rc))
                notnull = " AND ".join(f"c.{a} IS NOT NULL" for a in cols)
                orphans += int(q(schema, f"SELECT count(*) FROM {tbl} c LEFT JOIN {rt} p ON {on} WHERE {notnull} AND p.{rc[0]} IS NULL"))
            # nulos indebidos: filas con NULL en una columna NOT NULL (imposible por construcción; se consulta igual)
            cols = cd.psql(["-At", "-F", "|", "-c", f"SET search_path TO {schema}; SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=current_schema() AND is_nullable='NO'"]).strip().splitlines()
            nulls = sum(int(q(schema, f"SELECT count(*) FROM {l.split('|')[0]} WHERE {l.split('|')[1]} IS NULL")) for l in cols if "|" in l)
            # semilla idempotente: filas por tabla con datos después de aplicar DOS veces
            seeded = {t: int(q(schema, f"SELECT count(*) FROM {t}")) for t in re.findall(r"^\s*SEED_SQL (\w+)", puml.read_text(encoding="utf-8"), re.M)}
            diffs = {k: (exp[k], got[k]) for k in exp if exp[k] != got[k]}
            line = f"{svc:<11} tablas={got['tablas']:<3} fk={got['fk']:<2} check={got['check']:<3} índices(no PK)={got['indices_no_pk']:<3} triggers={got['triggers']:<2} | huérfanos={orphans} nulos_indebidos={nulls} semillas(2 aplicaciones)={seeded or '-'} | coincide con el .puml: {'SÍ' if not diffs else 'NO ' + str(diffs)}"
            print(line)
            if diffs or orphans or nulls or any(v != 1 for v in seeded.values()):
                bad += 1
            for desc, sql, state in PROBES.get(svc, []):
                ok, first = expect_error(schema, sql, state)
                print(f"    sonda [{'OK ' if ok else 'FALLA'}] {desc} -> {first[:150]}")
                bad += 0 if ok else 1
        finally:
            cd.drop_schema(schema)
    print(f"\nRESUMEN: {'PASS' if bad == 0 else 'FAIL (' + str(bad) + ')'}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
