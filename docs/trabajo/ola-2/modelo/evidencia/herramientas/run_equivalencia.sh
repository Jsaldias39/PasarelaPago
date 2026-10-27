#!/usr/bin/env bash
# Equivalencia del SQL generado por el modelo (SQL/pay/*/ddl.sql) contra el SQL de referencia del monorepo, servicio por servicio.
# Uso (desde la raíz del monorepo): docs/trabajo/ola-2/modelo/evidencia/herramientas/run_equivalencia.sh [servicio ...]
# Las listas de archivos de referencia son las que aplican las pruebas de cada servicio (ver comentarios).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
MODEL="${MODEL_REPO:-$ROOT/../mantra-core-health-model}/SQL/pay"
T="$ROOT/docs/trabajo/ola-2/modelo/evidencia/herramientas/pay_catalog_diff.py"
OUTDIR="$ROOT/docs/trabajo/ola-2/modelo/evidencia/equivalencia"
mkdir -p "$OUTDIR"
OB="$ROOT/contracts/packages/outbox/sql/001_outbox_inbox.sql"
ID="$ROOT/contracts/packages/idempotency/sql/001_idempotency_keys.sql"
declare -A NUM=([connectors]=70 [edge]=71 [ledger]=72 [merchants]=73 [payments]=74 [qr]=75 [risk]=76 [schedules]=77 [settlement]=78 [vault]=79 [webhooks]=80 [lib]=81)
# servicio -> libs que su base aplica según sus pruebas
declare -A LIBS=([connectors]="$ID $OB" [edge]="" [ledger]="$OB $ID" [merchants]="$OB $ID" [payments]="$ID $OB" [qr]="$ID" [risk]="$ID" [schedules]="$OB $ID" [settlement]="$OB $ID" [vault]="$ID" [webhooks]="$ID" [lib]="$OB $ID")
SVCS=("$@"); [ ${#SVCS[@]} -eq 0 ] && SVCS=(connectors edge ledger merchants payments qr risk schedules settlement vault webhooks lib)
rc=0
for s in "${SVCS[@]}"; do
  # orden como en las pruebas: las de risk/vault/qr/webhooks aplican primero la idempotencia y luego el SQL propio; da igual para el catálogo
  own=("$ROOT/services/pay-$s/sql/"*.sql); [ "$s" = lib ] && own=()   # pay_lib: la referencia son los dos .sql de las librerías
  python3 "$T" --label "$s" --a "${own[@]}" ${LIBS[$s]} --b "$MODEL/${NUM[$s]}_pay_$s/ddl.sql" --b-twice --json "$OUTDIR/$s.json" || rc=1
  echo
done
exit $rc
