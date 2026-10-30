#!/usr/bin/env python3
"""Comparador de catálogos Postgres para la verificación de deriva de las bases pay_* (regla 97.2, D-18).

Aplica DOS conjuntos de archivos SQL, cada uno a un esquema temporal `t_<hex>` de la base `pay_test`, y compara el
catálogo resultante: tablas, columnas (tipo, nulabilidad, default, identidad), restricciones (PK, FK, CHECK),
índices (únicos, método, columnas, predicado), triggers, funciones y filas. Los nombres de restricción se comparan
aparte y se informan, porque el modelo fija PK/FK por convención (`pk_<tabla>`, `fk_<tabla>_<col>`).

Siempre borra los esquemas temporales. NUNCA toca las bases pay_<servicio>. Credenciales de desarrollo local
(platform/compose.yml); se pueden cambiar con PAY_TEST_PG* .

Uso:
  pay_catalog_diff.py --a ref1.sql ref2.sql --b modelo/ddl.sql [--b-twice] [--json salida.json]
  pay_catalog_diff.py --only-b modelo/ddl.sql --b-twice          # idempotencia: B aplicado dos veces == una vez
"""
from __future__ import annotations
import argparse
import json
import os
import re
import secrets
import subprocess
import sys

PG = dict(
    host=os.environ.get("PAY_TEST_PGHOST", "127.0.0.1"),
    port=os.environ.get("PAY_TEST_PGPORT", "54321"),
    user=os.environ.get("PAY_TEST_PGUSER", "postgres"),
    password=os.environ.get("PAY_TEST_PGPASSWORD", "pay"),
    db=os.environ.get("PAY_TEST_PGDATABASE", "pay_test"),
)


