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
