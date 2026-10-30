#!/usr/bin/env bash
# Vendoriza el DDL de pay-webhooks desde el repo del modelo (D-18): `SQL/pay/80_pay_webhooks/ddl.sql` -> `sql/ddl.sql`.
#   scripts/vendor-model-sql.sh           copia el ddl.sql del modelo (y anota de qué commit salió en sql/ddl.sql.source)
#   scripts/vendor-model-sql.sh --check   verifica que la copia sea idéntica; si el repo hermano no existe, avisa y sale 0
# El repo del modelo se busca en $MODEL_REPO o en ../mantra-core-health-model (hermano de la raíz de este monorepo).
set -euo pipefail
SVC=webhooks
NUM=80
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
model="${MODEL_REPO:-$root/../mantra-core-health-model}"
src="$model/SQL/pay/${NUM}_pay_${SVC}/ddl.sql"
dst="$here/sql/ddl.sql"
meta="$here/sql/ddl.sql.source"

if [ ! -f "$src" ]; then
  if [ "${1:-}" = "--check" ]; then
    echo "SKIP: no está el repo del modelo ($src); no se puede verificar la copia vendorizada (sin fallar)."
    exit 0
  fi
  echo "ERROR: no está $src (definí MODEL_REPO)." >&2
  exit 1
fi

if [ "${1:-}" = "--check" ]; then
  if diff -q --strip-trailing-cr "$src" "$dst" >/dev/null; then
    echo "OK: sql/ddl.sql idéntico a $src"
    exit 0
  fi
  echo "DESFASADA: sql/ddl.sql difiere de $src; corré scripts/vendor-model-sql.sh" >&2
  diff --strip-trailing-cr "$src" "$dst" | head -20 >&2 || true
  exit 1
fi

cp "$src" "$dst"
commit="$(git -C "$model" rev-parse --short HEAD 2>/dev/null || echo desconocido)"
dirty="limpio"
if [ -n "$(git -C "$model" status --porcelain -- "SQL/pay/${NUM}_pay_${SVC}" 2>/dev/null)" ]; then dirty="CON CAMBIOS SIN COMMIT en esa carpeta"; fi
{
  echo "modelo: mantra-core-health-model"
  echo "commit: $commit ($dirty)"
  echo "origen: SQL/pay/${NUM}_pay_${SVC}/ddl.sql"
  echo "sha256: $(sha256sum "$dst" | cut -d' ' -f1)"
} > "$meta"
echo "Copiado $src -> $dst (modelo $commit, $dirty)"
