#!/usr/bin/env bash
# Vendoriza el DDL generado por el modelo (D-18: el modelo es la ÚNICA fuente del esquema) en pay-ledger y pay-settlement.
#   scripts/vendor-model-sql.sh            copia SQL/pay/<NN>_pay_<svc>/ddl.sql del repo del modelo a services/pay-<svc>/sql/ddl.sql
#   scripts/vendor-model-sql.sh --check    compara la copia contra el modelo; sale 1 si difieren
# El repo del modelo se busca en $MODEL_REPO o, por defecto, en ../mantra-core-health-model (hermano de este repo). Si NO existe, --check no falla
# (avisa que no pudo comparar): en Docker/CI el monorepo se construye sin el repo hermano. La copia NO se edita a mano: se regenera con este script.
# Alcance: solo los servicios de P2 (ledger=72, settlement=78). Los demás servicios los vendoriza su dueño.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODEL=${MODEL_REPO:-$ROOT/../mantra-core-health-model}
declare -A NUM=([ledger]=72 [settlement]=78)
mode=${1:-copy}
if [ "$mode" != "copy" ] && [ "$mode" != "--check" ]; then echo "uso: $0 [--check]" >&2; exit 2; fi
if [ ! -d "$MODEL/SQL/pay" ]; then
  if [ "$mode" = "--check" ]; then echo "SKIP  no hay repo del modelo en $MODEL: no se puede comparar (no es un fallo)"; exit 0; fi
  echo "ERROR no hay repo del modelo en $MODEL (definí MODEL_REPO)" >&2; exit 1
fi
commit=$(git -C "$MODEL" rev-parse --short HEAD 2>/dev/null || echo "sin-git")
dirty=$(git -C "$MODEL" status --porcelain -- SQL/pay 2>/dev/null | head -1)
echo "modelo: $MODEL @ $commit${dirty:+ (con cambios sin commit en SQL/pay)}"
bad=0
for svc in ledger settlement; do
  src="$MODEL/SQL/pay/${NUM[$svc]}_pay_$svc/ddl.sql"; dst="$ROOT/services/pay-$svc/sql/ddl.sql"
  if [ ! -f "$src" ]; then echo "ERROR falta $src" >&2; bad=$((bad+1)); continue; fi
  if [ "$mode" = "--check" ]; then
    if diff -q --strip-trailing-cr "$src" "$dst" >/dev/null 2>&1; then echo "PASS  pay-$svc: sql/ddl.sql coincide con el modelo ($(wc -l < "$dst") líneas)"; else echo "FALLA pay-$svc: sql/ddl.sql difiere del modelo (o no existe): corré scripts/vendor-model-sql.sh"; bad=$((bad+1)); fi
  else
    cp "$src" "$dst" && echo "copiado pay-$svc: $(wc -l < "$dst") líneas  <-  SQL/pay/${NUM[$svc]}_pay_$svc/ddl.sql"
  fi
done
[ "$bad" -eq 0 ]
