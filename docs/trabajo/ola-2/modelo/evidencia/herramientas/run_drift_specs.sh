#!/usr/bin/env bash
# Corre los verificadores de deriva REALES de los servicios (drift.spec: SQL aplicado ↔ base ↔ mapa del código) contra el SQL
# GENERADO por el modelo, sin tocar los servicios: arma una copia mínima del monorepo en un directorio temporal y en ella
# reemplaza sql/001_*.sql por SQL/pay/<NN>_pay_<svc>/ddl.sql. Con BASELINE=1 corre contra el SQL de referencia (control).
# Uso (desde la raíz del monorepo): run_drift_specs.sh [servicio ...]   (por defecto: ledger payments settlement vault)
# Con FULL=1 corre la SUITE COMPLETA del servicio (no solo la de deriva) contra el SQL generado: prueba de comportamiento.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
MODEL="${MODEL_REPO:-$ROOT/../mantra-core-health-model}/SQL/pay"
declare -A NUM=([connectors]=70 [edge]=71 [ledger]=72 [merchants]=73 [payments]=74 [qr]=75 [risk]=76 [schedules]=77 [settlement]=78 [vault]=79 [webhooks]=80)
declare -A SPEC=([ledger]=test/drift.spec.ts [payments]=test/schema.drift.spec.ts [settlement]=test/drift.spec.ts [vault]=test/schema.drift.spec.ts)
SVCS=("$@"); [ ${#SVCS[@]} -eq 0 ] && SVCS=(ledger payments settlement vault)
SCRATCH="${SCRATCH_DIR:-$(mktemp -d)}"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/services"
ln -s "$ROOT/node_modules" "$SCRATCH/node_modules"
cp "$ROOT/package.json" "$ROOT/jest.base.cjs" "$ROOT/tsconfig.base.json" "$SCRATCH/"
copy() { mkdir -p "$2"; tar -C "$1" -cf - . | tar -C "$2" -xf -; }
copy "$ROOT/contracts" "$SCRATCH/contracts"
# EXTRA="mockbank ..." copia además esos servicios (las specs de punta a punta de pay-connectors levantan pay-mockbank real).
# (con su dist/, que es lo que esas specs arrancan con `node dist/main.js`)
for x in ${EXTRA:-}; do mkdir -p "$SCRATCH/services/pay-$x"; tar -C "$ROOT/services/pay-$x" -cf - . | tar -C "$SCRATCH/services/pay-$x" -xf -; done
rc=0
for s in "${SVCS[@]}"; do
  copy "$ROOT/services/pay-$s" "$SCRATCH/services/pay-$s"
  f=$(ls "$SCRATCH/services/pay-$s/sql/"*.sql)
  if [ -z "${BASELINE:-}" ]; then cp "$MODEL/${NUM[$s]}_pay_$s/ddl.sql" "$f"; echo "== $s: drift.spec contra SQL GENERADO ($MODEL/${NUM[$s]}_pay_$s/ddl.sql, sha256 $(sha256sum "$f" | cut -c1-16))";
  else echo "== $s: drift.spec contra SQL de REFERENCIA (control)"; fi
  args=(); [ -z "${FULL:-}" ] && args=("${SPEC[$s]}")
  # FULL=1: las specs que compilan y arrancan el servicio (`yarn build` + `node dist/main.js`) no corren en la copia mínima (sin la cadena de build): IGNORE las excluye.
  [ -n "${FULL:-}" ] && [ -n "${ONLY:-}" ] && args+=("$ONLY")
  [ -n "${FULL:-}" ] && [ -n "${IGNORE:-}" ] && args+=(--testPathIgnorePatterns "$IGNORE")
  (cd "$SCRATCH/services/pay-$s" && node --experimental-vm-modules ../../node_modules/jest-cli/bin/jest.js --config jest.config.cjs "${args[@]}" --maxWorkers=1 --colors=false 2>&1 | grep -v "ExperimentalWarning\|--trace-warnings") || rc=1
done
exit $rc