def psql(args: list[str], sql: str | None = None) -> str:
    env = dict(os.environ, PGPASSWORD=PG["password"], PGOPTIONS="-c client_min_messages=warning")
    cmd = ["psql", "-X", "-q", "-h", PG["host"], "-p", PG["port"], "-U", PG["user"], "-d", PG["db"], "-v", "ON_ERROR_STOP=1"] + args
    r = subprocess.run(cmd, input=sql, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise RuntimeError(f"psql falló ({' '.join(args)[:120]}): {r.stderr.strip()[:2000]}")
    return r.stdout


def new_schema() -> str:
    s = "t_" + secrets.token_hex(6)
    psql(["-c", f"CREATE SCHEMA {s}"])
    return s


def drop_schema(s: str) -> None:
    psql(["-c", f"DROP SCHEMA IF EXISTS {s} CASCADE"])


def apply(schema: str, files: list[str], times: int = 1) -> None:
    for _ in range(times):
        args = ["-c", f"SET search_path TO {schema}"]
        for f in files:
            args += ["-f", f]
        psql(args)


QUERIES = {
    "columns": """
SELECT coalesce(jsonb_agg(x ORDER BY x.tbl, x.pos)::text, '[]') FROM (
  SELECT c.relname AS tbl, row_number() OVER (PARTITION BY c.relname ORDER BY a.attnum) AS pos, a.attname AS col,
         format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
         pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0 AND NOT a.attisdropped) x""",
    "constraints": """
SELECT coalesce(jsonb_agg(x ORDER BY x.tbl, x.kind, x.def)::text, '[]') FROM (
  SELECT c.relname AS tbl, k.contype AS kind, k.conname AS name, pg_get_constraintdef(k.oid) AS def,
         k.convalidated AS validated, k.condeferrable AS deferrable
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
   WHERE k.contype IN ('p','f','c','u','x')) x""",
    "indexes": """
SELECT coalesce(jsonb_agg(x ORDER BY x.tbl, x.def)::text, '[]') FROM (
  SELECT t.relname AS tbl, i.relname AS name, pg_get_indexdef(i.oid) AS def, x.indisunique AS uniq, x.indisprimary AS prim
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = current_schema()) x""",
    "triggers": """
SELECT coalesce(jsonb_agg(x ORDER BY x.tbl, x.name)::text, '[]') FROM (
  SELECT c.relname AS tbl, g.tgname AS name, pg_get_triggerdef(g.oid) AS def, g.tgenabled AS enabled
    FROM pg_trigger g
    JOIN pg_class c ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()
   WHERE NOT g.tgisinternal) x""",
    "functions": """
SELECT coalesce(jsonb_agg(x ORDER BY x.name)::text, '[]') FROM (
  SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = current_schema()) x""",
    "sequences": """
SELECT coalesce(jsonb_agg(x ORDER BY x.name)::text, '[]') FROM (
  SELECT c.relname AS name, format_type(s.seqtypid, NULL) AS type, s.seqstart AS start, s.seqincrement AS inc
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = current_schema()) x""",
}


def rows_digest(schema: str, tables: list[str], volatile: dict[str, list[str]]) -> dict[str, tuple[int, str]]:
    """Cuenta y huella del contenido de cada tabla. Las columnas con default now() se excluyen: varían entre aplicaciones."""
    out = {}
    for t in tables:
        drop = "".join(f" - '{c}'" for c in volatile.get(t, []))
        r = psql(["-At", "-c", f"SET search_path TO {schema}; SELECT count(*), coalesce(md5(string_agg((to_jsonb(t){drop})::text, '|' ORDER BY (to_jsonb(t){drop})::text)), '') FROM {t} t"]).strip().splitlines()[-1]
        n, h = r.split("|")
        out[t] = (int(n), h)
    return out


def catalog(schema: str) -> dict:
    cat = {}
    for k, q in QUERIES.items():
        out = psql(["-At", "-c", f"SET search_path TO {schema}; {q}"]).strip().splitlines()[-1]
        cat[k] = json.loads(out) if out and out != "" else []
        if cat[k] is None:
            cat[k] = []
    tables = sorted({c["tbl"] for c in cat["columns"]})
    volatile: dict[str, list[str]] = {}
    for c in cat["columns"]:
        if c["default"] and "now()" in c["default"]:
            volatile.setdefault(c["tbl"], []).append(c["col"])
    cat["rows"] = rows_digest(schema, tables, volatile)
    return cat


def norm(text: str, schema: str) -> str:
    text = re.sub(rf"\b{schema}\.", "", text)
    return re.sub(r"\s+", " ", text).strip()


def semantic(cat: dict, schema: str) -> dict:
    """Vista del catálogo sin nombres de restricción/índice (los nombres se comparan aparte)."""
    s: dict = {}
    s["tables"] = sorted({c["tbl"] for c in cat["columns"]})
    s["columns"] = [(c["tbl"], c["pos"], c["col"], c["type"], c["notnull"], norm(c["default"] or "", schema), c["identity"], c["generated"]) for c in cat["columns"]]
    s["pk"] = sorted((k["tbl"], norm(k["def"], schema)) for k in cat["constraints"] if k["kind"] == "p")
    s["fk"] = sorted((k["tbl"], norm(k["def"], schema)) for k in cat["constraints"] if k["kind"] == "f")
    s["check"] = sorted((k["tbl"], norm(k["def"], schema)) for k in cat["constraints"] if k["kind"] == "c")
    s["other_constraints"] = sorted((k["tbl"], k["kind"], norm(k["def"], schema)) for k in cat["constraints"] if k["kind"] in ("x",))
    # índices: se ignora el nombre; el UNIQUE como constraint o como índice único queda igual en pg_index
    def idx_norm(i):
        d = norm(i["def"], schema)
        d = re.sub(r"^CREATE (UNIQUE )?INDEX \S+ ON ", r"CREATE \1INDEX ON ", d)
        return (i["tbl"], d)
    s["indexes"] = sorted(idx_norm(i) for i in cat["indexes"])
    s["triggers"] = sorted((t["tbl"], t["name"], norm(t["def"], schema), t["enabled"]) for t in cat["triggers"])
    s["functions"] = sorted((f["name"], norm(f["def"], schema)) for f in cat["functions"])
    s["sequences"] = sorted((q["name"], q["type"], q["start"], q["inc"]) for q in cat["sequences"])
    s["rows"] = sorted((t, n, h) for t, (n, h) in cat["rows"].items())
    return s


def names(cat: dict) -> dict:
    return {
        "constraints": sorted((k["tbl"], k["kind"], k["name"]) for k in cat["constraints"]),
        "indexes": sorted((i["tbl"], i["name"]) for i in cat["indexes"]),
    }


def diff_sets(a: list, b: list):
    sa, sb = set(map(tuple, a)), set(map(tuple, b))
    return sorted(sa - sb), sorted(sb - sa)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", nargs="*", default=[], help="archivos SQL de referencia (en el orden en que los aplican las pruebas)")
    ap.add_argument("--b", nargs="*", default=[], help="archivos SQL del modelo")
    ap.add_argument("--b-twice", action="store_true", help="aplica B dos veces y exige catálogo idéntico a una sola aplicación")
    ap.add_argument("--json", help="vuelca el resultado a este archivo")
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    schemas: list[str] = []
    result: dict = {"label": args.label, "verdict": "PASS", "problems": []}
    try:
        sb1 = new_schema(); schemas.append(sb1)
        apply(sb1, args.b)
        cb1 = catalog(sb1)
        print(f"[B] {args.label}: {len(cb1['columns'])} columnas, {len({c['tbl'] for c in cb1['columns']})} tablas, {len(cb1['indexes'])} índices, "
              f"{len([k for k in cb1['constraints'] if k['kind']=='c'])} CHECK, {len([k for k in cb1['constraints'] if k['kind']=='f'])} FK, {len(cb1['triggers'])} triggers")
        if args.b_twice:
            sb2 = new_schema(); schemas.append(sb2)
            apply(sb2, args.b, times=2)
            cb2 = catalog(sb2)
            same = semantic(cb1, sb1) == semantic(cb2, sb2) and names(cb1) == names(cb2)
            print(f"[B x2] idempotencia (aplicar dos veces == una): {'PASS' if same else 'FAIL'}")
            if not same:
                result["verdict"] = "FAIL"; result["problems"].append("B aplicado dos veces difiere de B aplicado una vez")
            result["idempotent"] = same
        if args.a:
            sa = new_schema(); schemas.append(sa)
            apply(sa, args.a)
            ca = catalog(sa)
            print(f"[A] {args.label}: {len(ca['columns'])} columnas, {len({c['tbl'] for c in ca['columns']})} tablas, {len(ca['indexes'])} índices, "
                  f"{len([k for k in ca['constraints'] if k['kind']=='c'])} CHECK, {len([k for k in ca['constraints'] if k['kind']=='f'])} FK, {len(ca['triggers'])} triggers")
            A, B = semantic(ca, sa), semantic(cb1, sb1)
            for key in A:
                if A[key] != B[key]:
                    only_a, only_b = diff_sets(A[key], B[key]) if isinstance(A[key], list) and A[key] and isinstance(A[key][0], (list, tuple)) else (A[key], B[key])
                    result["verdict"] = "FAIL"
                    result["problems"].append({"aspecto": key, "solo_en_referencia": only_a, "solo_en_modelo": only_b})
                    print(f"[DIFF] {key}:\n   solo en referencia: {only_a}\n   solo en modelo:     {only_b}")
                else:
                    print(f"[=] {key}: {len(A[key])} elementos idénticos")
            na, nb = names(ca), names(cb1)
            dc_a, dc_b = diff_sets(na["constraints"], nb["constraints"])
            di_a, di_b = diff_sets(na["indexes"], nb["indexes"])
            # nombres esperados: PK pk_<t> vs <t>_pkey y FK de una columna fk_<t>_<c> vs <t>_<c>_fkey (o nombre propio)
            unexpected_a = [x for x in dc_a if x[1] not in ("p", "f", "u")]
            unexpected_b = [x for x in dc_b if x[1] not in ("p", "f", "u")]
            result["nombres_inesperados"] = {"referencia": unexpected_a, "modelo": unexpected_b}
            result["restricciones_con_nombre_distinto_por_convencion"] = {"referencia": dc_a, "modelo": dc_b}
            print(f"[nombres] restricciones con nombre distinto: {len(dc_a)} (PK/FK/UNIQUE por convención del modelo); "
                  f"CHECK/otros con nombre distinto: {len(unexpected_a)}; índices con nombre distinto (excluye los de PK/UNIQUE-constraint): "
                  f"{len([x for x in di_a if not x[1].endswith('_pkey')])}")
            if unexpected_a or unexpected_b:
                result["verdict"] = "FAIL"; result["problems"].append("CHECK u otras restricciones con nombre distinto")
            sel = [x for x in di_a if not (x[1].endswith("_pkey"))]
            selb = [x for x in di_b if not (x[1].startswith("pk_"))]
            # los UNIQUE-constraint de la referencia son índices únicos con el MISMO nombre en el modelo; si no, se informa
            if sel or selb:
                result["indices_con_nombre_distinto"] = {"referencia": sel, "modelo": selb}
                print(f"[nombres] índices: referencia {sel} / modelo {selb}")
                if sel or selb:
                    result["verdict"] = "FAIL"; result["problems"].append("índices con nombre distinto")
        result["catalogo_modelo"] = {"tablas": len({c['tbl'] for c in cb1['columns']}), "columnas": len(cb1["columns"]), "indices": len(cb1["indexes"]),
                                     "check": len([k for k in cb1["constraints"] if k["kind"] == "c"]), "fk": len([k for k in cb1["constraints"] if k["kind"] == "f"]),
                                     "triggers": len(cb1["triggers"]), "funciones": len(cb1["functions"])}
    finally:
        for s in schemas:
            try:
                drop_schema(s)
            except Exception as e:  # noqa: BLE001
                print(f"!! no se pudo borrar {s}: {e}", file=sys.stderr)
    print(f"VEREDICTO {args.label}: {result['verdict']}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2, default=str)
    return 0 if result["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
