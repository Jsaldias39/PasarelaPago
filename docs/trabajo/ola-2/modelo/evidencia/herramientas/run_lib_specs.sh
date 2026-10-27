#!/usr/bin/env bash
# Pruebas de las librerías @pay/outbox, @pay/idempotency y @pay/orm-queryable contra el SQL GENERADO de pay_lib (81), en una copia mínima.
# Uso (desde la raíz del monorepo): run_lib_specs.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
MODEL="${MODEL_REPO:-$ROOT/../mantra-core-health-model}/SQL/pay/81_pay_lib/ddl.sql"
S="${SCRATCH_DIR:-$(mktemp -d)}"; if [ -z "${KEEP:-}" ]; then trap 'rm -rf "$S"' EXIT; fi
mkdir -p "$S"; ln -s "$ROOT/node_modules" "$S/node_modules"
cp "$ROOT/package.json" "$ROOT/jest.base.cjs" "$ROOT/tsconfig.base.json" "$S/"
mkdir -p "$S/contracts"; tar -C "$ROOT/contracts" -cf - . | tar -C "$S/contracts" -xf -
cp "$MODEL" "$S/contracts/packages/outbox/sql/001_outbox_inbox.sql"
cp "$MODEL" "$S/contracts/packages/idempotency/sql/001_idempotency_keys.sql"
echo "== libs: pruebas contra el SQL GENERADO ($MODEL, sha256 $(sha256sum "$MODEL" | cut -c1-16))"
rc=0
for p in outbox idempotency orm-queryable; do
  echo "-- @pay/$p"
  (cd "$S/contracts/packages/$p" && node --experimental-vm-modules ../../../node_modules/jest-cli/bin/jest.js --config jest.config.cjs --maxWorkers=1 --colors=false 2>&1 | grep -E "^(PASS|FAIL) |Tests:|Test Suites:|●.*›") || rc=1
done
exit $rc
