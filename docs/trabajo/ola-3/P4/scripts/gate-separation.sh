#!/usr/bin/env bash
# Gate «Separación» (PLAN-MAESTRO §7, regla de separación #1): el servicio ARRANCA y FUNCIONA con un usuario de base SIN permisos sobre las demás bases.
#
# Para cada servicio (pay-connectors, pay-qr, pay-mockbank):
#   1. con SU rol del Compose (pay_<svc> / dev_only_<svc>), crea un esquema descartable en SU base y aplica el DDL del servicio;
#   2. lanza `node dist/main.js` con ESE rol (nunca el superusuario), espera `/health/ready` y ejecuta una operación real contra la base;
#   3. con el mismo rol, intenta entrar a las otras 11 bases, a `postgres` y a `pay_test`: todas tienen que dar «permission denied»;
#   4. borra el esquema y baja el proceso.
# Uso (con el Compose arriba y los servicios compilados):  docs/trabajo/ola-3/P4/scripts/gate-separation.sh
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
HOST=${PAY_DB_HOST:-127.0.0.1}; PORT=${PAY_DB_PORT:-54321}
ALL=(edge payments connectors qr ledger settlement merchants risk schedules webhooks vault mockbank)
bad=0
fail() { echo "FALLA: $*"; bad=$((bad+1)); }
free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }

check_service() {
  local svc=$1 short=${1#pay-} extra_sql=$2 operation=$3
  local role="pay_${short}" pass="dev_only_${short}" schema="sep_$$_${short}"
  local port; port=$(free_port)
  echo
  echo "══ ${svc}: rol ${role} sobre la base ${role} ══"
  export PGPASSWORD="$pass"
  local psql_base=(psql -h "$HOST" -p "$PORT" -U "$role" -d "$role" -v ON_ERROR_STOP=1 -q)
  # 1. DDL con el rol del servicio (no el superusuario).
  # pay-connectors y pay-qr: sql/ddl.sql (el del MODELO, con las tablas técnicas incluidas); pay-mockbank: su doble (sql/001_mockbank.sql).
  local files=("$ROOT/services/$svc/sql/"*.sql)
  [ -n "$extra_sql" ] && files+=($extra_sql)
  local args=(-c "DROP SCHEMA IF EXISTS $schema CASCADE" -c "CREATE SCHEMA $schema" -c "SET search_path TO $schema")
  for f in "${files[@]}"; do args+=(-f "$f"); done
  if "${psql_base[@]}" "${args[@]}" >/dev/null 2>&1; then echo "PASS  DDL aplicado con el rol ${role} (esquema ${schema}): ${#files[@]} archivo(s)"; else fail "${svc}: no se pudo aplicar el DDL con su propio rol"; fi
  echo "      quién soy en la base: $(psql -h "$HOST" -p "$PORT" -U "$role" -d "$role" -tAc "select current_user, (select rolsuper from pg_roles where rolname = current_user)" )  (usuario, superusuario)"
  # 2. El servicio arranca con ESE rol y atiende.
  local env=(PATH="$PATH" DB_HOST="$HOST" DB_PORT="$PORT" DB_NAME="$role" DB_USER="$role" DB_PASSWORD="$pass" PGOPTIONS="-c search_path=$schema" PORT="$port" PAY_MODE=sandbox LOG_LEVEL=warn)
  case $svc in
    pay-connectors) env+=(PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET=whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg== POLLER_INTERVAL_MS=0 HEALTH_INTERVAL_MS=0 RECONCILE_INTERVAL_MS=0 MOCK_PUMP_INTERVAL_MS=0);;
    pay-qr) env+=(QR_ACCOUNT_GUID=e2e.sandbox.guid);;
    pay-mockbank) env+=(MOCKBANK_WEBHOOK_SECRET=whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg== MOCKBANK_DELIVERY_INTERVAL_MS=0);;
  esac
  local log; log=$(mktemp)
  (cd "$ROOT/services/$svc" && exec env -i "${env[@]}" node dist/main.js >"$log" 2>&1) &
  local pid=$!
  local ready=0
  for _ in $(seq 1 200); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/health/ready")" = "200" ]; then ready=1; break; fi
    kill -0 $pid 2>/dev/null || break
    sleep 0.1
  done
  if [ $ready -eq 1 ]; then echo "PASS  arranca con el rol ${role}: GET /health/ready = $(curl -s "http://127.0.0.1:$port/health/ready" | head -c 90)"; else fail "${svc} no llegó a estar listo con su rol:"; sed 's/^/        /' "$log" | head -10; fi
  if [ $ready -eq 1 ]; then
    local out; out=$(eval "$operation")
    if [ "${out%% *}" = "OK" ]; then echo "PASS  operación real contra la base: ${out#OK }"; else fail "${svc}: la operación falló: $out"; fi
  fi
  # 3. Las demás bases: prohibidas para este rol.
  local denied=0 total=0 other
  for other in "${ALL[@]}" postgres pay_test; do
    [ "$other" = "$short" ] && continue
    local db="$other"; [ "$other" != postgres ] && [ "$other" != pay_test ] && db="pay_${other}"
    total=$((total+1))
    local res; res=$(psql -h "$HOST" -p "$PORT" -U "$role" -d "$db" -tAc "select 1" 2>&1)
    if echo "$res" | grep -q "permission denied"; then denied=$((denied+1)); else fail "${role} pudo entrar a ${db}: ${res}"; fi
  done
  echo "PASS  ${role} NO entra a ${denied}/${total} bases ajenas (todas: permission denied). Ejemplo: $(psql -h "$HOST" -p "$PORT" -U "$role" -d pay_ledger -tAc 'select 1' 2>&1 | head -1)"
  # 4. Limpieza.
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  "${psql_base[@]}" -c "DROP SCHEMA IF EXISTS $schema CASCADE" >/dev/null 2>&1
  rm -f "$log"
  unset PGPASSWORD
}

