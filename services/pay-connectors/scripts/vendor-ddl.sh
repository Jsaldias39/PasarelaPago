#!/usr/bin/env bash
# Vendoriza el DDL de pay-connectors desde el modelo (D-18): la ÚNICA fuente del esquema es el modelo (`mantra-core-health-model`, SQL/pay/70_pay_connectors/ddl.sql, generado
# de los .puml). Este servicio no escribe DDL a mano (regla 97.1): copia el generado a `sql/ddl.sql`.
#   scripts/vendor-ddl.sh           copia el ddl.sql del modelo a sql/ddl.sql
#   scripts/vendor-ddl.sh --check   compara la copia con el modelo; sale con 1 si difieren. Si el repo hermano NO está, avisa y sale con 0 (CI sin el modelo).
# El repo del modelo se busca en ../../../mantra-core-health-model (hermano del monorepo); cambiarlo con MODEL_REPO=/ruta.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
MODEL=${MODEL_REPO:-"$HERE/../../../mantra-core-health-model"}
SRC="$MODEL/SQL/pay/70_pay_connectors/ddl.sql"
DST="$HERE/sql/ddl.sql"
if [ ! -f "$SRC" ]; then
  if [ "${1:-}" = "--check" ]; then echo "vendor-ddl --check: el repo del modelo no está en $MODEL; no se puede comparar (omitido, sin falla)"; exit 0; fi
  echo "vendor-ddl: no existe $SRC (¿MODEL_REPO?)" >&2; exit 1
fi
COMMIT=$(git -C "$MODEL" rev-parse --short HEAD 2>/dev/null || echo desconocido)
if [ "${1:-}" = "--check" ]; then
  if [ -f "$DST" ] && diff -q --strip-trailing-cr "$SRC" "$DST" >/dev/null; then echo "vendor-ddl --check: sql/ddl.sql coincide con el modelo ($COMMIT, 70_pay_connectors)"; exit 0; fi
  echo "vendor-ddl --check: sql/ddl.sql DIFIERE del modelo ($COMMIT, 70_pay_connectors); ejecutá scripts/vendor-ddl.sh" >&2; diff --strip-trailing-cr "$SRC" "$DST" 2>&1 | head -20 >&2 || true; exit 1
fi
cp "$SRC" "$DST"
echo "vendor-ddl: sql/ddl.sql copiado de 70_pay_connectors (modelo $COMMIT)"
