# Evidencia P5 — ola 3, tandas 3a–3c

Matriz de gates con el veredicto de cada fila: [`../GATES.md`](../GATES.md). Modelo vendorizado: commit `af60b79`.

| Archivo | Qué contiene |
|---|---|
| `3c-vendor-check.txt`, `3b-vendor-check.txt`, `3b-vendorizacion-procedencia.txt` | `--check` contra el modelo; procedencia (sha256, diferencia del árbol de trabajo antes del commit estable) |
| `3c-typecheck-build.txt`, `3c-eslint-p5.txt`, `3c-eslint-raiz.txt`, `gate1-*` | typecheck, build, lint (los `gate1-*` son la pasada anterior) |
| `3c-test-2-corridas.txt`, `3c-risk-aislado.txt`, `3c-risk-sin-relay.txt`, `3b-suites-con-ddl-vendorizado.txt` | suites (2 corridas, `--maxWorkers=2`); `pay-risk` aislado de `latency.spec` (ENVIRONMENT) |
| `separacion.txt` | gate de separación con los roles del Compose |
| `datos-sensibles.txt`, `sonda-idempotency-key-pan.txt`, `3c-url-privacy-causa.txt` | gate de datos sensibles, sonda de clave con forma de PAN, causa del fallo de `url-privacy.spec` |
| `fallos.txt`, `fallos-antes-del-arreglo.txt` | experimentos de fallos; el «antes» muestra el proceso muriendo |
| `deriva-sql-codigo.txt`, `3b-ddl-escenarios.txt`, `3c-truncate-rol-aplicacion.txt` | deriva código ↔ base, orden de aplicación del DDL, TRUNCATE con el rol de la aplicación |
| `dockerfile.txt`, `dockerfile.txt.*.log`, `dockerfile-antes-del-arreglo.txt` | `docker build` de los tres servicios + humo del contenedor; el «antes» es el fallo del Dockerfile |

Reproducción: `node scripts/p5-gates.mjs <separation|sensitive|faults|drift|ddl-order|truncate|idem-pan>`.