FUT=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
check_service pay-connectors "" 'code=$(curl -s -o /dev/null -w "%{http_code}" -H "x-service-id: pay-payments" -H "x-pay-mode: test" "http://127.0.0.1:$port/connectors/health"); [ "$code" = 200 ] && echo "OK GET /connectors/health = 200 (lee connector_health en SU base)" || echo "HTTP $code"'
check_service pay-qr "" 'code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "content-type: application/json" -H "x-service-id: pay-connectors" -H "x-pay-mode: test" -H "idempotency-key: sep-$$-key-padding" -d "{\"kind\":\"dynamic\",\"merchant_id\":\"mc_clinicasantacruz1\",\"merchant_name\":\"Clinica\",\"merchant_city\":\"Santa Cruz\",\"currency\":\"BOB\",\"amount_minor\":10000,\"payment_intent_id\":\"pi_sep$$00000001\",\"expires_at\":\"'"$FUT"'\"}" "http://127.0.0.1:$port/qr"); [ "$code" = 201 ] && echo "OK POST /qr = 201 (escribe qr_codes e idempotency_keys en SU base)" || echo "HTTP $code"'
check_service pay-mockbank "" 'code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "content-type: application/json" -H "x-service-id: pay-connectors" -H "x-pay-mode: test" -d "{\"reference\":\"ch_sep$$00000001\",\"amount_minor\":10000,\"currency\":\"BOB\",\"method\":\"qr\",\"expires_at\":\"'"$FUT"'\"}" "http://127.0.0.1:$port/sandbox/charges"); [ "$code" = 201 ] && echo "OK POST /sandbox/charges = 201 (escribe mb_charges en SU base)" || echo "HTTP $code"'

echo
if [ $bad -eq 0 ]; then echo "RESULTADO: PASS — los tres servicios arrancan y operan con su propio rol, que no entra a ninguna otra base."; else echo "RESULTADO: FALLA — ${bad} problema(s)"; fi
[ $bad -eq 0 ]
