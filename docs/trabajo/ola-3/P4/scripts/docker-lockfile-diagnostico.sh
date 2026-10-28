#!/usr/bin/env bash
# Diagnóstico del GAP del Dockerfile (P1): por qué `yarn install --immutable` falla dentro de `docker build` con YN0028.
# Reproduce, EN UNA COPIA FUERA DEL REPO, lo que hace la etapa de construcción: (A) copiar solo contracts/packages + el servicio; (B) copiar además el
# package.json de los otros servicios. No toca el repo ni usa Docker. Uso: docker-lockfile-diagnostico.sh [pay-qr]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd); SVC=${1:-pay-qr}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$ROOT" && cp -r .yarn "$TMP/.yarn" && rm -f "$TMP/.yarn/install-state.gz" && cp .yarnrc.yml package.json yarn.lock tsconfig.base.json "$TMP/"
mkdir -p "$TMP/contracts" "$TMP/services/$SVC" && cp -r contracts/packages "$TMP/contracts/packages" && rm -rf "$TMP"/contracts/packages/*/node_modules "$TMP"/contracts/packages/*/dist && cp "services/$SVC/package.json" "$TMP/services/$SVC/"
cd "$TMP"
echo "== A) como el Dockerfile de producción: SOLO contracts/packages + services/$SVC (workspaces en el lockfile: $(grep -c '@workspace:' "$ROOT/yarn.lock"))"
timeout 120 node .yarn/releases/yarn-4.14.1.cjs install --immutable --mode=skip-build 2>&1 | grep -E "YN0028|Resolution step|Fetch step|YN0000: ·" | head -4
echo "== B) con el package.json de los OTROS servicios copiado también"
for d in "$ROOT"/services/*/; do n=$(basename "$d"); mkdir -p "services/$n"; cp "$d/package.json" "services/$n/"; done
timeout 25 node .yarn/releases/yarn-4.14.1.cjs install --immutable --mode=skip-build 2>&1 | grep -E "YN0028|Resolution step|Fetch step|YN0000: ·" | head -4
echo "(en B la resolución pasa y empieza la descarga; se corta a los 25 s: lo que se demuestra es que YN0028 desaparece)"
