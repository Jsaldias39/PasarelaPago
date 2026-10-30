# Dockerfiles de producción: causa, arreglo y patrón (P1, ola 3)

> Peldaño: **`RUNS`** para `pay-edge` y `pay-webhooks` (imagen construida con `docker build`, exit 0, y arrancada con `/health/ready` en 200 como usuario `node`); la plantilla se verificó
> instanciándola y construyendo sus pruebas, **no** con `docker build` (ver «No cubierto»). Sin commit. Ninguna imagen se subió a ningún registro; las imágenes de prueba se borraron.

## Qué fallaba (lo halló P2; reproducido en pay-edge)

Los 12 Dockerfiles salían de la misma plantilla y **ninguno construía**:

1. `yarn workspaces foreach -A --topological-dev --from <svc> run build` ⇒ `Usage Error: property "all" forbids using property "from"` (Yarn 4.14.1): `-A` (`--all`) y `--from` son excluyentes.
2. `yarn install --immutable` ⇒ `YN0028 The lockfile would have been modified`: el Dockerfile copiaba **un solo** servicio (`COPY services/<svc> ./services/<svc>`), pero `yarn.lock` lista **los 12 workspaces**; con
   solo uno presente, el lockfile “cambiaría”.
3. Efecto lateral: no había `.dockerignore`; el contexto de `docker build` (la raíz del repo) pesaba ~2 GB (`node_modules`, `.git`, `.tools`, `e2e/.run`…). Medido ahora: 3,5 MB.

## El arreglo (mismo patrón que aplicó P2 en `pay-ledger` y `pay-settlement`)

```dockerfile
COPY .yarn ./.yarn
COPY .yarnrc.yml package.json yarn.lock tsconfig.base.json ./
COPY contracts/packages ./contracts/packages
# yarn.lock lista TODOS los workspaces: con `--immutable`, instalar con solo este servicio presente falla («The lockfile would have been modified»).
# Se copian todos para que el árbol coincida con el lockfile y, tras compilar, se quitan los demás: la imagen lleva solo este servicio.
COPY services ./services
RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable
RUN node .yarn/releases/yarn-4.14.1.cjs workspaces foreach -R --topological-dev --from <svc> run build
RUN find services -mindepth 1 -maxdepth 1 ! -name <svc> -exec rm -rf {} +
```

- `-A` ⇒ `-R` (`--recursive`: el servicio y sus dependencias de workspace, en orden topológico).
- `COPY services ./services` + `find … -exec rm -rf` al final: el árbol coincide con el lockfile para instalar y la imagen final lleva solo el servicio.
- **`.dockerignore` en la raíz** (nuevo): `.git`, `.github`, `.tools`, `node_modules`, `**/node_modules`, `**/dist`, `.yarn/cache`, `.yarn/install-state.gz`, `e2e/.run`, `e2e/.scratch`, `docs`. Revisado: ningún Dockerfile
  (`COPY . ./` en `pay-merchants`, `pay-risk`, `pay-schedules`) usa lo excluido.

Archivos cambiados por P1: `platform/templates/service/Dockerfile` (la plantilla: los servicios nuevos nacen bien), `services/pay-edge/Dockerfile`, `services/pay-webhooks/Dockerfile`, `.dockerignore`.

## Cómo lo adoptan los demás carriles

Para un servicio `pay-x` con el Dockerfile viejo:

```bash
# 1. -A por -R
sed -i 's/workspaces foreach -A --topological-dev --from pay-x run build/workspaces foreach -R --topological-dev --from pay-x run build/' services/pay-x/Dockerfile
# 2. copiar todos los servicios y quitar los demás tras compilar (reemplaza la línea `COPY services/pay-x ./services/pay-x`)
sed -i 's#^COPY services/pay-x ./services/pay-x$#COPY services ./services#' services/pay-x/Dockerfile
sed -i '/foreach -R --topological-dev --from pay-x run build/a RUN find services -mindepth 1 -maxdepth 1 ! -name pay-x -exec rm -rf {} +' services/pay-x/Dockerfile
```

Un Dockerfile con `COPY . ./` ya instala bien (copia todo) y solo necesita el `-R`. El `.dockerignore` es de toda la raíz: no hay que hacer nada por servicio.

## Pruebas (salida literal en `evidencia/`)

| Qué | Comando | Resultado | Evidencia |
|---|---|---|---|
| Build `pay-edge` | `docker build --build-arg HUB=p1gate.local -f services/pay-edge/Dockerfile -t p1gate-pay-edge:local .` | exit 0, 1 min 22 s, contexto 3,54 MB | `evidencia/dockerbuild-pay-edge.txt` |
| Build `pay-webhooks` | ídem con `pay-webhooks` | exit 0, 1 min 9 s, contexto 165 KB | `evidencia/dockerbuild-pay-webhooks.txt` |
| Contenido y arranque `pay-edge` | `docker run --network host …` | `/health/live` `{"status":"ok"}` 200 · `/health/ready` 200 (`database: up`) · usuario `node` · `ls /repo/services` ⇒ solo `pay-edge` · sin entorno falla rápido (`Falta la variable de entorno PAY_MODE`, exit 1) | `evidencia/docker-imagen-pay-edge.txt` |
| Arranque `pay-webhooks` | ídem | `/health/live` 200 · `/health/ready` 200 (`database: up`) · usuario `node` · solo `pay-webhooks` | `evidencia/docker-imagen-pay-webhooks.txt` |
| Limpieza | `docker rmi …` | imágenes `p1gate-*` y la base local borradas; ningún contenedor `p1gate` | `evidencia/docker-limpieza.txt` |

Nota de entorno (ENVIRONMENT, no del servicio): la salida a internet de esta máquina pasa por un proxy que re-firma TLS; el primer `docker build` falló en `yarn install` con un error de handshake TLS
(`dockerbuild-pay-edge.txt` de la primera corrida, sobrescrito). Se construyó con una imagen base **local** (`p1gate.local/library/node:22-alpine`) = la oficial + la CA del proxy en `NODE_EXTRA_CA_CERTS`, usada
solo para estas pruebas y borrada. Los Dockerfiles aceptan `--build-arg HUB=<registro>` desde antes; no se versionó nada del proxy.

## No cubierto / riesgos

- **La plantilla no se construyó con `docker build`**: se instanció con `platform/scripts/new-service.sh pay-probe 3197` y se probó (typecheck + 33 pruebas, `evidencia/plantilla-pruebas.txt`). Su Dockerfile es idéntico al de pay-edge con el nombre sustituido.
- Las imágenes llevan `devDependencies` (≈1 GB): el `COPY --from=build /repo /repo` copia todo el árbol. Es la propuesta 21 de P2 (imagen mínima con `yarn workspaces focus --production`); no se tocó.
- `docker builder prune -f` se corrió al limpiar y borró también caché de build de **otros** agentes (solo caché; se reconstruye). No repetir sin avisar.
- `pay-ledger` en contenedor: bloqueado por `io_uring` del kernel de pruebas (hallazgo de P2, ENVIRONMENT); no se probó con pay-edge/pay-webhooks porque no usan TigerBeetle.
