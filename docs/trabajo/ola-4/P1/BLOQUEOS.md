# Ola 4 · P1 — Qué no se puede probar en este entorno (P1.H5.M1)

> **Estado de P1.H5.M1 (`docker compose -f platform/compose.yml -f platform/compose.mock.yml up -d --wait`): BLOQUEADO por el entorno, no probado.** Nunca se llegó a
> «12 servicios healthy» con el Compose de la capa sandbox y este documento NO lo afirma. Lo que sí se pudo comprobar está en la sección 3.

Entorno de la medición: contenedor de nube de la sesión, 2026-10-28, salida a Internet solo por un proxy del entorno que intercepta TLS (CA propia en `/root/.ccr/ca-bundle.crt`).
Las salidas están pegadas tal cual en `docs/trabajo/ola-4/P1/evidencia/` (solo se enmascararon las firmas de la URL temporal de GitHub).

## 1. Bloqueos medidos

| # | Qué se intentó | Resultado literal | Clase |
|---|---|---|---|
| 1 | `docker pull ghcr.io/tigerbeetle/tigerbeetle:latest` (imagen de `tigerbeetle` en `platform/compose.yml`, línea `image: ghcr.io/tigerbeetle/tigerbeetle:latest`) | `failed to copy: httpReadSeeker: failed open: failed to do request: Get "https://pkg-containers.githubusercontent.com/ghcrblobs16/blobs/sha256:8fb18115…": Forbidden` (`exit=1`; el manifiesto baja, el blob lo niega el proxy: 403) | ENVIRONMENT |
| 2a | `docker build -f platform/Dockerfile.sandbox --build-arg HUB=docker.io -t pay-sandbox:… .` | `ERROR: failed to build: failed to solve: docker.io/library/node:22-alpine: failed to resolve source metadata for docker.io/library/node:22-alpine: unexpected status from HEAD request to https://registry-1.docker.io/v2/library/node/manifests/22-alpine: 429 Too Many Requests` (`exit=1`) | ENVIRONMENT (límite de pulls anónimos de Docker Hub) |
| 2b | La misma orden con `--build-arg HUB=mirror.gcr.io` | La imagen base `node:22-alpine` SÍ baja; falla el paso `RUN node .yarn/releases/yarn-4.14.1.cjs install --immutable` (`#11 … ➤ YN0000: · Failed with errors in 43s 895ms`, `exit=1`) con `➤ YN0001: │ RequestError: self-signed certificate in certificate chain` repetido por cada paquete | ENVIRONMENT (el proxy intercepta TLS y la imagen de build no lleva su CA) |

Evidencia: `evidencia/bloqueo-1-pull-ghcr.txt`, `bloqueo-2a-build-docker-io.txt`, `bloqueo-2b-build-mirror-gcr.txt`, `bloqueo-2c-self-signed.txt`.
No es un defecto del producto ni del Dockerfile: ninguno de los tres fallos depende del código del repo. Los builds fallaron antes de producir imagen (no quedó ninguna que borrar); el caché de construcción de otros agentes no se tocó.

## 2. Qué lo destraba

Cualquiera de estas dos cosas, en un entorno distinto de este:

- **Acceso a `ghcr.io` (blobs en `pkg-containers.githubusercontent.com`) y al registro de npm (`registry.yarnpkg.com`) sin intercepción de TLS**, y a un registro de imágenes sin límite anónimo (Docker Hub autenticado o un espejo); o
- **un espejo de `ghcr.io/tigerbeetle/tigerbeetle`** (se cambia la línea `image:` de `tigerbeetle` o se define un espejo en el daemon) **más la CA del proxy dentro de la imagen de build** (`COPY` del `ca-bundle.crt` y `NODE_EXTRA_CA_CERTS` antes del `yarn install`, solo en el entorno que lo necesite; no se agregó al `Dockerfile.sandbox` porque la CA es de este entorno y no debe quedar en el repo).

Una vez destrabado: `node platform/scripts/sandbox-secrets.mjs && docker compose --env-file platform/.sandbox/secrets.env -f platform/compose.yml -f platform/compose.mock.yml up -d --wait`, luego `yarn seed:sandbox` (dos veces) y `yarn test:parity`. Solo entonces se puede decir «12 servicios healthy en el Compose».

## 3. Lo que SÍ se comprobó (y qué prueba cada cosa)

1. **La configuración del Compose es VÁLIDA** (no prueba que arranque):
   ```text
   $ docker compose --env-file platform/.sandbox/secrets.env -f platform/compose.yml -f platform/compose.mock.yml config --quiet
   exit=0
   $ ... config --services
   jaeger nats pay-connectors pay-edge pay-ledger pay-merchants pay-mockbank pay-payments pay-qr pay-risk pay-schedules pay-settlement pay-vault pay-webhooks postgres redis sandbox-migrate temporal temporal-db tigerbeetle watchman
   $ ... config --images
   docker.io/jaegertracing/all-in-one:1.62.0 · docker.io/library/nats:2.10-alpine · docker.io/library/postgres:16-alpine · docker.io/library/redis:7-alpine ·
   docker.io/moov/watchman:v2-static · docker.io/temporalio/auto-setup:1.25 · ghcr.io/tigerbeetle/tigerbeetle:latest · pay-sandbox:local
   ```
   Los 12 servicios de la capa sandbox (`pay-connectors … pay-webhooks`) están en la configuración fusionada; el env-file es el que genera `platform/scripts/sandbox-secrets.mjs` (ya existía en `platform/.sandbox/`, no se regeneró). Salida completa: `evidencia/bloqueo-3-compose-config.txt`.
2. **`yarn seed:sandbox` contra el stack real de 12 servicios del arnés** (no contra el Compose): `e2e/flows/seed-sandbox.e2e.ts`, 8 pruebas en verde. Corrida 1 inserta 3 comercios, 3 claves, 2 billeteras y 1 mandato; corrida 2 inserta 0 y reutiliza todo (`docs/trabajo/ola-3/P1/evidencia/seed-sandbox-corrida-verde.txt`).
   Esa corrida encontró dos defectos de la propia siembra (arreglados en `e2e/lib/sandbox-seed.ts`, nuestro carril): el `business_ref` del asiento de apertura no cumplía el formato del ledger real (422) y la primera consulta con la clave recién creada recibía 401 porque el borde la aprende por NATS con unos segundos de retraso.
3. **`yarn test:parity`**: exit 0, mock y bank_transfer en PARIDAD y `mercantil_qr`/`mercantil_card` BLOQUEADO (Q-01, Q-11).

## 4. No cubierto (honesto)

- Que los 20 servicios del Compose arranquen, se vuelvan `healthy` y se hablen entre sí **dentro de Docker** (red, `depends_on`, volúmenes, `sandbox-migrate`, el `command`/`working_dir` de cada servicio en la imagen única).
- Que `docker build -f platform/Dockerfile.sandbox` produzca una imagen que arranque los 12 servicios (nunca terminó el `yarn install`; `PRUNE=1` sigue sin verificar).
- `yarn seed:sandbox` con los puertos fijos del Compose (3101/3105/3107) y la clave de operador de `platform/.sandbox`: se probó el mismo ejecutable con los puertos del arnés y una clave de operador temporal.
