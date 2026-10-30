> **AVANCE (tanda 2b): 6 / 6 — 100,0 %.** (`HECHO` 6 · `A MEDIAS` 0 · `TODO` 0 · `BLOQUEADO` 0). Acumulado ola 2 de P2: 17 / 17. Peldaño: **`TESTED`** (suites completas con Postgres, NATS y TigerBeetle reales). No `REGRESSION_VERIFIED`: no corrí otros servicios.

# Reporte — P2 ola 2, tanda 2b (`pay-ledger`, `pay-settlement`)

- Fecha: 2026-10-27 · Plan: [PLAN.md](./PLAN.md) (H4) · Decisiones O2-D10..D13: [DECISIONES-TOMADAS.md](./DECISIONES-TOMADAS.md) · Propuestas 1 y 8–11: [PROPUESTAS.md](./PROPUESTAS.md). Sin commit; no toqué `contracts/`.

## Completado
| ID | Qué se logró | Comando | Resultado |
|---|---|---|---|
| O2.P2.H4.M1 | Propuesta 1 escrita (incluye `ledger.hold.*`). Código listo: `EVENTS_CARRY_MODE` (apagado) hace que `ledger.transfer.posted`, `ledger.hold.created\|posted\|voided\|expired`, `settlement.batch.closed` y `reconciliation.exception.opened` lleven el `mode` de su asiento/retención/corte/corrida. Apagado validan contra el contrato; encendido, el contrato de hoy solo rechaza `mode` (canario) | `yarn test events events-mode config` | PASS |
| O2.P2.H4.M2 | Prueba de contrato que **lee del contrato** la tabla «quién llama a qué» (17 pares: pay-schedules 4, pay-payments 1, pay-edge 1, pay-backoffice 11): con `test`/`live` ninguno recibe 403; sin la cabecera, vacía, `TEST`, `sandbox` o `prod`, los 17 reciben 403 `forbidden`; 8 servicios no documentados reciben 403 en todo lo que no tienen, aun con modo válido | `yarn test inbound-mode` | PASS (3) |
| O2.P2.H4.M3 | `pay-settlement` declara `receive` de `payment_intent.contradiction_detected` (`payments.yaml`): lo consume con inbox (`pay-settlement.payment_intent.contradiction_detected`) y abre una excepción `payment_contradiction`, sin ledger/conector/pago/cobro/evento. Duplicado, mismo hecho con otro id, concurrencia ×10, desorden, sin `mode`, 7 inválidos, otro origen, resolver (401/403/404 por modo), NATS real | `yarn test consumers nats drift` | PASS |
| O2.P2.H4.M4 | Ids con modo: valores fijados (10 ids) iguales en el proceso y en dos procesos nuevos con otra zona horaria/idioma/entorno; README del ledger con la advertencia de migración | `yarn test ids` | PASS |
| O2.P2.H4.M5 | Consumidores con inbox, duplicados, concurrencia y desorden: `ledger.transfer.posted` (10 repeticiones simultáneas; 4 órdenes de llegada dan el mismo `first_seen`/`last_activity`), `fee_schedule.published` (las 6 permutaciones de v1–v3; 9 entregas simultáneas) | `yarn test consumers` | PASS |
| O2.P2.H4.M6 | Gates y suites | ver Evidencia | PASS |

## A medias / Pendiente
Ninguna en mi carril. Dependen del coordinador: propuestas 1, 8, 9 y 10 (contratos) y 11 (P5).

## Evidencia (en `evidencia/`)
- `gates-2b.txt`: `yarn typecheck` y `yarn build` de ambos servicios y `yarn eslint "services/pay-ledger/**/*.ts" "services/pay-settlement/**/*.ts"` desde la raíz — todos `exit=0`.
- `test-pay-ledger-2b.txt`: 2/2 corridas — **11 suites, 211 pruebas** (TigerBeetle real). `test-pay-settlement-2b.txt`: 2/2 — **24 suites, 470 pruebas**. Una suite a la vez, `--maxWorkers=2`.
- `O2.P2.H4-2b-pruebas.txt`: nombres literales de las pruebas de cada microtarea (de `--json`, 0 fallidas).

## Hallazgos
1. **PRODUCT_BUG (settlement) corregido** — `settlement_merchants.first_seen_at` quedaba con el de la PRIMERA entrega aunque llegara después un evento más viejo; el corte usa `MIN(first_seen_at)` como inicio del periodo. Ahora es `LEAST`. La prueba de desorden falla sin el arreglo (verificado quitándolo) y pasa con él.
2. **Desvío conocido del contrato** — la lista `GET /reconciliation_exceptions` devuelve `kind: payment_contradiction` y `run_id: null` para esas excepciones; el contrato no lo admite todavía (propuesta 8). La prueba fija que el ÚNICO desvío es `kind`/`run_id`.
3. `pay-schedules` no tiene cliente de `pay-settlement` (solo manda `X-Pay-Mode` al ledger); el contrato lo lista como llamador. Lo verifiqué por búsqueda de código de solo lectura (propuesta 11).

## No cubierto
- `pay-edge` real → `pay-settlement`: leí que el borde reenvía `x-pay-mode` (`edge.pipeline.ts`) y que `GET /payouts` va a `pay-settlement` (`routes.ts`), pero no ejercité el borde: la prueba de contrato es del lado de `pay-settlement`.
- No emito `reconciliation.exception.opened` para las contradicciones (propuesta 9).
- La advertencia de migración de ids está documentada y los valores fijados detectan un cambio; no hay herramienta de migración.
- No corrí `contracts:lint`/`contracts:events` ni otros servicios.

## Desvíos del plan
Ninguno.

## Procesos
TigerBeetle levantado por mí (pid 30723): **detenido** (`status: detenido`). Sin otros procesos en segundo plano.
