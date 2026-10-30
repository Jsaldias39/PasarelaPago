#!/usr/bin/env bash
# Gate «Dockerfile» (PLAN-MAESTRO §7): `docker build` de la imagen de producción de cada servicio, SIN registro (nada se publica) y limpiando al terminar.
# 1. Construye la imagen REAL de cada servicio (su Dockerfile, contexto = raíz del repo) y muestra el resultado literal.
# 2. Como la construcción real depende del registro de paquetes y de una plantilla de P1, además comprueba el ESCENARIO DE EJECUCIÓN de la imagen
#    (Dockerfile.runtime-check: node:22-alpine, USER node, CMD node dist/main.js) corriendo el contenedor contra la base del Compose.
# Uso: docs/trabajo/ola-3/P4/scripts/gate-docker.sh        (borra al final TODAS las imágenes p4gate-* que creó)
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../../../../.." && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
HUB=${HUB:-mirror.gcr.io}
declare -A PORT=([pay-connectors]=3103 [pay-qr]=3104 [pay-mockbank]=3112)
declare -A ENVS=(
  [pay-connectors]="-e PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET=whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg== -e POLLER_INTERVAL_MS=0 -e HEALTH_INTERVAL_MS=0 -e RECONCILE_INTERVAL_MS=0 -e MOCK_PUMP_INTERVAL_MS=0"
  [pay-qr]="-e QR_ACCOUNT_GUID=e2e.sandbox.guid"
  [pay-mockbank]="-e MOCKBANK_WEBHOOK_SECRET=whsec_ZGV2LW9ubHktbW9jay1zZWNyZXQtMDEyMzQ1Njc4OWFiY2RlZg== -e MOCKBANK_DELIVERY_INTERVAL_MS=0"
)
bad=0
cd "$ROOT" || exit 1
echo "docker $(docker version --format '{{.Server.Version}}') · imagen base: ${HUB}/library/node:22-alpine"
disk() { echo "   disco (df -h /): $(df -h / | awk 'NR==2 {print "usado "$3" de "$2", libre "$4" ("$5")"}')"; }
echo "antes de empezar:"; disk
for svc in pay-connectors pay-qr pay-mockbank; do
  echo
  echo "══ ${svc} ══"
  echo "\$ docker build -f services/${svc}/Dockerfile --build-arg HUB=${HUB} -t p4gate-${svc}:prod ."
  out=$(docker build --progress=plain -f "services/${svc}/Dockerfile" --build-arg "HUB=${HUB}" -t "p4gate-${svc}:prod" . 2>&1); rc=$?
  echo "$out" | grep -E "^#[0-9]+ \[|DONE|ERROR|YN0028|YN0000: · |failed to build|CACHED" | sed 's/^/   /' | head -30
  if [ $rc -eq 0 ]; then echo "PASS  docker build de producción: exit 0"; else echo "GAP   docker build de producción: exit ${rc}"; bad=$((bad+1)); fi
  echo "\$ docker build -f docs/trabajo/ola-3/P4/scripts/Dockerfile.runtime-check --build-arg SVC=${svc}  (escenario de ejecución, sin registro)"
  if docker build -q -f "$HERE/Dockerfile.runtime-check" --build-arg "HUB=${HUB}" --build-arg "SVC=${svc}" -t "p4gate-runtime-${svc}:run" . >/dev/null 2>&1; then
    echo "PASS  imagen de ejecución construida: $(docker image inspect "p4gate-runtime-${svc}:run" --format '{{.Size}} bytes, usuario "{{.Config.User}}", cmd {{.Config.Cmd}}')"
    # El contenedor corre como `node` contra la base del Compose (red del host), con el rol de SU servicio, en un esquema descartable.
    short=${svc#pay-}; schema="dk_$$_${short}"
    export PGPASSWORD="dev_only_${short}"
    files=("$ROOT/services/$svc/sql/"*.sql);
    args=(-c "DROP SCHEMA IF EXISTS $schema CASCADE" -c "CREATE SCHEMA $schema" -c "SET search_path TO $schema"); for f in "${files[@]}"; do args+=(-f "$f"); done
    psql -h 127.0.0.1 -p 54321 -U "pay_${short}" -d "pay_${short}" -v ON_ERROR_STOP=1 -q "${args[@]}" >/dev/null 2>&1
    cid=$(docker run -d --rm --network host -e PORT="${PORT[$svc]}" -e DB_HOST=127.0.0.1 -e DB_PORT=54321 -e DB_NAME="pay_${short}" -e DB_USER="pay_${short}" -e DB_PASSWORD="dev_only_${short}" -e PGOPTIONS="-c search_path=$schema" -e PAY_MODE=sandbox -e LOG_LEVEL=warn ${ENVS[$svc]} "p4gate-runtime-${svc}:run")
    ok=0; for _ in $(seq 1 100); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT[$svc]}/health/ready")" = 200 ] && { ok=1; break; }; sleep 0.2; done
    if [ $ok -eq 1 ]; then
      echo "PASS  el contenedor arranca como usuario \"$(docker exec "$cid" id -un)\" y /health/ready = 200: $(curl -s "http://127.0.0.1:${PORT[$svc]}/health/ready" | head -c 80)"
      echo "      X-Pay-Mode de la respuesta: $(curl -s -D - -o /dev/null "http://127.0.0.1:${PORT[$svc]}/health/live" | tr -d '\r' | grep -i '^x-pay-mode')"
    else echo "FALLA el contenedor no llegó a estar listo:"; docker logs "$cid" 2>&1 | head -10 | sed 's/^/        /'; bad=$((bad+1)); fi
    docker rm -f "$cid" >/dev/null 2>&1
    psql -h 127.0.0.1 -p 54321 -U "pay_${short}" -d "pay_${short}" -q -c "DROP SCHEMA IF EXISTS $schema CASCADE" >/dev/null 2>&1
    unset PGPASSWORD
  else
    echo "FALLA no se pudo construir la imagen de ejecución"; bad=$((bad+1))
  fi
  # Higiene del disco compartido: tras CADA construcción se borran las imágenes propias y la caché del constructor.
  docker image rm -f "p4gate-${svc}:prod" "p4gate-runtime-${svc}:run" >/dev/null 2>&1
  docker builder prune -f >/dev/null 2>&1
  echo "limpieza de ${svc}: imágenes p4gate-* restantes = $(docker images --format '{{.Repository}}' | grep -c '^p4gate-'), caché del constructor purgada"; disk
done
echo
echo "causa del GAP de la construcción real (comprobación independiente): ¿alcanza el registro desde un contenedor?"
docker run --rm "${HUB}/library/node:22-alpine" node -e "fetch('https://registry.npmjs.org/left-pad').then(r=>console.log('registro: HTTP',r.status)).catch(e=>console.log('registro: ERROR',e.cause?.code||e.message))" 2>&1 | tail -1
echo
echo "limpieza (sin registro: nada se publicó):"
docker images --format '{{.Repository}}:{{.Tag}}' | grep '^p4gate-' | xargs -r docker rmi -f >/dev/null 2>&1
echo "  imágenes p4gate-* restantes: $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^p4gate-')"
docker builder prune -f >/dev/null 2>&1
echo "  contenedores p4gate en ejecución: $(docker ps --format '{{.Image}}' | grep -c '^p4gate-')"
echo "  al terminar:"; disk
echo
echo "RESULTADO: construcciones reales con GAP: ${bad} (ver causa arriba); el escenario de ejecución de la imagen se comprueba aparte."
