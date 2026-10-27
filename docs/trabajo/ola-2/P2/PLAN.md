# Plan — P2 ola 2, tanda 2a: adaptación a contratos (pay-ledger, pay-settlement)

- Fecha: 2026-10-27 · Repos afectados: pasarelapago (`services/pay-ledger`, `services/pay-settlement`) · Predecesor: `docs/trabajo/ola-1/P2/`
- Fuente: `docs/trabajo/ola-2/CONTRATOS.md` §3 (filas 4, 5, 12, 17), §5, §7.
- Resultado observable: (1) las dos suites siguen verdes con los contratos nuevos; (2) `pay-ledger` y las rutas de dinero de `pay-settlement` exigen `X-Pay-Mode` (403 si falta o no es `test|live`) y los registros de un modo no se ven ni se mezclan con los del otro.
- Kill-test: pedir un saldo / un asiento / un payout con el modo contrario al que lo creó y comprobar que NO aparece; mandar sin cabecera y comprobar 403.

## Alcance
- IN: `services/pay-ledger/**`, `services/pay-settlement/**`, `docs/trabajo/ola-2/P2/**`, el archivo del carril `docs/plan/carriles/P2-ledger-y-liquidacion.md` si cambia el conteo.
- OUT: `contracts/`, otros servicios, commit (lo hace el coordinador). El evento `ledger.*` NO lleva `mode` (el contrato AsyncAPI es `additionalProperties:false` y no lo declara): se registra como propuesta.
- Ambigüedades: (a) el contrato dice `PayMode` opcional; el coordinador pide 403 sin él ⇒ se implementa estricto y se deja el contrato para el coordinador. (b) Rutas de conciliación de `pay-settlement`: no mueven dinero ni leen registros con modo; no exigen la cabecera (a confirmar con el coordinador).

## Diseño del modo (D-28), sin reglas de negocio nuevas
- Una **columna `mode`** en cada tabla de registro y un filtro `(mode, …)` en cada consulta.
- En el ledger el modo entra además en la **identidad** (id de cuenta de TigerBeetle, ids de transferencia y ids públicos), porque una etiqueta sola no separa los saldos: `merchant:X:pending` de `test` y de `live` son DOS cuentas de TigerBeetle. Una pata no puede nombrar una cuenta de otro modo porque el modo sale de la cabecera, no del cuerpo.
- Pedir por un id de otro modo da `404 resource_not_found` (no revela que existe).

## H1 — pay-ledger adaptado
**CA:** Dado el contrato nuevo, cuando corre la suite entonces `KNOWN_422_GAPS` está vacío y todas las respuestas validan; dado un pedido sin `X-Pay-Mode` válido, entonces 403 y nada se asienta; dado el mismo `business_ref`/cuentas en `test` y `live`, entonces los saldos, extractos, retenciones y asientos son independientes.
**DoD:** typecheck, build, eslint, `yarn test` ≥ 2 corridas verdes con TigerBeetle real.
**Estado:** HECHO

| ID | Microtarea | CA | DoD | Estado |
|---|---|---|---|---|
| O2.P2.H1.M1 | Vaciar `KNOWN_422_GAPS` y su tolerancia; el test pasa a exigir conjunto vacío | `KNOWN_422_GAPS.size === 0`, suite verde | `yarn test contract` | HECHO |
| O2.P2.H1.M2 | `mode` en SQL, ids, registro de cuentas, servicios, extracto, invariante y drift | tablas con `mode`; ids dependen del modo | `yarn test drift ids` | HECHO |
| O2.P2.H1.M3 | Leer `X-Pay-Mode` en todas las rutas (internas y `GET /balance`), 403 si falta o es inválido | 403 sin cabecera/valor inválido en cada ruta; nada asentado | `yarn test mode` (tres niveles) | HECHO |
| O2.P2.H1.M4 | Pruebas de aislamiento test↔live (asientos, holds, saldos, extractos, estados, idempotencia, concurrencia) | negativa cruzada en ambos sentidos | `yarn test mode` | HECHO |
## H2 — pay-settlement adaptado
**CA:** Dado el contrato nuevo, cuando corre la suite entonces no hay rutas fuera del contrato, `resolve` sin credencial da 401 (403 solo por rol), los eventos emiten `rail_rejected` y `mock`, `payout.created` sale también sin lote, y las rutas de dinero exigen/propagan `X-Pay-Mode`.
**Estado:** HECHO

