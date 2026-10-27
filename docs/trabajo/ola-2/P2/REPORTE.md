> **AVANCE: 11 / 11 — 100,0 %.** (`HECHO` 11 · `A MEDIAS` 0 · `TODO` 0 · `BLOQUEADO` 0). Peldaño: **`TESTED`** (suites dirigidas y completas con Postgres, NATS y TigerBeetle reales; ledger real contra settlement en `ledger-real.spec`). **No** `REGRESSION_VERIFIED`: no corrí las suites de los otros servicios.

# Reporte — P2 ola 2, tanda 2a: adaptación a contratos (`pay-ledger`, `pay-settlement`)

- Fecha: 2026-10-27 · Plan: [PLAN.md](./PLAN.md) · Rama: `claude/adoring-allen-ly7r6f` · Sin commit (lo hace el coordinador).
- Fuente: `docs/trabajo/ola-2/CONTRATOS.md` §3 (filas 4, 5, 12, 17), §5, §7. Decisiones: [DECISIONES-TOMADAS.md](./DECISIONES-TOMADAS.md) (O2-D1..D9). Propuestas: [PROPUESTAS.md](./PROPUESTAS.md).

## Completado
| ID | Qué se logró | Comando | Resultado |
|---|---|---|---|
| O2.P2.H1.M1 | `KNOWN_422_GAPS` y la tolerancia de `:debt` borrados de `test/helpers/app.ts`; `contract.spec.ts` comprueba que el contrato declara el 422 de las 5 rutas | `yarn test contract` (dentro de la suite completa) | PASS — [H1-pruebas](./evidencia/O2.P2.H1-pay-ledger-pruebas.txt) |
| O2.P2.H1.M2 | El modo entra en el id de cuenta/transferencia/`tx_`/`hd_`, columna `mode` en las 6 tablas, claves únicas y foráneas compuestas, invariante por `(modo, cuenta)`, mapa de deriva | `yarn test drift ids invariant` | PASS |
| O2.P2.H1.M3 | `X-Pay-Mode` leído en las 8 rutas internas y en `GET /balance`; `403 forbidden` si falta, está vacío, repetido, en mayúsculas, `sandbox`, `prod` o `test,live`; nada se asienta | `yarn test mode` | PASS (43 pruebas, tres niveles) |
| O2.P2.H1.M4 | Aislamiento test↔live en los dos sentidos: saldo, extracto, asiento, retención (consulta/confirma/anula → 404, sigue pendiente), idempotencia, rechazo por saldo, 10+10 concurrentes, contracargo partido, invariante global; y la FK compuesta rechaza una pata con cuenta de otro modo | `yarn test mode` | PASS |
| O2.P2.H2.M1 | `contract.spec.ts` espera `[]` rutas extra; `KNOWN_422_GAPS` y la tolerancia del 503 borrados | `yarn test contract` | PASS — [H2-pruebas](./evidencia/O2.P2.H2-pay-settlement-pruebas.txt) |
| O2.P2.H2.M2 | `resolve`: `401 unauthorized` si la credencial falta/venció/no verifica (7 casos), `403` por rol y por servicio | `yarn test resolve` | PASS |
| O2.P2.H2.M3 | Eventos con `rail_rejected` y con `mock` (no `simulator`), válidos contra el AsyncAPI | `yarn test payout reconciliation` | PASS |
| O2.P2.H2.M4 | `payout.created` también para pagos sin lote (sin `settlement_batch_id`, válido) | `yarn test payout` | PASS |
| O2.P2.H2.M5 | `X-Pay-Mode` en las 11 operaciones: 403 (6 valores inválidos × rutas de dinero y lecturas), columna `mode` en 5 tablas, filtro, propagación a ledger y conector; negativa test↔live (pago, corte del mismo lunes, cobro, abono mensual, exportación, conciliación, confirmación por extracto) y contra el **ledger real** | `yarn test mode ledger-real` | PASS (29 + 11) |
| O2.P2.H3.M1 | Gates y suites ≥ 2 corridas por servicio | ver Evidencia | PASS |
| O2.P2.H3.M2 | Este reporte | — | escrito |

## A medias
Ninguna.

## Pendiente
Ninguna en mi carril. Las propuestas 1–7 de [PROPUESTAS.md](./PROPUESTAS.md) dependen del coordinador, de contratos y del repo del modelo.

