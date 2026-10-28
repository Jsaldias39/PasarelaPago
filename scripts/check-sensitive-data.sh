#!/usr/bin/env bash
# Gate «Datos sensibles» (PLAN-MAESTRO §7) para pay-ledger y pay-settlement: sin PAN, CVV, documento ni nombre en logs, trazas, eventos ni errores.
#   Etapa estática: grep sobre el código, el SQL y los contratos de eventos de los dos servicios (debe dar 0 coincidencias en cada regla).
#   Etapa dinámica: corre `test/sensitive-data.spec.ts` de cada servicio, que mete valores CANARIO por todas las puertas y busca lo que el servicio
#   produjo (logs, respuestas de error, eventos del outbox, filas de la base).
# Requisitos de la etapa dinámica: Postgres del Compose (54321) y TigerBeetle (platform/scripts/tigerbeetle-dev.sh start). Datos 100 % sintéticos.
# Uso: scripts/check-sensitive-data.sh [--static | --self-test]
#   --static     se salta la etapa dinámica
#   --self-test  control negativo: planta datos sensibles en un directorio temporal y comprueba que cada regla estática los detecta (salida 0 = las reglas no están mudas)
# Salida 0 = limpio.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
SERVICES=(services/pay-ledger services/pay-settlement)
if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/src"
  cat > "$tmp/src/malo.ts" <<'TS'
console.log('hola');
this.logger.error({ body }, 'x');
const cvv = '737';
const pan = '4111111111111111';
TS
  fails=0
  check() { grep -rnEI --include='*.ts' -e "$2" "$tmp/src" >/dev/null && echo "detecta  $1" || { echo "NO DETECTA $1"; fails=$((fails+1)); }; }
  check "console.*" 'console\.(log|info|warn|error|debug|trace)'
  check "log con cuerpo" "logger\.(error|warn|log|debug|verbose)\([^;]*\b(body|dto|payload|request|statement|line|lines|description|glosa)\b"
  check "campo cvv/pan" '\b(pan|card_?number|cvv2?|cvc2?)\b'
  check "literal de PAN" "(^|[^0-9a-zA-Z_])[0-9]{15,19}([^0-9]|$)"
  [ "$fails" -eq 0 ] && echo "self-test: las reglas detectan lo plantado" ; exit "$fails"
fi
SRC=(); SQL=()
for s in "${SERVICES[@]}"; do SRC+=("$s/src"); SQL+=("$s/sql"); done
CONTRACTS=(contracts/asyncapi/ledger-settlement.yaml contracts/openapi/internal-ledger-v1.yaml contracts/openapi/internal-settlement-v1.yaml)
bad=0

rule() { # rule "<descripción>" <patrón> <rutas...>   (0 coincidencias = PASS)
  local what="$1" pattern="$2"; shift 2
  local hits; hits=$(grep -rnEI --include='*.ts' --include='*.sql' --include='*.yaml' -e "$pattern" "$@" 2>/dev/null || true)
  if [ -z "$hits" ]; then echo "PASS  $what"; else echo "FALLA $what"; echo "$hits" | sed 's/^/        /'; bad=$((bad+1)); fi
}

echo "== Etapa estática =="
rule "ningún console.* en el código desplegado (src)" 'console\.(log|info|warn|error|debug|trace)' "${SRC[@]}"
rule "ningún log vuelca cuerpos, DTO, extractos ni glosas (logger.*(… body|dto|payload|req|statement|line|description …))" "logger\.(error|warn|log|debug|verbose)\([^;]*\b(body|dto|payload|request|statement|line|lines|description|glosa)\b" "${SRC[@]}"
rule "ningún campo de tarjeta, titular ni documento en el código ni en el SQL (pan, card_number, cvv, cvc, holder, full/first/last_name, document_number, national_id)" '\b(pan|card_?number|cvv2?|cvc2?|card_?holder|holder_?name|full_?name|first_?name|last_?name|document_?number|national_?id)\b' "${SRC[@]}" "${SQL[@]}"
rule "ningún campo de tarjeta, titular ni documento en los contratos de eventos y de API internos de P2" '\b(pan|card_?number|cvv2?|cvc2?|card_?holder|holder_?name|full_?name|first_?name|last_?name|document_?number|national_?id)\b' "${CONTRACTS[@]}"
rule "ningún literal de 15 a 19 dígitos (con forma de PAN) en el código ni en el SQL" "(^|[^0-9a-zA-Z_])[0-9]{15,19}([^0-9]|$)" "${SRC[@]}" "${SQL[@]}"
rule "la telemetría no activa captura de sentencias con valores ni ganchos que copien cuerpos" 'enhancedDatabaseReporting|requestHook|responseHook|setAttribute\(' services/pay-ledger/src/observability services/pay-settlement/src/observability
# La glosa del banco (puede traer titular, documento o PAN) se descarta al leer el extracto: tiene que seguir descartándose.
if grep -q 'delete rest.description' services/pay-settlement/src/settlement/statement-parsers.ts && grep -q 'description' services/pay-settlement/src/settlement/statement-parsers.ts; then echo "PASS  el importador descarta la glosa (description) del extracto"; else echo "FALLA el importador ya no descarta la glosa"; bad=$((bad+1)); fi

if [ "${1:-}" != "--static" ]; then
  echo; echo "== Etapa dinámica (canarios en logs, respuestas de error, eventos y filas) =="
  for s in "${SERVICES[@]}"; do
    echo "-- $s: test/sensitive-data.spec.ts"
    out=$(cd "$s" && yarn test --maxWorkers=2 sensitive-data 2>&1); rc=$?
    echo "$out" | grep -E "^(Tests|Test Suites):"
    if [ $rc -ne 0 ]; then echo "FALLA la etapa dinámica de $s"; echo "$out" | grep -vE '^\{"level' | tail -30; bad=$((bad+1)); fi
  done
fi
echo
if [ "$bad" -eq 0 ]; then echo "datos sensibles: LIMPIO (0 fallas)"; else echo "datos sensibles: $bad regla(s) con coincidencias"; fi
[ "$bad" -eq 0 ]