| ID | Microtarea | CA | DoD | Estado |
|---|---|---|---|---|
| O2.P2.H2.M1 | `contract.spec.ts:37` espera `[]`; vaciar `KNOWN_422_GAPS` (código muerto) | verde | `yarn test contract` | HECHO |
| O2.P2.H2.M2 | `resolve`: 401 sin/mala credencial, 403 por rol | 401/403 según §3 fila 17 | `yarn test resolve operator-token` | HECHO |
| O2.P2.H2.M3 | Eventos: `rail_rejected` y `mock` | emitidos y válidos contra AsyncAPI | `yarn test payout reconciliation` | HECHO |
| O2.P2.H2.M4 | `payout.created` también para pagos sin lote | evento válido sin `settlement_batch_id` | `yarn test payout` | HECHO |
| O2.P2.H2.M5 | `X-Pay-Mode` en payouts, batches, charges y exportación: 403, columna `mode`, filtro, propagación a ledger y conectores | tres niveles + negativa test↔live | `yarn test mode` | HECHO |
## H3 — Cierre
| ID | Microtarea | CA | DoD | Estado |
|---|---|---|---|---|
| O2.P2.H3.M1 | Gates y suites ≥2 corridas por servicio con TigerBeetle real (una suite a la vez, `--maxWorkers=2`) | todo exit 0 | salidas en `evidencia/` | HECHO |
| O2.P2.H3.M2 | `REPORTE.md` con AVANCE primero | existe | — | HECHO |

## Riesgos
| Riesgo | Impacto | Mitigación |
|---|---|---|
| Postgres compartido (`max_connections`) y otros agentes | falsos rojos 53300 | una suite a la vez, `--maxWorkers=2`; 53300 = ENVIRONMENT |
| Cambiar la derivación de ids invalida datos viejos | solo dev: no hay ledger con datos | declararlo en el reporte |

---
# Tanda 2b (2026-10-27) — mode en eventos, entrantes, contradicciones, ids, inbox
## H4 — Pendientes de la tanda 2b
**CA:** Dado el pedido del coordinador (2b), cuando corren las suites entonces los 5 puntos tienen su prueba verde y las propuestas están escritas.
**DoD:** typecheck, build, eslint desde la raíz, `yarn test` ≥ 2 corridas por servicio con TigerBeetle real (una suite a la vez, `--maxWorkers=2`).
**Estado:** HECHO

| ID | Microtarea | CA | DoD | Estado |
|---|---|---|---|---|
| O2.P2.H4.M1 | Proponer `mode` en `ledger.*`, `settlement.batch.closed`, `reconciliation.exception.opened` y dejar el código listo (`EVENTS_CARRY_MODE`) | apagado: eventos válidos sin `mode`; encendido: `mode` en cada evento | `yarn test events events-mode config` | HECHO |
| O2.P2.H4.M2 | Prueba de contrato de las llamadas entrantes documentadas (pay-edge, pay-backoffice, pay-schedules, pay-payments) | llevan modo; 403 sin él; ningún llamador nuevo | `yarn test inbound-mode` | HECHO |
| O2.P2.H4.M3 | Consumir `payment_intent.contradiction_detected` (lo declara `receive` pay-settlement) con inbox y abrir una excepción sin mover dinero | 1 excepción por hecho; sin ledger/conector/payout | `yarn test consumers nats drift` | HECHO |
| O2.P2.H4.M4 | Ids `tx_`/`hd_` con modo: deterministas entre reinicios y réplicas (prueba) + aviso de migración en el README | valores fijados iguales en procesos aparte | `yarn test ids` | HECHO |
| O2.P2.H4.M5 | Consumidores de settlement con inbox, duplicados y desorden (pruebas) | un efecto por evento; mismo resultado en cualquier orden | `yarn test consumers nats` | HECHO |
| O2.P2.H4.M6 | Gates y suites ≥ 2 corridas por servicio + reporte 2b | todo exit 0 | `evidencia/` | HECHO |

