#!/usr/bin/env bash
# Aplica cada SQL/pay/*/ddl.sql DOS veces como un rol NO superusuario dueño de un esquema temporal de pay_test (como lo aplica el e2e:
# `e2e/lib/infra.ts` usa el rol del servicio, no el superusuario). Crea rol y esquema temporales y los borra al terminar.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
MODEL="${MODEL_REPO:-$ROOT/../mantra-core-health-model}/SQL/pay"
export PGPASSWORD="${PAY_TEST_PGPASSWORD:-pay}" PGOPTIONS="-c client_min_messages=warning"
P=(psql -X -q -h "${PAY_TEST_PGHOST:-127.0.0.1}" -p "${PAY_TEST_PGPORT:-54321}" -U "${PAY_TEST_PGUSER:-postgres}" -d "${PAY_TEST_PGDATABASE:-pay_test}" -v ON_ERROR_STOP=1)
HEX=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n'); ROLE="t_role_$HEX"; rc=0
"${P[@]}" -c "CREATE ROLE $ROLE NOSUPERUSER NOCREATEDB NOCREATEROLE" || exit 1
cleanup() { "${P[@]}" -c "DROP OWNED BY $ROLE CASCADE" -c "DROP ROLE IF EXISTS $ROLE" >/dev/null 2>&1; }
trap cleanup EXIT
for d in "$MODEL"/[0-9][0-9]_pay_*/; do
  n=$(basename "$d"); S="t_$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
  "${P[@]}" -c "CREATE SCHEMA $S AUTHORIZATION $ROLE" || { rc=1; continue; }
  if out=$("${P[@]}" -c "SET ROLE $ROLE" -c "SET search_path TO $S" -f "$d/ddl.sql" -c "SET ROLE $ROLE" -c "SET search_path TO $S" -f "$d/ddl.sql" 2>&1); then
    t=$("${P[@]}" -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = '$S'")
    echo "[OK ] $n: aplicado 2 veces como rol no superusuario; $t tablas"
  else echo "[FALLA] $n: $out"; rc=1; fi
  "${P[@]}" -c "DROP SCHEMA $S CASCADE" >/dev/null
done
exit $rc
