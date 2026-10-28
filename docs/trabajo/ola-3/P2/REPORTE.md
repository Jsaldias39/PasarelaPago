> **AVANCE (ola 3, tanda 3a + 3b/3c): 10 / 13 gates de §7 en PASS (5 con GAP declarado) · 3 `NO APLICA AÚN` · P2.H1.M2 y P2.H2.M1 a HECHO. Carril P2: 17 / 19 — 89,5 %.**

# Reporte — P2 ola 3 (matriz de gates + vendorización del modelo)

- Matriz completa: [`GATES.md`](./GATES.md) · Propuestas 20–26: [`PROPUESTAS.md`](./PROPUESTAS.md) · Evidencia: [`evidencia/`](./evidencia/) (prefijos `3a-` y `3c-`). Sin commit.
- Peldaño: `TESTED` (suites completas ×2 por servicio con TigerBeetle real; ni stack E1–E8, ni Jaeger, ni banco real). El modelo vendorizado es `mantra-core-health-model` @ `af60b79`.

## Completado
| Qué | Comando | Resultado |
|---|---|---|
| typecheck, build, eslint de raíz, `yarn lint` de raíz, `contracts:lint`, `contracts:events`, `e2e:typecheck` | ver `evidencia/3c-gates.txt` | todos `exit=0` |
| Suites completas, `--maxWorkers=2`, TigerBeetle y NATS propios | `yarn test` por servicio, ×2 | ledger 276/276 ×2 · settlement 560/560 ×2 |
| Separación con el rol `dev_only_<svc>` (prueba nueva + `psql` + contenedor de settlement) | `separation.spec.ts` ×2, `3a-separacion-psql.txt` | PASS (168 comprobaciones del script de P1, 0 fallas) |
| Datos sensibles (script + canarios) | `scripts/check-sensitive-data.sh` | `LIMPIO (0 fallas)` + `--self-test` |
| Idempotencia en paralelo (huecos del ledger) | `idempotency-parallel.spec.ts` | 6/6 |
| Inyección de fallos (SIGKILL a TigerBeetle) | `faults.spec.ts` | 2/2 |
| Vendorización del `ddl.sql` + `--check` + quitar los `001_*.sql` | `scripts/vendor-model-sql.sh` | PASS; control negativo y «repo ausente ⇒ SKIP» |
| Prueba del constraint nuevo de `ledger_holds` | `holds-accounts-fk.spec.ts` | 6/6; sin cambio de código en `hold.service.ts` |
| Dockerfile: `docker build` de las dos imágenes (corregidos 2 defectos), arranque de settlement, limpieza | `3a-docker-*.txt` | build `rc=0`; imágenes borradas |

## A medias
- **Arranque del contenedor de `pay-ledger`**: qué anda: la imagen compila; qué no: el cliente de TigerBeetle aborta dentro del contenedor (`io_uring is not available`, **ENVIRONMENT**); qué falta: un host con `io_uring` habilitado; dónde: `evidencia/3a-docker-humo-ledger.txt`.

## Pendiente (GAP con dueño)
| Qué | De quién |
|---|---|
| Clave de API revocada (no es verificable en P2) | P1 (borde) y P5 (claves) |
| `REVOKE … template1` (propuesta 22); `Idempotency-Key` con forma de PAN (23); `instance` que refleja la ruta (24); Dockerfile de la plantilla y de los otros 10 servicios + `.dockerignore` (21) | P1 |
| Huérfanos de TigerBeetle tras un timeout (25) | P2 / coordinador (cambio mayor) |
| Triggers de inmutabilidad en las 5 tablas de solo-agregar (20) | modelo (+ pruebas de P2) |
| Observabilidad (Jaeger), Carga (T-01), Sandbox (ola 4) | `NO APLICA AÚN`, con motivo en `GATES.md` |

## Entorno (regla 80.4)
La máquina estaba saturada (carga 10–17, OOM killer: mató 4 veces un TigerBeetle de ~3 GB). Las corridas válidas usan TigerBeetle y NATS **propios** (borrados al terminar); las primeras corridas, con la infraestructura compartida, se conservan como descartadas (`3a-test-*`, `3c-descartada-*`) con su causa: ENVIRONMENT (OOM / clientes de TigerBeetle al tope) y EXTERNAL (streams NATS compartidos, la misma observación del agente del modelo). Sin `skip`, sin subir timeouts, sin reintentos agregados. Quedó **detenido** el TigerBeetle compartido de desarrollo (`:54300`; murió por OOM antes de que yo lo apagara).

## Desvíos
- Archivos fuera de `services/pay-*`: `scripts/check-sensitive-data.sh` y `scripts/vendor-model-sql.sh` (nuevos, pedidos por el coordinador).
- Cambio de comportamiento: la traducción `unknown_reference → missing_in_ledger` del evento ya se había quitado en 4c; no hay otro.
