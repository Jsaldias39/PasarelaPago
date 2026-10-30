> **AVANCE (tanda 2c): 7 / 7 — 100,0 %.** (`HECHO` 7 · `A MEDIAS` 0 · `TODO` 0 · `BLOQUEADO` 0). Acumulado ola 2 de P2: 24 / 24. Peldaño: **`TESTED`** (suites completas con TigerBeetle, Postgres y NATS reales) y **`VERIFIED`** solo para el arranque del ledger y de settlement con el entorno del arnés (ver «No cubierto»). No `REGRESSION_VERIFIED`.

# Reporte — P2 ola 2, tanda 2c (`pay-ledger`, `pay-settlement`)

- Fecha: 2026-10-27 · Plan: [PLAN.md](./PLAN.md) (H5) · Decisiones O2-D14..D16: [DECISIONES-TOMADAS.md](./DECISIONES-TOMADAS.md) · Propuestas 12–14: [PROPUESTAS.md](./PROPUESTAS.md). Sin commit; no toqué `contracts/` ni otros carriles.

## Completado
| ID | Qué se logró | Comando | Resultado |
|---|---|---|---|
| O2.P2.H5.M1 | D-31: `pay-console` → `pay-backoffice` en `settlement.controller.ts` (`PAYOUT_*`, `OPERATIONS`, `CHARGE_WRITERS`, `@AllowedServices`), 13 specs, y mis docs de `ola-1/P2` y `ola-2/P2` (la nota «antes provisorio `pay-console`» se conserva). Comportamiento idéntico: `inbound-mode.spec` sigue **leyendo la tabla del contrato** y comprueba los 17 pares con `pay-backoffice`; el nombre viejo recibe 403 | `yarn test inbound-mode` | PASS |
| O2.P2.H5.M2 | `PAY_MODE` obligatorio en los dos servicios: ausente, vacío o inválido (`staging`, `SANDBOX`, `test`…) ⇒ no arranca, con «Falta la variable de entorno PAY_MODE (sandbox \| live): no tiene valor por defecto». Se probó en la configuración y arrancando la `AppModule` completa | `yarn test deployment config` | PASS |
| O2.P2.H5.M3 | Bajo `live`, negarse a arrancar con cualquier doble: ledger (motor sin `isReal`); settlement (cliente de ledger o de conectores doble, riel simulado, modo B, conector mock — nombra cada uno). `sandbox` arranca con dobles; `live` con los reales arranca y `/health/ready` da 200 | `yarn test deployment health-mode` | PASS |
| O2.P2.H5.M4 | Clave↔despliegue (`test`↔sandbox, `live`↔live): ledger 8 rutas + `GET /balance`, settlement 11 rutas + `GET /payouts` de `pay-edge`; en ambos sentidos ⇒ 403 `forbidden`, sin escribir ni llamar al ledger/conector. Contra ledgers REALES: un settlement live apuntando a un ledger sandbox no paga (503, sin orden al conector); dos despliegues reales pagan cada uno de su saldo | `yarn test mode ledger-real` | PASS |
| O2.P2.H5.M5 | `.env.example` de ambos con `PAY_MODE` activo y comentado como obligatorio; prueba que (a) carga la configuración, (b) documenta TODAS las variables que el arnés (`e2e/lib/services.ts`, leído como texto) les pasa, (c) `LEDGER_URL`/`CONNECTORS_URL` apuntan al `PORT` que declaran `pay-ledger`/`pay-connectors` en SU `.env.example` | `yarn test env-example` | PASS (4 + 4) |
| O2.P2.H5.M6 | El ledger arranca en el arnés con TigerBeetle real y sin ningún paso manual: con las funciones del arnés (`startPrivateTigerBeetle`, `resetDatabase`, `envFor`, `spawnNode`) y SOLO el entorno que arma `envFor` (12 variables, `PAY_MODE` incluida), `/health/ready` = 200 en 1,45 s; un asiento `test` → 201 y saldo 1234; `live` → 403; sin modo → 403; sin errores en el log. Settlement, igual (1,5 s; `pay-backoffice` 200, `pay-console` 403) | `evidencia/arnes/` | PASS |
| O2.P2.H5.M7 | Gates y suites | ver Evidencia | PASS |

## A medias / Pendiente
Ninguna en mi carril.

## Evidencia (en `evidencia/`)
- `gates-2c.txt`: `yarn typecheck`/`yarn build` de ambos y `yarn eslint "services/pay-ledger/**/*.ts" "services/pay-settlement/**/*.ts"` desde la raíz — todos `exit=0`.
- `test-pay-ledger-2c.txt`: 2/2 — **13 suites, 247 pruebas**. `test-pay-settlement-2c.txt`: 2/2 — **26 suites, 500 pruebas**. Una suite a la vez, `--maxWorkers=2`, TigerBeetle real.
- `O2.P2.H5-2c-pruebas.txt`: nombres literales de las pruebas (de `--json`, 0 fallidas).
- `arnes/`: los dos scripts que arrancan el ledger y settlement con las funciones del arnés y sus salidas literales.

## Hallazgos
1. **Las pruebas de aislamiento cambiaron de forma**: ya no hay UN despliegue que atienda test y live (sería lo que el coordinador prohibió). Los contextos de prueba arman DOS despliegues (sandbox y live) sobre la misma base, y `as(servicio, modo)` va al que corresponde; así se sigue probando que `test` y `live` no se mezclan en el almacenamiento.
2. **`.env.example` ajenos inconsistentes** (propuesta 14): `pay-payments` y `pay-schedules` apuntan a puertos que no son los de `pay-ledger`/`pay-connectors`. Lo vio la prueba nueva al leerlos; no los toqué.
3. `e2e/ARNES.md` quedó desactualizado en dos filas (propuesta 13).

## No cubierto
- No ejecuté `yarn e2e:boot`/`smoke` (necesita Redis, Temporal y Watchman y borra los streams `PAY_*` de NATS, que comparten otros agentes): usé las funciones del arnés solo para el ledger y settlement. El flujo con los 11 servicios no se ejercitó.
- La guardia de `live` se prueba con dobles inyectados y con los clientes reales, pero no hay un despliegue `live` real (sin cuenta recaudadora, T-03).
- Los otros 9 servicios no se tocaron ni se corrieron; ver propuestas 13–14.

## Desvíos del plan
Ninguno.

## Procesos
TigerBeetle compartido levantado por mí (pid 6568): **detenido** (`status: detenido`). Los TigerBeetle privados y los servicios de las confirmaciones del arnés salieron (`exited`) y sus directorios se borraron. Sin otros procesos en segundo plano.
