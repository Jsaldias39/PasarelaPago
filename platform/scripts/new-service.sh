#!/usr/bin/env bash
# Genera un servicio nuevo desde platform/templates/service.
# Uso: platform/scripts/new-service.sh pay-ledger 3102
set -euo pipefail
name=${1:?uso: new-service.sh <pay-nombre> <puerto>}
port=${2:?uso: new-service.sh <pay-nombre> <puerto>}
[[ "$name" =~ ^pay-[a-z]+$ ]] || { echo "El nombre debe ser pay-<minúsculas>: $name" >&2; exit 1; }
[[ "$port" =~ ^[0-9]{4,5}$ ]] || { echo "Puerto inválido: $port" >&2; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
dest="$root/services/$name"
# Una carpeta con solo el README de marcador cuenta como vacía; con cualquier otra cosa, se niega.
if [ -e "$dest" ] && [ -n "$(find "$dest" -mindepth 1 ! -name README.md -print -quit)" ]; then echo "Ya existe $dest con contenido" >&2; exit 1; fi
db=${name//-/_}
suffix=${name#pay-}
mkdir -p "$dest"
cp -R "$root/platform/templates/service/." "$dest/"
find "$dest" -type f ! -path '*/node_modules/*' -print0 | xargs -0 sed -i "s/__NAME__/$name/g; s/__DB__/$db/g; s/__PORT__/$port/g; s/__SUFFIX__/$suffix/g"
echo "Servicio creado en services/$name (base $db, puerto $port). Siguiente: yarn install && yarn workspace $name test"
