#!/usr/bin/env bash
# Genera un servicio desde la plantilla, lo verifica de verdad (tipos, build, pruebas de arranque contra Postgres,
# proceso real con /health) y lo borra. Sirve de evidencia de P1.H1.M2 y de guardia: si la plantilla se rompe, esto falla.
# Requiere el stack local arriba (postgres) y `yarn build` de las librerías hecho.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
NAME=pay-probe; PORT=3198
# Ruta absoluta: el script hace `cd` al servicio, y una ruta relativa dejaba el servicio de prueba como workspace.
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; cd "$ROOT" && rm -rf "$ROOT/services/$NAME" && yarn install >/dev/null 2>&1; }
trap cleanup EXIT
step() { echo; echo "=== $*"; }
fail() { echo "FALLA: $*"; exit 1; }

step "generar services/$NAME"; platform/scripts/new-service.sh "$NAME" "$PORT" || fail "new-service.sh"
step "yarn install"; yarn install 2>&1 | grep -E "YN0001|YN0002|Done" || true
export DB_HOST=127.0.0.1 DB_PORT=54321 DB_NAME=pay_test DB_USER=postgres DB_PASSWORD=pay NATS_URL=nats://127.0.0.1:54222
cd "services/$NAME"
step "typecheck"; yarn typecheck && echo "typecheck: exit 0" || fail "typecheck"
step "build"; rm -rf dist; yarn build && echo "build: exit 0" || fail "build"
step "pruebas de arranque"; yarn test 2>&1 | grep -E "Tests:|Test Suites:|✕" ; [ "${PIPESTATUS[0]}" -eq 0 ] || fail "test"
step "proceso real (node dist/main.js)"
PORT=$PORT node dist/main.js > /tmp/$NAME.log 2>&1 &
PID=$!
for _ in $(seq 1 30); do curl -sf "localhost:$PORT/health/live" >/dev/null && break; sleep 1; done
echo "GET /health/live  -> $(curl -s localhost:$PORT/health/live)"
echo "GET /health/ready -> $(curl -s localhost:$PORT/health/ready | cut -c1-80)"
echo "GET /nada (x-request-id: req-demo-12345) -> $(curl -s -H 'x-request-id: req-demo-12345' localhost:$PORT/nada)"
curl -sf "localhost:$PORT/health/ready" >/dev/null || fail "ready no respondió"
echo; echo "PLANTILLA OK"