---
# Tanda 2c (2026-10-27) — D-31, PAY_MODE explícito, .env.example y arnés
## H5 — Pendientes de la tanda 2c
**CA:** Dado el pedido del coordinador (2c), cuando corren las suites entonces `pay-console` ya no existe en el código ni en las pruebas de `pay-settlement`, ambos servicios exigen `PAY_MODE` explícito y se niegan a arrancar con dobles bajo `live`, y el ledger arranca en el arnés sin pasos manuales.
**DoD:** typecheck, build, eslint desde la raíz, `yarn test` ≥ 2 corridas por servicio con TigerBeetle real (una suite a la vez, `--maxWorkers=2`).
**Estado:** HECHO

| ID | Microtarea | CA | DoD | Estado |
|---|---|---|---|---|
| O2.P2.H5.M1 | D-31: `pay-console` → `pay-backoffice` en settlement (código, pruebas, README) y en mis docs de trabajo, sin cambiar comportamiento; la tabla «quién llama a qué» se sigue leyendo del contrato | 0 apariciones de `pay-console` (salvo la nota «antes provisorio»); `inbound-mode.spec` verde | `yarn test inbound-mode` | HECHO |
| O2.P2.H5.M2 | `PAY_MODE` explícito, sin valor por defecto, en pay-ledger y pay-settlement | ausente/vacío/inválido ⇒ no arranca con mensaje claro | `yarn test deployment config` | HECHO |
| O2.P2.H5.M3 | Bajo `live`, negarse a arrancar con cualquier doble o conector mock | live+doble ⇒ error que lo nombra; sandbox arranca | `yarn test deployment health-mode` | HECHO |
| O2.P2.H5.M4 | Relación clave↔despliegue: `test` solo contra sandbox, `live` solo contra live (403 si no) en todas las rutas | 8+1 rutas del ledger y 11+1 de settlement | `yarn test mode` | HECHO |
| O2.P2.H5.M5 | `.env.example` de los dos servicios consistentes con el arnés y entre sí | prueba que lee el arnés y los `.env.example` vecinos | `yarn test env-example` | HECHO |
| O2.P2.H5.M6 | Confirmar que el ledger arranca en el arnés con TigerBeetle real, sin pasos manuales | `ready` con el entorno exacto de `envFor` | `evidencia/arnes/` | HECHO |
| O2.P2.H5.M7 | Gates, suites ≥ 2 corridas por servicio y reporte 2c | todo exit 0 | `evidencia/` | HECHO |

---
# Tanda 4a (2026-10-27) — flujos E4 y E8 del plan
## H6 — E4 y E8 como archivos nuevos de e2e/pending
**CA:** Dados los flujos E4 y E8 de PLAN-MAESTRO §6, cuando se corre `yarn e2e:typecheck` y el lint entonces los dos archivos nuevos compilan y pasan el lint, sin modificar ningún archivo existente de `e2e/`, y la documentación dice qué asumen, qué esperan y cómo se miden.
**DoD:** `yarn e2e:typecheck`, `yarn eslint` desde la raíz, `yarn lint` (no se levanta el stack: lo corre P1).
**Estado:** HECHO (peldaño `RUNS`; la ejecución del stack NO se hizo)

| ID | Microtarea | CA | DoD | Estado |
|---|---|---|---|---|
| O2.P2.H6.M1 | `e2e/pending/e4.e2e.ts` (corte → payout → conciliación → excepción) | compila y pasa lint | `yarn e2e:typecheck`, `yarn lint` | HECHO |
| O2.P2.H6.M2 | `e2e/pending/e8.e2e.ts` (transferencia confirmada por el extracto) | ídem | ídem | HECHO |
| O2.P2.H6.M3 | Ayudantes nuevos `e2e/lib/p2-bank.ts` y `p2-settlement.ts` | ídem; sin tocar archivos de P1 | `git status` | HECHO |
| O2.P2.H6.M4 | `FLUJOS-E4-E8.md` + confirmación por escrito de qué parte de «E4 en verde» depende del stack y de Q-11 | documento escrito | lectura | HECHO |
