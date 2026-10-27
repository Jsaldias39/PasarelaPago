#!/usr/bin/env bash
# Corre los gates de la ola 0 y guarda el comando y la salida LITERAL de cada uno.
# Uso: platform/scripts/collect-evidence.sh docs/trabajo/ola-0/evidencia   (con el stack local arriba)
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?uso: collect-evidence.sh <directorio>}; mkdir -p "$OUT"
run() { # archivo, comando...
  local file="$OUT/$1"; shift
  { echo "\$ $*"; echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo; "$@" 2>&1; echo; echo "# exit=$?"; } > "$file"
  # el exit de arriba es el de `echo`; se recalcula bien abajo
}
runx() { local file="$OUT/$1"; shift; local out; out=$("$@" 2>&1); local rc=$?; { echo "\$ $*"; echo "# $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo; echo "$out"; echo; echo "# exit=$rc"; } > "$file"; echo "$1 -> exit=$rc"; }

runx P1.H1.M1-compose.txt bash -c 'docker compose -f platform/compose.yml config -q && echo "compose config: OK" && docker compose -f platform/compose.yml ps --format "table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}"'
runx P1.H1.M2-plantilla.txt platform/scripts/verify-template.sh
runx P1.H1.M3-money.txt yarn workspace @pay/money test --verbose
runx P1.H1.M4-problem.txt yarn workspace @pay/problem test --verbose
runx P1.H1.M5-idempotency.txt bash -c 'yarn workspace @pay/idempotency test --verbose; for i in 1 2 3 4 5 6; do echo "corrida repetida $i: $(yarn workspace @pay/idempotency test 2>&1 | grep -E "^Tests:")"; done'
runx P1.H1.M6-webhook-signature.txt yarn workspace @pay/webhook-signature test --verbose
runx P1.H1.M7-contratos.txt yarn contracts:lint
runx P1.H1.M8-separacion.txt platform/scripts/check-db-separation.sh
runx outbox-tests.txt bash -c '
 yarn workspace @pay/outbox test --verbose
 cd contracts/packages/outbox; cp src/nats.ts /tmp/nats.ts.bak; cp src/outbox.ts /tmp/outbox.ts.bak
 echo; echo "=== mutación 1: sin Nats-Msg-Id (la deduplicación debe fallar)"
 sed -i "s/{ msgID: event.id, headers: h }/{ headers: h }/" src/nats.ts; yarn test 2>&1 | grep -E "✕|^Tests:"; cp /tmp/nats.ts.bak src/nats.ts
 echo "=== mutación 2: sin candado de asesoría (dos relés deben desordenar o duplicar)"
 sed -i "s/if (!lock.rows\[0\]?.ok) {/if (false) {/" src/outbox.ts; yarn test 2>&1 | grep -E "✕|^Tests:"; cp /tmp/outbox.ts.bak src/outbox.ts
 echo "=== restaurado"; yarn test 2>&1 | grep -E "^Tests:"'
runx gate-typecheck.txt yarn typecheck
runx gate-lint.txt yarn lint
runx gate-build.txt yarn build
runx gate-test.txt yarn test
