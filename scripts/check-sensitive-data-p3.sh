#!/usr/bin/env bash
# Gate «Datos sensibles» (PLAN-MAESTRO §7) para pay-payments y pay-vault: sin PAN, CVV, documento ni nombre en logs, trazas, eventos ni errores.
#   Etapa estática: grep sobre el código y el SQL (0 coincidencias por regla, o solo en los archivos permitidos de la lista).
#   Etapa dinámica: corre las pruebas de canarios de cada servicio (logs, respuestas de error, eventos del outbox, llamadas salientes, filas de la base, bytes OTLP de las trazas).
# Requisitos de la etapa dinámica: Postgres, NATS y Temporal del Compose; `yarn build` hecho (algunas pruebas levantan dist/main.js). Datos 100 % sintéticos.
# Uso: scripts/check-sensitive-data-p3.sh [--static | --self-test]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
if [ "${1:-}" = "--self-test" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/src"
  cat > "$tmp/src/malo.ts" <<'TS'
console.log('hola');
this.logger.error({ payerName }, 'x');
this.logger.warn({ legal_name: row.legal_name }, 'x');
const pan = '4111111111111111';
const cardNumber = 'x';
TS
  fails=0
  check() { grep -rnEIi --include='*.ts' -e "$2" "$tmp/src" >/dev/null && echo "detecta  $1" || { echo "NO DETECTA $1"; fails=$((fails+1)); }; }
  check "console.*" 'console\.(log|info|warn|error|debug|trace)'
  check "log con nombre del pagador o razón social" "logger\.(error|warn|log|debug|verbose)\([^;]*\b(payerName|payer_name|legalName|legal_name|body|dto|payload|request)\b"
  check "literal de PAN" "(^|[^0-9a-zA-Z_])[0-9]{15,19}([^0-9]|$)"
  check "campo cardNumber" '\b(card_?number|cvv2?|cvc2?)\b'
  [ "$fails" -eq 0 ] && echo "self-test: las reglas detectan lo plantado"; exit "$fails"
fi
PAY=services/pay-payments; VAULT=services/pay-vault
bad=0
rule() { # rule "<descripción>" <patrón> <rutas...>   (0 coincidencias = PASS)
  local what="$1" pattern="$2"; shift 2
  local hits; hits=$(grep -rnEIi --include='*.ts' --include='*.sql' --exclude='*.spec.ts' -e "$pattern" "$@" 2>/dev/null || true)
  if [ -z "$hits" ]; then echo "PASS  $what"; else echo "FALLA $what"; echo "$hits" | sed 's/^/        /'; bad=$((bad+1)); fi
}
echo "== Etapa estática =="
rule "ningún console.* en el código desplegado (src)" 'console\.(log|info|warn|error|debug|trace)' $PAY/src $VAULT/src
rule "ningún log vuelca cuerpos, DTO, nombre del pagador ni razón social (logger.*(… body|dto|payload|request|payerName|legalName …))" "logger\.(error|warn|log|debug|verbose)\([^;]*\b(body|dto|payload|request|payerName|payer_name|legalName|legal_name|cardNumber|holderName)\b" $PAY/src $VAULT/src
rule "ningún literal de 15 a 19 dígitos (con forma de PAN) en el código ni en el SQL" "(^|[^0-9a-zA-Z_])[0-9]{15,19}([^0-9]|$)" $PAY/src $PAY/sql $VAULT/src $VAULT/sql
rule "pay-payments no tiene campos de tarjeta, titular ni CVV (card_number, cvv, cvc, holder_name)" '\b(card_?number|cvv2?|cvc2?|card_?holder|holder_?name)\b' $PAY/src $PAY/sql
rule "el SQL de pay-vault no tiene columnas de PAN, CVV ni titular (solo metadatos del token)" '\b(pan|card_?number|cvv2?|cvc2?|card_?holder|holder_?name|full_?name)\b' $VAULT/sql
rule "la telemetría no activa captura de sentencias con valores ni ganchos que copien cuerpos" 'enhancedDatabaseReporting|requestHook|responseHook|setAttribute\(' $PAY/src/observability $VAULT/src/observability
# payer_name / legal_name: solo en los archivos que los usan por diseño (D-29/D-33); nunca en el log de acceso, el filtro de errores, los serializadores ni los eventos.
allowed='^services/pay-payments/src/(persistence/(intents|replicas)\.repo\.ts|persistence/schema-map\.ts|temporal/activities\.ts|events/handlers\.ts|clients/risk\.client\.ts|payments/validation\.ts|payments/payments\.service\.ts)$'
files=$(grep -rlE '\b(payer_?name|payerName|legal_?name|legalName)\b' $PAY/src $VAULT/src 2>/dev/null | sort)
outside=$(echo "$files" | grep -vE "$allowed" || true)
if [ -z "$outside" ]; then echo "PASS  payer_name/legal_name solo aparecen en los $(echo "$files" | grep -c .) archivos permitidos"; else echo "FALLA payer_name/legal_name fuera de la lista permitida:"; echo "$outside" | sed 's/^/        /'; bad=$((bad+1)); fi
# La ruta se enmascara en el log de acceso, en `instance` y en los spans.
for s in $PAY $VAULT; do
  if grep -q "safeUrl" $s/src/app.module.ts && grep -q "safeUrl" $s/src/problem.filter.ts && grep -q "MaskingTraceExporter" $s/src/observability/telemetry.ts; then echo "PASS  $s enmascara la ruta (log de acceso, instance, spans)"; else echo "FALLA $s no enmascara la ruta en los tres lugares"; bad=$((bad+1)); fi
done

if [ "${1:-}" != "--static" ]; then
  echo; echo "== Etapa dinámica (canarios en logs, respuestas de error, eventos, llamadas salientes, filas y bytes OTLP) =="
  run() { # run <servicio> <patrones...>
    local s="$1"; shift
    echo "-- $s: $*"
    out=$(cd "$s" && yarn test --maxWorkers=2 "$@" 2>&1); rc=$?
    echo "$out" | grep -E "^(Tests|Test Suites):"
    if [ $rc -ne 0 ]; then echo "FALLA la etapa dinámica de $s"; echo "$out" | grep -vE '^\{"level' | tail -30; bad=$((bad+1)); fi
  }
  run $PAY sensitive-data pan-leak path-sensitive redact
  run $VAULT pan-leak path-sensitive redact
fi
echo
if [ "$bad" -eq 0 ]; then echo "datos sensibles: LIMPIO (0 fallas)"; else echo "datos sensibles: $bad regla(s) con coincidencias"; fi
[ "$bad" -eq 0 ]