## Evidencia (literal en `evidencia/`)
- [gates.txt](./evidencia/gates.txt): `yarn typecheck` y `yarn build` de `pay-ledger` y `pay-settlement`, y `yarn eslint "services/pay-ledger/**/*.ts" "services/pay-settlement/**/*.ts"` desde la raíz — todos `exit=0`.
- [test-pay-ledger.txt](./evidencia/test-pay-ledger.txt): `yarn test --maxWorkers=2` ×2 — **11 suites, 204 pruebas, 2/2 verdes** (TigerBeetle real).
- [test-pay-settlement.txt](./evidencia/test-pay-settlement.txt): `yarn test --maxWorkers=2` ×2 — **21 suites, 435 pruebas, 2/2 verdes** (TigerBeetle, NATS y el pay-ledger real compilado de `ledger-real.spec`; se recompiló `pay-ledger` antes).
- Nombres literales de las pruebas de cada hito: `O2.P2.H1-pay-ledger-pruebas.txt` y `O2.P2.H2-pay-settlement-pruebas.txt` (de `--json`: 183 + 224, 0 `failed`).
- Una suite jest a la vez, `--maxWorkers=2`; no hubo `53300`. TigerBeetle lo levanté yo y lo detengo al cerrar (ver Procesos).

## Hallazgos durante el trabajo
1. **PRODUCT_BUG latente (ledger) corregido** — carrera en la primera operación sobre una cuenta nueva: `AccountRegistry` memorizaba la cuenta antes de confirmar su fila de Postgres y la petición concurrente fallaba con `500` (FK `ledger_legs_debit_account_fkey`). La prueba nueva «concurrencia: 10 cobros simultáneos en cada modo» la hizo fallar 3/3 corridas antes del arreglo y pasa 2/2 después (O2-D9).
2. **TEST_BUG mío** — mi primer cálculo del saldo de una retención y el número de líneas de extracto estaban mal (`balance_minor` ya descuenta lo retenido); corregí las pruebas, no la aserción del requisito.
3. **DATA/ENVIRONMENT** — el invariante global del ledger se rompe en pruebas si dos suites comparten las cuentas de plataforma de TigerBeetle: `mode.spec` usa `useIdNamespace` como `invariant.spec`.

## No cubierto
- **Los otros servicios no se corrieron.** `pay-payments` ya manda `X-Pay-Mode` al ledger (`clients/ledger.client.ts`) y `pay-schedules` también (`ledger.client.ts:74`); **no verifiqué** que `pay-schedules`, `pay-payments` ni `pay-backoffice` lo manden a `pay-settlement` (`POST /payouts`, `/charges`): si no lo mandan, reciben `403`.
- `pay-edge` → `pay-settlement` `GET /payouts`: el borde reenvía `x-pay-mode`; no ejercité el borde real, solo la cabecera en la prueba.
- Los dobles siguen siendo dobles (`FakeLedger`, `FakeConnectors`, `ConnectorsServer`); el modo contra el ledger real se probó en `ledger-real.spec` (payouts), no el corte con ventana de tiempo ni la conciliación.
- Los eventos `ledger.*`, `settlement.batch.closed` y `reconciliation.exception.opened` **no llevan `mode`** (el AsyncAPI no lo declara): propuesta 1.
- No corrí `yarn contracts:lint`/`contracts:events` ni la suite de `contracts/`.

## Desvíos del plan
Ninguno. Se agregó la corrección de la carrera de `AccountRegistry` (hallazgo 1) dentro de H1.M2/M4 porque su prueba la necesitaba.

## Riesgos residuales
- Cambió la derivación de los ids del ledger: en un ledger con datos sería una migración (solo desarrollo hoy, O2-D8).
- Un `PayMode` ausente en un llamador interno ahora rompe esa llamada con `403` (es lo pedido; ver «No cubierto»).

## Decisiones y ambigüedades
- Ver [DECISIONES-TOMADAS.md](./DECISIONES-TOMADAS.md). Ambigüedad principal: el coordinador dijo «rutas que mueven dinero»; exigí el modo en **todas** las rutas internas porque las lecturas filtran por modo y la conciliación lee el ledger de un modo. A confirmar con el coordinador.

## Procesos
TigerBeetle (pid 15128, `platform/scripts/tigerbeetle-dev.sh`) levantado por mí: se detiene al terminar este reporte. Sin otros procesos en segundo plano.
