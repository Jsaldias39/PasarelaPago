# Contratos de la ola 2 — integración de las propuestas de la ola 1

> **Estado: los 13 contratos son válidos y consistentes entre sí (`RUNS`). 8 pruebas de servicios quedan en rojo A PROPÓSITO: son las que exigen que el servicio
> repita lo que dice el contrato (rutas, conteos, `KNOWN_422_GAPS`); cada una está en §5 con el cambio exacto. Las otras 2.407 pasan (2.416 con TigerBeetle).**
> De 79 propuestas: 46 aplicadas · 5 quedan como decisión del dueño · 11 descartadas (9 por duplicadas o conflictivas, 2 por innecesarias)
> · 1 ya cubierta · 16 no son un contrato (librerías, plataforma, otros repos) y pasan al coordinador.
> `yarn contracts:lint`: 11 → 13 contratos válidos. `yarn contracts:events`: 38 → 40 mensajes válidos, 333 → 350 mutantes rechazados, 0 PII.
> Salida literal antes y después en [`evidencia/`](./evidencia/). Ningún servicio, ni sus dobles de prueba, fue editado.

- Fecha: 2026-10-27 · Rama: `claude/adoring-allen-ly7r6f` · Fuentes: `docs/trabajo/ola-1/P{1..5}/PROPUESTAS.md` y `DECISIONES-TOMADAS.md`,
  `docs/plan/PLAN-MAESTRO.md` (§5 y §6), `docs/plan/DECISIONES.md`, `CLAUDE.md`.
- Peldaño de evidencia (regla 30): **`RUNS`** para los contratos (lint y eventos con código de salida 0) y **`TESTED`** para el efecto sobre los
  servicios (suites dirigidas, una a la vez; ver §5). No es `VERIFIED`: ningún flujo de punta a punta se ejercitó (eso es la ola 2 propiamente dicha).

## 1 · Cómo se clasificó

| Clase | Significa |
|---|---|
| **TECNICA** | Se puede decidir sin el dueño del negocio: es forma, consistencia entre carriles o documentar lo que el código ya hace. Se aplica. |
| **NEGOCIO** | Depende de una decisión `Q-xx`, del stakeholder o de contabilidad/legal. No se aplica: queda en §6 con la pregunta exacta. |
| **DUPLICADA / CONFLICTIVA** | Otra propuesta pide lo mismo (se aplica una vez, en la canónica) o dos carriles piden formas incompatibles (se elige una con el código). |

Reglas que se siguieron: nunca se inventó un valor ni una regla de negocio (ningún límite, umbral, comisión ni cifra nueva en un contrato);
`common.yaml` solo recibió **adiciones** (0 líneas borradas); ante una ruptura posible se prefirió un campo opcional o un enum ampliado, con
el valor viejo aceptado como alias. El único estrechamiento es `enabled_events` de los webhooks (de un patrón a la lista de 21 tipos), que
`pay-webhooks` ya imponía (§3, fila 15).

## 2 · Las 79 propuestas

Decisión: **APLICADA** · **YA APLICADA** (antes de esta ola) · **DUEÑO** (§6) · **DUPLICADA→id** (descartada; se aplicó en `id`) · **DESCARTADA**
(innecesaria, con razón) · **CUBIERTA** (el contrato ya lo dice) · **FUERA** (no es un contrato; destinatario indicado).
Nombres de archivo abreviados: `common`, `public`, `ledger`, `settl`, `conn`, `pays`, `risk`, `qr`, `merch` = `contracts/openapi/{…}.yaml` (los internos
son `internal-{…}-v1.yaml`); `ev-pay`, `ev-conn`, `ev-led`, `ev-mer` = `contracts/asyncapi/{payments, connectors, ledger-settlement, merchants-schedules}.yaml`;
`catalog` = `contracts/packages/problem/src/catalog.ts`; `problem.schema` = `contracts/schemas/problem.schema.json`.

### P1

| Id | Qué pide | Clase | Decisión | Archivos tocados |
|---|---|---|---|---|
| P1-1 | Fijar `@mikro-orm/*` en 7.1.7 | TECNICA | **FUERA**: `package.json` raíz (§7) | — |
| P1-2 | Códigos `upstream_error/unavailable/timeout` (502/503/504) | TECNICA | **APLICADA**: catálogo + tres respuestas comunes + todas las operaciones públicas | catalog, common, public |
| P1-3 | `Mandate` no podía validar (`allOf` + `additionalProperties:false`) | TECNICA | **YA APLICADA** (verificada: lint verde y `pay-edge/test/contract-mandate.spec.ts` pasa) | public |
| P1-4 | `X-Pay-Mode` (D-28) en contratos internos y respuesta pública | TECNICA | **APLICADA** (opcional hasta la ola 2; ver §3 fila 4) | common, ledger, settl, conn, pays, public |
| P1-5 | `403`/`429`/`422` uniformes en toda operación pública | TECNICA | **APLICADA** en las 20 operaciones (más `400`/`409` en los `POST`, `502/503/504`) | public |
| P1-6 | Webhooks: catálogo, payload, paginación, códigos 422, idempotencia, `v1a` | TECNICA | **APLICADA** (los 8 puntos) | public |
| P1-7 | Credenciales NATS por servicio | TECNICA | **FUERA**: `platform/`, ola 3 (§7) | — |
| P1-8 | Script `contracts:breaking` | TECNICA | **FUERA**: `package.json` raíz (§7) | — |
| P1-9 | Códigos del 422 del borde (`card_number_detected`, `invalid_json`) | TECNICA | **APLICADA** | problem.schema, public |
| P1-10 | DDL de `pay_edge`/`pay_webhooks` al modelo (D-18) | TECNICA | **FUERA**: repo `mantra-core-health-model` | — |

### P2

| Id | Qué pide | Clase | Decisión | Archivos tocados |
|---|---|---|---|---|
| P2-1 | Publicar la matriz llamador → tipo de cuenta | TECNICA | **APLICADA** (documenta `accounts.ts`; la confirmación va a §6) | ledger |
| P2-2 | `kind` `release` en `ledger.transfer.posted` | TECNICA | **APLICADA** como decisión: `release` **no se publica** (lo informa `settlement.batch.closed`); es lo que hace el código (`KIND.release = null`) | ledger, ev-led |
| P2-3 | `code` en `HoldCreate` | TECNICA | **DESCARTADA**: el ledger lo deduce del destino y ningún llamador lo necesita; se documentó la regla de deducción | ledger |
| P2-4 | `bad_request` vs `400` sin código en ledger/settlement | TECNICA | **APLICADA**: `bad_request` (400) al catálogo y `422 validation_failed` declarado donde faltaba (§3 fila 12) | catalog, ledger, settl |
| P2-5 | Declarar `503 ledger_unavailable` | TECNICA | **APLICADA** en ledger y settlement (no en conectores: no lo emiten) | ledger, settl |
| P2-6 | `payout.created` exige `settlement_batch_id` pero hay pagos sin lote | TECNICA | **APLICADA**: el lote pasa a opcional | ev-led |
| P2-7 | `rail_rejected` en `payout.failed` | TECNICA | **APLICADA** (enum ampliado) | ev-led, settl |
| P2-8 | `unknown_reference` en la conciliación y `mock`/`simulator` | TECNICA | **APLICADA** | ev-led |
| P2-9 | `pay-settlement` consume `ledger.transfer.posted` y `fee_schedule.published` | TECNICA | **APLICADA**: operación `receive` nueva (`fee_schedule.published` ya la tenía) | ev-led |
| P2-10 | `POST /charges` (cobro neto 7.8 / deuda D-22) | TECNICA | **APLICADA** tal como está implementado | settl |
| P2-11 | `GET /exports/accounting` | TECNICA | **APLICADA** tal como está implementado; el formato final lo confirma M16 (§6) | settl |
| P2-12 | `resolve` sin `401` | TECNICA / CONFLICTIVA | **APLICADA**: `401` credencial ausente/inválida, `403` rol insuficiente (como `pay-merchants` y `pay-risk`; §3 fila 17) | settl |
| P2-13 | Dos contratos definen `GET /payouts` | TECNICA | **APLICADA** (documentado) | settl |
| P2-14 | Nombrar al llamador «consola interna» | NEGOCIO | **DUEÑO** (§6, D-1) | — |
| P2-15 | `StatementFormat` por conector | NEGOCIO | **DUEÑO** (§6, D-2): depende de Q-11 | — |
| P2-16 | Conector de `TransferCreate` por modo y `destination_ref` | TECNICA + NEGOCIO | **APLICADA** la parte técnica (`mock` en sandbox, `bank_transfer` en live); `destination_ref` sigue en Q-22 (§6, D-3) | conn |
| P2-17 | Cuenta `merchant:{id}:debt` en `Account` y contracargo partido | TECNICA | **APLICADA**; el código `chargeback` explícito queda diferido (nadie lo necesita: el ledger lo reconoce por la forma) | ledger |

### P3

| Id | Qué pide | Clase | Decisión | Archivos tocados |
|---|---|---|---|---|
| P3-1 | Declarar `503` en ledger y conectores | TECNICA | **APLICADA** en ledger (y settlement, P2-5); **no** en conectores: no emiten `503` (§3, fila 9) | ledger, conn |
| P3-2 | Id del asiento `tx_` vs `tf_` | CONFLICTIVA (con P5-9) | **APLICADA**: `ledger_transfer_id` cita `tx_`/`hd_` (§3 fila 1) | ev-pay, ev-mer, ev-led, ledger |
| P3-3 | `mock` vs `simulator` | DUPLICADA | **DUPLICADA→P4-3.1** | — |
| P3-4 | `risk_denied` y `payment_declined` | TECNICA | **APLICADA** (catálogo + enum de `payment_intent.failed`) | catalog, ev-pay, pays |
| P3-5 | Evento `payment_intent.contradiction_detected` | TECNICA | **APLICADA** (evento interno nuevo; `kind` cubre también el resultado ambiguo de la regla 11) | ev-pay |
| P3-6 | API de disputas | NEGOCIO | **DUEÑO** (§6, D-4): depende de Q-11 y Q-18 | pays (solo nota) |
| P3-7 | Datos de cuenta en `bank_transfer_instructions` | TECNICA | **APLICADA**: tres campos opcionales que informa el conector | conn |
| P3-8 | `connector_transaction_id` `ct_` vs `ch_` | CONFLICTIVA | **APLICADA**: `ch_`/`cr_` (§3 fila 3) | ev-conn |
| P3-9 | D-28: `X-Pay-Mode` y `mode` | DUPLICADA | **DUPLICADA→P1-4** (la cabecera) y P5-12 (el campo en eventos) | — |
| P3-10 | `GET /refunds/{id}` y listado de reembolsos | TECNICA | **APLICADA** `GET /refunds/{id}`; el listado queda diferido (no existe en el servicio ni lo pide un flujo E1–E8) | public |
| P3-11 | Consulta de estado de un reembolso en el conector | TECNICA | **APLICADA**: `GET /refunds/{id}` en conectores | conn |
| P3-12 | Códigos de campo para el catálogo | TECNICA | **APLICADA** | problem.schema |
| P3-13 | `eslint.config.mjs` falla en `jest.config.cjs` | TECNICA | **FUERA**: configuración raíz (§7) | — |
| P3-14 | Postgres compartido satura `max_connections` | TECNICA | **FUERA**: plataforma/librería (el Compose ya subió a 400; falta `@pay/testing`, §7) | — |

### P4

| Id | Qué pide | Clase | Decisión | Archivos tocados |
|---|---|---|---|---|
| P4-1 | Contrato `internal-qr-v1.yaml` | TECNICA | **APLICADA** (copiado a `contracts/openapi/`; la propuesta de la ola 1 queda como origen) | qr |
| P4-2.1 | `refund_id` en `POST /charges/{id}/refunds` | TECNICA | **APLICADA** (opcional) | conn |
| P4-2.2 | `card_token` opcional para tarjeta | TECNICA | **APLICADA** (documentado; D-17) | conn |
| P4-2.3 | `bad_request` al catálogo | TECNICA | **APLICADA** | catalog |
| P4-2.4 | `description` de extracto siempre `null` | TECNICA | **APLICADA** (documentado) | conn |
| P4-2.5 | `500 internal_error` es resultado ambiguo | TECNICA | **APLICADA** (cobros, reembolsos y transferencias) | conn |
| P4-2.6 | `Transfer.failed` siempre trae `failure_code` | TECNICA | **APLICADA** (documentado, con los cuatro códigos) | conn |
| P4-2.7 | `next_action` ausente en estados terminales | TECNICA | **APLICADA** (documentado) | conn |
| P4-3.1 | Unificar `mock`/`simulator` | TECNICA | **APLICADA**: `mock` canónico, `simulator` alias aceptado (§3 fila 2) | ev-conn, ev-pay, ev-led |
| P4-3.2 | `card_declined` en `failure_code` del evento | TECNICA | **APLICADA** | ev-conn |
| P4-3.3 | Evento `connector.transfer.status_changed` | TECNICA | **APLICADA** (señal; la consulta autoritativa sigue siendo `GET /transfers/{reference}`) | ev-conn |
| P4-3.4 | `connector.health.degraded` se publica al pasar a `down` | TECNICA | **APLICADA** (descripción corregida; el `OpenAPI` citaba un evento `connector.health.changed` que no existe) | ev-conn, conn |
| P4-3.5 | Reembolso con `observed_via: callback` | TECNICA | **CUBIERTA**: `observed_via` ya admite `callback` | — |
| P4-4.1 | README de `@pay/idempotency`: 5xx no se guarda | TECNICA | **FUERA**: librería (§7) | — |
| P4-4.2 | Helper de matriz de identidad en `@pay/service-auth` | TECNICA | **FUERA**: librería (§7) | — |
| P4-4.3 | `log-safe.ts` a la plantilla | TECNICA | **FUERA**: plantilla (§7) | — |
| P4-4.4 | `@PublicRoute()` en la plantilla | TECNICA | **FUERA**: plantilla (§7) | — |
| P4-4.5 | Pool de 60 conexiones en `@pay/testing` | DUPLICADA | **DUPLICADA→P3-14** | — |
| P4-4.6 | `eslint` ignora `jest.config.cjs` | DUPLICADA | **DUPLICADA→P3-13** | — |
| P4-4.7 | `OutboxRelay.stop()` espera el ciclo | TECNICA | **FUERA**: librería (§7) | — |
| P4-4.8 | `@pay/idempotency` guarda todo 4xx | TECNICA | **FUERA**: librería (§7) | — |
| P4-4.9 | Pool de 60 conexiones / `max_connections` | DUPLICADA | **DUPLICADA→P3-14** | — |
| P4-5 | Esquema de `pay_connectors`/`pay_qr` al modelo | TECNICA | **FUERA**: repo del modelo | — |

### P5

| Id | Qué pide | Clase | Decisión | Archivos tocados |
|---|---|---|---|---|
| P5-1 | `internal-merchants-v1.yaml` (back-office, 13 operaciones) | TECNICA | **APLICADA** (copiado a `contracts/openapi/`) | merch |
| P5-2 | Repetición de `POST /api_keys` y `/rotate` = `200` sin secreto | TECNICA | **APLICADA** (y `409` al rotar dos veces) | public |
| P5-3 | `X-Pay-Mode` en rutas públicas internas | DUPLICADA | **DUPLICADA→P1-4** | — |
| P5-4 | `loadEventContract` a `@pay/testing` | TECNICA | **FUERA**: librería (§7) | — |
| P5-5 | `quoteFee` en `@pay/money` | TECNICA | **FUERA**: librería (§7) | — |
| P5-6 | `already_exists` en el catálogo | TECNICA | **DESCARTADA**: el servicio ya lo dice con `validation_failed` + `errors[].code = already_registered`, y ese código de campo quedó documentado; un código de primer nivel exigiría cambiar el estado HTTP de `pay-merchants` sin que ningún consumidor lo pida | problem.schema |
| P5-7 | `api_key.revoked` con razón `merchant_closed` | NEGOCIO | **DUEÑO** (§6, D-5) | — |
| P5-8 | `OperatorGuard` a `@pay/service-auth` | TECNICA | **FUERA**: librería (§7) | — |
| P5-9 | `transfer_ids` (`tf_`) en `POST /transactions` | CONFLICTIVA (con P3-2) | **DUPLICADA→P3-2**: no hace falta; `ledger_transfer_id` cita el `tx_` que ya devuelve | — |
| P5-10 | `Mandate` inalcanzable | DUPLICADA | **DUPLICADA→P1-3** | — |
| P5-11 | `risk`: `entity_type`, carga de límites, `503` | TECNICA | **APLICADA** las tres (`pay-risk` ya implementaba `entity_type` y `rule_sets`) | risk |
| P5-12 | `mode` en eventos `mandate.*`/`scheduled_payment.*` y `merchant.*` | TECNICA | **APLICADA** en los 21 eventos públicos (opcional); **no** en `merchant.*` (el comercio existe en los dos modos) | ev-mer, ev-pay, ev-led |
| P5-13 | Tope por mandato y pausa/reanudación | NEGOCIO | **DUEÑO** (§6, D-6) | — |
| P5-14 | `Leg.code` `release` vs `adjustment`; `void` repetido | TECNICA | **APLICADA** (semántica de cada código y repetición idempotente) | ledger |
| P5-15 | Pool de 60 conexiones | DUPLICADA | **DUPLICADA→P3-14** | — |

**Conteo:** aplicadas 46 (incluye P1-3 ya aplicada y las dos con parte de negocio, P2-16 y P2-11) · decisión del dueño 5 (P2-14, P2-15, P3-6, P5-7, P5-13)
· descartadas por duplicadas o conflictivas 9 (P3-3, P3-9, P4-4.5, P4-4.6, P4-4.9, P5-3, P5-9, P5-10, P5-15) · descartadas por innecesarias 2 (P2-3, P5-6)
· cubierta 1 (P4-3.5) · fuera de `contracts/` 16 (P1-1, P1-7, P1-8, P1-10, P3-13, P3-14, P4-4.1 a 4.4, P4-4.7, P4-4.8, P4-5, P5-4, P5-5, P5-8).
Además hay **5 preguntas de negocio adjuntas a propuestas ya aplicadas** (§6, D-3 y D-7 a D-10).

## 3 · Discrepancias entre carriles: la forma elegida y por qué

| # | Discrepancia | Forma elegida | Evidencia en el código |
|---|---|---|---|
| 1 | Id del asiento: `tx_…` (ledger) vs `tf_…` (eventos) vs P5 pidiendo `transfer_ids` | `ledger_transfer_id` (de `payment_intent.succeeded`, `refund.succeeded`, `dispute.lost`, `scheduled_payment.executed`) cita el **asiento `tx_…` o la retención `hd_…`** que el ledger ya devolvió. El patrón acepta además `tf_…` por compatibilidad. `ledger.transfer.posted.transfer_id` sigue siendo `tf_…` (una **pata**). **No** se agrega `transfer_ids`. | `pay-ledger/src/ledger/ledger.service.ts:134` (`publicId('tx', business_ref, attempt)`) y `:175` (`publicId('tf', sourceId, index)`): un asiento de N patas tiene N `tf_` y no hay operación para consultarlos. `pay-payments/src/domain/ids.ts:21` (`transferIdForEvent`) fabrica `tf_<cuerpo del tx_>`, que no coincide con ninguna pata real; en el reembolso ni siquiera parte de un `tx_` sino de un `hd_` (`activities-money.ts:75`). `pay-schedules/src/ledger/ledger.client.ts:142` espera un `transfer_ids` que el ledger real no devuelve (queda `needs_review` y sin evento). |
| 2 | Conector simulador: `mock` (APIs) vs `simulator` (eventos) | **`mock`** en todo. `simulator` queda como alias aceptado en los cuatro `ConnectorCode` de los eventos mientras los productores migran. | `mock` es el valor de `internal-connectors-v1`, de la base (`CHECK` del conector), de `runCreate` en `pay-settlement` y de la configuración (`CONNECTOR_MOCK_WEBHOOK_SECRET`, `SETTLEMENT_TRANSFER_CONNECTOR`). `simulator` existe solo como traducción en tres productores (`pay-connectors/src/domain/status-map.ts:27`, `pay-payments/src/events/emit.ts:16`, `pay-settlement/src/settlement/settlement-events.ts:136`) y en seis pruebas que la fijan. |
| 3 | Transacción del conector: `ct_…` (eventos) vs `ch_…` (API) | El evento cita **`ch_…` (cobro) o `cr_…` (reembolso)**; `ct_…` se acepta como histórico. | `pay-connectors/src/ids.ts:20` deriva `ct_` de `ch_`/`cr_` («determinista, sin columna extra»): es una traducción para cumplir el contrato, no un recurso. Ningún servicio lee `connector_transaction_id` (solo lo usa un fixture de `pay-payments`). Con `ch_`/`cr_` el consumidor puede ir a `GET /charges/{id}/status` o `GET /refunds/{id}`. |
| 4 | `X-Pay-Mode` (D-28) | Parámetro `PayMode` en `common.yaml` (`test\|live`), opcional en el contrato hasta que `pay-ledger`/`pay-payments`/`pay-settlement`/`pay-connectors` lo implementen (ola 2); `pay-merchants` y `pay-schedules` ya lo exigen (`403` sin él). El modo de la **clave** (`test\|live`) no es el del **despliegue** (`sandbox\|live`, D-26); la respuesta pública de un sandbox lleva `X-Pay-Mode: sandbox`. Los 21 eventos públicos pueden llevar `mode` (`test\|live`). | `pay-edge/src/proxy/edge.pipeline.ts:94` reenvía `principal.mode` (`test\|live`) y `:104` marca `sandbox`; `authz.spec.ts` fija «EXACTAMENTE el modo del registro». El defecto que P5 reportó (`sandbox` reenviado) **no está en este árbol**. `pay-merchants` (`public.controller.ts`) y `pay-schedules` (`mandates.controller.ts`) responden `403` sin la cabecera; el ledger real la ignora y `pay-schedules` ya la envía (`ledger.client.ts:74`). Se dejó opcional para no romper a quien todavía no la manda. |
| 5 | Cuenta `merchant:{id}:debt` en el patrón `Account` | El patrón la admite; el contrato documenta su naturaleza deudora, la invariante `credits_must_not_exceed_debits` y que el reparto del contracargo lo hace el servidor. | `pay-ledger/src/ledger/accounts.ts` (`ACCOUNT_PATTERN` ya incluye `debt`; `merchant_debt` en la matriz de `pay-payments` y `pay-settlement`) y `chargeback.ts`. |
| 6 | `transfer_ids` en `POST /transactions` | **No se agrega** (ver fila 1). | Ídem fila 1. |
| 7 | Evento `payment_intent.contradiction_detected` | Evento interno nuevo (`pay-payments` → `pay-settlement`), único por cobro y evento de origen; `kind` incluye `status_conflict`, `compensation_failed`, `refund_pending_timeout` y `<paso>_outcome_unknown`. | `pay-payments/sql` crea `intent_contradictions` con `(payment_intent_id, source_event_id)` único y `kind`; `contradictionsRepo.record` se llama desde `handlers.ts:72`, `activities.ts:73/254/264` y `activities-money.ts:97/148`. Hoy nadie lo publica ni lo consume. |
| 8 | API de disputas | **No se aplica**: decisión del dueño (§6, D-4). | `DisputesService` y `DisputeWorkflow` existen sin ruta HTTP; quién abre una disputa depende del aviso de contracargo del Mercantil (Q-11) y de si el comercio ve el recurso (Q-18). |
| 9 | Consulta de estado de un reembolso en el conector | `GET /refunds/{id}` (`cr_…`, `refresh` opcional, `stale`) en `internal-connectors-v1`. | `pay-payments` (P3-D11) deja el reembolso `pending` «para siempre» porque no puede consultar (regla 11 del `CLAUDE.md`). El conector escribe la fila `cr_…` **antes** de llamar al proveedor (`refunds.service.ts`), por lo que un `404` del propio servicio sí es concluyente. Sobre `503` en conectores: `grep` no encuentra ninguno en `pay-connectors/src`; la caída es `502 connector_unavailable` y lo ambiguo es `500 internal_error`, y así quedó escrito. |
| 10 | `internal-qr-v1` | Copiado a `contracts/openapi/internal-qr-v1.yaml` con los `$ref` a `common.yaml`. | `pay-qr/test/qr.spec.ts:249` ya exige que las rutas del controlador sean exactamente las operaciones de ese contrato. |
| 11 | `refund_id` en el pedido de reembolso al conector | Campo opcional `refund_id` (`re_…`) en el cuerpo y en `ConnectorRefund`; el evento lo copia. | `pay-connectors/src/core/events.ts:37` fija `refund_id: null` porque el conector «no conoce el id de pay-payments»; sin él, dos reembolsos del mismo cobro no se distinguen. |
| 12 | `bad_request` (400) vs `422 validation_failed` | **Dos códigos, dos usos.** `422 validation_failed` = cuerpo, campo o parámetro **bien formado pero inválido** (lo que ya devuelven ledger, settlement, payments, merchants…). `400` = `idempotency_key_required` o **`bad_request`** (petición ilegible: cuerpo que no se puede leer, referencia mal formada). `bad_request` entra al catálogo. | `pay-ledger` y `pay-settlement` devuelven `422` donde el contrato declaraba solo `400` (`KNOWN_422_GAPS` en `test/helpers/app.ts` de ambos); `pay-connectors/src/raw-problem.ts` fabrica a mano un `bad_request` 400 porque el catálogo no lo tenía. Se declaró el `422` que faltaba y se documentó el reparto. |
| 13 | `connector.transfer.status_changed` | Evento nuevo, **señal** para `pay-settlement`; la fuente autoritativa sigue siendo `GET /transfers/{reference}`. Sin `merchantid` obligatorio. | Una transferencia pasa por `pending → in_transit → paid` o `failed` (`TransferStatus`) y hoy `pay-settlement` solo la averigua sondeando (`payout.service.ts`); `pay-connectors` no tiene dónde anunciar un callback de una transferencia saliente. |
| 14 | `403`/`429` en operaciones públicas | Declarados en las 20 operaciones junto con `401`, `422`, `502/503/504` y, en los `POST`, `400` y `409`. | `pay-edge` los emite desde cualquier ruta (`authz.spec.ts`, `proxy.spec.ts`); solo `POST /payment_intents` los declaraba, por eso los tests de contrato del borde solo cubrían esa operación. |
| 15 | Catálogo de eventos de webhook | `enabled_events` pasa a la lista cerrada de **21 tipos** + `*` (`WebhookEventType`); se documenta el cuerpo entregado (`WebhookEvent`) y la política de payload. | `pay-webhooks/src/events/public-events.ts` (`PUBLIC_EVENT_TYPES`, 21) y `payload-policy.ts:117` (`{id, object:'event', type, created_at, mode, data:{object}}`). El servicio ya rechazaba cualquier otro con `422 unknown_event_type`: el contrato dejó de prometer más. |
| 16 | Códigos `upstream_*` | `upstream_error` (502), `upstream_unavailable` (503), `upstream_timeout` (504) al catálogo y a `common.yaml`. | `pay-edge/src/edge-problem.ts` los arma con un `EXTRA` propio hasta que el catálogo los tenga (`type: urn:alovida:pay:problem:<code>`, el mismo formato del catálogo). |
| 17 | Credencial de operador: `401` vs `403` | `401` si falta, venció o no verifica; `403` si es válida pero sin el rol. | `pay-merchants` y `pay-risk` (copias de `OperatorGuard`) responden `401` sin verificador y `403` por rol; `pay-settlement` (`settlement.controller.ts`, `resolveException`) responde `403` en todos los casos. |

Otras formas que se fijaron al pasar:

- **Repetición con la misma `Idempotency-Key` de una respuesta con secreto.** Hoy divergen: `pay-merchants` (claves de API) devuelve `200` **sin** el secreto;
  `pay-webhooks` repite el mismo cuerpo **con** el secreto (lo guarda sellado). Se documentaron las dos como están, porque las dos están implementadas y probadas;
  unificarlas es una decisión de seguridad (§6, D-10).
- **`risk`:** el borrador decía «cribado caído ⇒ 503», la decisión de la ola 0 (H-WM1) y `pay-risk` dicen `review`. Gana la decisión: el `503` queda reservado.

## 4 · Cambios por archivo de `contracts/`

| Archivo | Cambio |
|---|---|
| `openapi/common.yaml` | Solo adiciones: parámetro `PayMode`, cabecera `XPayModeSandbox`, respuestas `BadGateway`, `ServiceUnavailable`, `GatewayTimeout`. |
| `openapi/public-v1.yaml` | Respuestas uniformes en las 20 operaciones; `GET /refunds/{id}`; `200` de repetición en `POST /api_keys` y `/rotate`; `enabled_events` cerrado (`WebhookEventType`); `WebhookEvent` y `webhooks:`; paginación del listado de endpoints; texto de errores, modo e idempotencia. |
| `openapi/internal-ledger-v1.yaml` | Cuenta `debt`, matriz de llamadores, semántica de ids y de `Leg.code`, `PayMode`, `422` y `503` en todas las operaciones, anulación idempotente. |
| `openapi/internal-settlement-v1.yaml` | `POST /charges` y `GET /exports/accounting` con sus esquemas; llamadores; `401` en `resolve`; `422` y `503` en todas; `rail_rejected`. |
| `openapi/internal-connectors-v1.yaml` | `GET /refunds/{id}`; `refund_id`; datos de cuenta en `bank_transfer_instructions`; semántica de errores y resultado ambiguo; `mock` canónico; `PayMode`. |
| `openapi/internal-risk-v1.yaml` | `entity_type`; `POST /rule_sets` y `GET /rule_sets/current`; cribado caído ⇒ `review`; códigos de motivo. |
| `openapi/internal-payments-v1.yaml` | `PayMode`; disputas fuera del contrato (nota); códigos de `failure_code`. |
| `openapi/internal-qr-v1.yaml`, `openapi/internal-merchants-v1.yaml` | **Nuevos**, copiados de las propuestas de P4 y P5. |
| `asyncapi/payments.yaml` | `payment_intent.contradiction_detected`; `risk_denied`/`payment_declined`; `ledger_transfer_id` acepta `tx_`/`hd_`; `mock`; `mode`. |
| `asyncapi/connectors.yaml` | `connector.transfer.status_changed`; `ch_`/`cr_`; `card_declined`; `mock`. |
| `asyncapi/ledger-settlement.yaml` | `settlement_batch_id` opcional; `rail_rejected`; `unknown_reference`; `mock`; `pay-settlement` consume `ledger.transfer.posted`; `mode`. |
| `asyncapi/merchants-schedules.yaml` | `ledger_transfer_id` acepta `tx_`/`hd_`; `mode`. |
| `schemas/problem.schema.json` | Descripción de los códigos de campo (sin cambio de forma). |
| `packages/problem/src/catalog.ts` | Seis códigos nuevos: `bad_request`, `risk_denied`, `payment_declined`, `upstream_error`, `upstream_unavailable`, `upstream_timeout`. |
| `packages/testing/src/openapi.spec.ts` | El conteo independiente de operaciones públicas pasa de 19 a 20. |

## 5 · Servicios que deben adaptarse

**OBLIGATORIA** = hoy hay una prueba en rojo por el cambio de contrato (salida en `evidencia/test-<servicio>.txt`). **RECOMENDADA** = el contrato
ya lo permite y el servicio sigue verde, pero la ola 2 lo necesita. No se editó ningún servicio.

| Servicio | Tipo | Cambio exacto | Prueba |
|---|---|---|---|
| `pay-edge` | **OBLIGATORIA** | (1) `src/routes.ts`: agregar `{ method: 'GET', template: '/refunds/{id}', upstream: 'pay-payments', idempotencyKey: false, query: [] }`. (2) `src/routes.ts`: `GET /webhook_endpoints` pasa de `query: []` a `query: [...LIST]` (`pay-webhooks` ya acepta `limit` y `starting_after`; hoy el borde los rechaza con `422 unknown_parameter`). (3) `test/routes.spec.ts`: `toHaveLength(19)` → `20`. | 3 rojas en `test/routes.spec.ts`: «tiene EXACTAMENTE las operaciones del contrato», «GET /webhook_endpoints: Idempotency-Key y consulta coinciden», «cada método del contrato está cubierto». Las otras 321 pasan. |
| `pay-edge` | recomendada | `src/edge-problem.ts`: borrar `EXTRA` y usar el catálogo (`upstream_*` ya está; mismo `type`, estado y título). | — |
| `pay-ledger` | **OBLIGATORIA** | `test/helpers/app.ts:97`: vaciar `KNOWN_422_GAPS` (el contrato ya declara el `422` de `GET /balances`, `GET /statements`, `POST /holds/{id}/void`, `GET /transactions/{business_ref}` y `GET /holds/{id}`) y quitar la tolerancia de la línea 109; el test «siguen siendo ciertas» (`contract.spec.ts:75`) pasa a comprobar que el conjunto está vacío. | 1 roja: «divergencias conocidas del contrato … hay que borrar la entrada de KNOWN_422_GAPS». Las otras 155 pasan (con TigerBeetle local). |
| `pay-ledger` | recomendada (ola 2, D-28) | Leer `X-Pay-Mode`: `403 forbidden` si falta o no es `test\|live`; guardar `mode` y filtrar por `(comercio, modo)`. Después, pasar `PayMode` a `required: true` en el contrato. | — |
| `pay-settlement` | **OBLIGATORIA** | `test/contract.spec.ts:37`: las rutas fuera del contrato pasan de `['GET /exports/accounting', 'POST /charges']` a `[]` (ya están en el contrato) y el título deja de decir «PROPUESTAS». | 1 roja: «las únicas rutas fuera del contrato son las dos PROPUESTAS declaradas». Las otras 394 pasan; las 9 de `ledger-real.spec.ts` fallan solo si TigerBeetle no está levantado (ENVIRONMENT) y pasan con él (`test-pay-settlement-ledger-real.txt`). |
| `pay-settlement` | recomendada | (a) `resolveException`: `401 unauthorized` si la credencial falta, venció o no verifica; `403 forbidden` solo por rol (hoy `403` siempre, P2-D22) y su prueba. (b) `settlement-events.ts:10`: agregar `rail_rejected` a `EVENT_FAILURE_CODES` y emitirlo en vez de `internal_error`. (c) `settlement-events.ts:136`: emitir `mock`, no `simulator` (y la prueba `reconciliation.spec.ts:70`). (d) Emitir `payout.created` también para pagos sin lote. (e) Vaciar `KNOWN_422_GAPS` (`test/helpers/app.ts:168`): ya es código muerto. (f) Ola 2: consumir `connector.transfer.status_changed` y `payment_intent.contradiction_detected`; `X-Pay-Mode`. | — |
| `pay-connectors` | **OBLIGATORIA** | Implementar `GET /refunds/{id}` (`cr_…`, `refresh` opcional, `stale`): ruta en `charges.controller.ts`, lectura de `connector_refunds` (la fila existe antes de llamar al proveedor), `@AllowedServices('pay-payments')`, la fila en la matriz de identidad de `test/contract.spec.ts` y `toHaveLength(10)` → `11`. | 3 rojas en `test/contract.spec.ts`: «cada operación del contrato tiene su ruta…», «la prueba FALLA si una operación del contrato no tiene ruta…», «la matriz cubre todas las operaciones protegidas». Las otras 516 pasan. |
| `pay-connectors` | recomendada | (a) Aceptar `refund_id` en `POST /charges/{id}/refunds`, guardarlo, devolverlo en `ConnectorRefund` y copiarlo al evento (`core/events.ts:37` hoy fija `null`). (b) Emitir `mock` (borrar `eventConnectorCode`, `domain/status-map.ts:27`) y `ch_`/`cr_` (borrar `connectorTransactionId`, `ids.ts:20`); ajustar las seis pruebas que fijan `simulator`/`ct_`. (c) `eventFailureCode` deja pasar `card_declined`. (d) `bank_transfer_instructions` con `bank_name`, `account_holder`, `account_number` desde la configuración del conector. (e) Publicar `connector.transfer.status_changed`. (f) `X-Pay-Mode`. | — |
| `pay-payments` | recomendada | (a) Ruta `GET /refunds/{id}` → `PaymentsService.getRefund` (junto con la fila de `pay-edge`). (b) `risk_denied` cuando riesgo responde `deny`/`review` y `payment_declined` ante `card_declined` del conector, en vez de `validation_failed` (`FAILURE_MESSAGES` de `serializers.ts`, `INTENT_FAILURE_CODES` de `events/emit.ts:8`). (c) Borrar `transferIdForEvent` (`domain/ids.ts:21`) y citar `intent.ledgerTransferId` (`tx_`) y `refund.ledgerHoldId` (`hd_`) tal cual (`emit.ts:44/73/96`). (d) `CONNECTOR_CODE` → `mock` (`emit.ts:16`). (e) Mandar `refund_id` al conector y, ante un reembolso `pending` sin aviso, consultar `GET /refunds/{id}` (reemplaza la espera indefinida de P3-D11). (f) Tomar los datos de la cuenta de `bank_transfer_instructions` del conector, con `BANK_TRANSFER_*` solo de respaldo hasta T-03. (g) Publicar `payment_intent.contradiction_detected` desde `contradictionsRepo.record`, en la misma transacción (outbox). (h) D-28: columna `mode`, filtro `(comercio, modo)`, `X-Pay-Mode` hacia ledger y conectores, `mode` en los eventos. | — (207 pasan) |
| `pay-schedules` | recomendada | (a) `scheduled_payment.executed.ledger_transfer_id` ← `Transaction.id` (`tx_`) en vez de esperar un `transfer_ids` que el ledger no devuelve (`ledger.client.ts:142`, `executor.service.ts:271-297`): desaparece el camino «ejecutado pero `needs_review` y sin evento»; `executor.spec.ts:59` pasa de `^tf_` a `^(tx\|hd)_`. (b) El asiento inverso de un beneficiario bloqueado usa `code: 'adjustment'`, no `release`. (c) `mode` en `mandate.*` y `scheduled_payment.*`. | — (129 pasan) |
| `pay-merchants`, `pay-risk`, `pay-qr` | recomendada | Que sus pruebas lean `contracts/openapi/internal-{merchants,risk,qr}-v1.yaml` y no las copias de `docs/trabajo/ola-1/P{4,5}/…`; `pay-risk` ya no necesita `internal-risk-rule-sets-v1.yaml` aparte (las dos operaciones están en `internal-risk-v1.yaml`). | — (90 / 149 / 44 pasan) |
| `pay-webhooks`, `pay-vault` | ninguna | Sin cambio requerido: `enabled_events` ya se validaba contra los 21 tipos y la paginación del listado ya estaba implementada. | — (344 / 58 pasan) |

Compatibilidad hacia atrás: **todo cambio de contrato es aditivo o amplía un enum**, con dos excepciones que no se pudieron hacer opcionales:
(1) `GET /refunds/{id}` público y del conector son operaciones **nuevas** que dos pruebas de «las rutas son exactamente las del contrato» exigen implementadas
(los tres servicios de arriba); (2) `enabled_events` de los webhooks **se estrecha** de un patrón a la lista de 21 tipos, lo que el servicio ya imponía. Sin
`oasdiff` en el entorno no se corrió `contracts:breaking`; la compatibilidad se verificó por el diff (`common.yaml`: 0 líneas borradas; en los demás, las
líneas borradas son descripciones o sustituciones por una forma más amplia) y por las suites de arriba.

## 6 · Decisiones para el dueño

Cada una trae la pregunta exacta, las opciones y mi recomendación. **Ninguna se aplicó.** Las D-1, D-2, D-4, D-5 y D-6 son las cinco propuestas que quedaron enteras en manos del dueño;
D-3 y D-7 a D-10 son preguntas adjuntas a propuestas que sí se aplicaron (la forma está en el contrato, el valor o la política no).

| # | Pregunta exacta | Opciones | Recomendación |
|---|---|---|---|
| **D-1** (P2-14, P5, Q-21, Q-23) | ¿La consola de operación (cortes, conciliación, exportación) y el back-office de comercios y riesgo son **un** servicio, y cómo se llama? ¿Existen los ocho roles de operador que los servicios asumen (`settlement_operator`, `settlement_admin`, `merchant_operator`, `kyc_reviewer`, `legal_admin`, `pricing_admin`, `security_operator`, `risk_admin`) en el servicio de identidad? | A) Uno solo, `pay-backoffice`, con esos roles. B) Dos: `pay-console` para liquidación (hoy en `pay-settlement`) y `pay-backoffice` para comercios y riesgo (hoy en `pay-merchants` y `pay-risk`). C) No decidir hasta que exista el servicio de identidad. | **A.** Ya es el nombre de dos de los tres servicios y de las dos propuestas de contrato; `pay-settlement` cambia dos constantes (`OPERATIONS`, `CHARGE_WRITERS` en `settlement.controller.ts`). Los roles son nombres **propuestos**, no existen: confirmarlos con identidad. |
| **D-2** (P2-15, Q-11) | ¿En qué formato entrega el Banco Mercantil el extracto y los avisos de cobro (camt.053, CSV o API) y qué campo devuelve nuestra referencia? | A) camt.053. B) CSV. C) API JSON. D) Depende del producto (QR, tarjeta, transferencia). | **No fijarlo.** Hasta que llegue la respuesta a los 15 puntos de `docs/spikes/banco-mercantil.md`, `mock` define el JSON y el contrato queda como está; cuando llegue, se declara por conector y no antes (D-26: el mock no inventa campos del banco). |
| **D-3** (P2-16, Q-22) | ¿Dónde se registra la cuenta de liquidación de cada comercio (banco, titular, número) y quién la valida? Es dato financiero sensible. | A) `directory` (M04) la guarda y `pay-merchants` referencia un id opaco. B) `pay-merchants` la guarda cifrada y la valida el back-office. C) El Mercantil guarda al beneficiario y la pasarela manda un alias. | **A o C**, nunca en `pay-settlement`. Mientras tanto `destination_ref = merchant_id` es un marcador de desarrollo, no una decisión. |
| **D-4** (P3-6, Q-11, Q-18) | ¿Quién abre una disputa y con qué aviso (el contracargo del banco, el back-office o el comercio) y el comercio ve el recurso y aporta evidencia por la API pública? Perder una disputa debita al comercio (D-22). ¿Hace falta un evento `payout.in_transit`? | A) Solo interno: el back-office abre, carga evidencia y resuelve; el comercio se entera por webhook `dispute.*` (hoy: los eventos existen, no hay ruta). B) A + recurso público de lectura y de evidencia. C) Esperar el proceso de contracargos del Mercantil. | **C**, y A cuando exista el aviso del banco; B no antes de la v1.1. `payout.in_transit`: no (el estado público ya existe; el evento no lo pide ningún flujo E1–E8). |
| **D-5** (P5-7) | ¿Cerrar un comercio revoca también sus claves de API? | A) Sí, en la misma transacción, con `api_key.revoked` y razón `merchant_closed`. B) No: el borde bloquea por `merchant.closed` (hoy, DT-2). | **A** como defensa en profundidad; no es urgente porque `pay-edge` ya bloquea. |
| **D-6** (P5-13, proceso 7.7) | ¿Un mandato tiene **tope** propio y se puede pausar y reanudar? El plan habla de «beneficiario, monto, calendario y tope». | A) Sin tope ni `PATCH` en la v1 (hoy: un tope global opcional `MANDATE_MAX_AMOUNT_MINOR`, sin valor por defecto). B) Campo opcional `max_amount_minor` por mandato y `PATCH` para pausar y reanudar. | **A**, salvo que el stakeholder confirme que 7.7 exige el tope por mandato. El valor lo da el negocio; nunca el código. |
| **D-7** (P2-1, P2-D1, P2-D6) | Contabilidad: ¿es correcta la matriz «llamador → tipos de cuenta del ledger» y «quién llama a qué en liquidación» que hoy está implementada y quedó publicada? | A) Confirmarla tal cual. B) Ampliarla (¿`pay-edge` o `pay-merchants` tocan alguna cuenta?). | **A.** La más estrecha que alcanza; se amplía cuando un flujo lo pida. |
| **D-8** (P2-11) | Contabilidad (M16 del monolito): ¿el formato de la exportación del periodo es el que sale hoy (JSON con una línea por cobro, abono, comisión y contracargo; CSV de siete columnas)? | A) JSON canónico y CSV de ayuda. B) Otro formato o columnas. | **A**, pendiente de que M16 confirme. Una factura por periodo y comercio ya es D-21. |
| **D-9** (P3-7, T-03) | ¿Quién carga el banco, el titular y el número de la cuenta recaudadora que ve el pagador en una transferencia y dónde? | A) La configuración del conector `bank_transfer` (propuesto; sirve con dos bancos en el ruteo). B) La configuración de `pay-payments` (hoy `BANK_TRANSFER_*`). | **A.** Los valores no existen hasta que exista la cuenta (T-03); no se inventan. |
| **D-10** (P1-6, P5-2) | Un secreto que se muestra una sola vez ¿se vuelve a mostrar al repetir la petición con la misma `Idempotency-Key`? Hoy las claves de API **no** (`200` sin secreto) y los webhooks **sí** (mismo cuerpo, sellado). | A) No volver a mostrarlo en ninguno (si se perdió, se rota). B) Repetirlo en ambos. C) Dejarlo como está. | **A.** Seguridad con P1 y P5; `pay-webhooks` cambiaría su almacén de idempotencia. Sin urgencia: las dos formas están documentadas. |

Siguen abiertas, sin relación con las propuestas: Q-15 (beneficiarios de los mandatos), Q-20 (quién emite el `wallet_authorization`), Q-12 (umbrales de cribado), T-03 (cuenta recaudadora y visto bueno legal).

## 7 · Lo que no es un contrato (para el coordinador)

Son 16 propuestas que no cambian ningún archivo de `contracts/openapi`, `contracts/asyncapi` ni `contracts/schemas` (y la consigna era no tocar `services/`, la plataforma ni el `package.json` raíz).

| Propuesta | Qué hay que hacer | Dónde | Quién |
|---|---|---|---|
| P1-1 | `"resolutions": { "@mikro-orm/core": "7.1.7", "@mikro-orm/postgresql": "7.1.7", "@mikro-orm/knex": "7.1.7" }` y `yarn install` + `typecheck` de todos los workspaces | `package.json` raíz | Coordinador |
| P1-8 | `"contracts:breaking": "node contracts/scripts/check-breaking.mjs"` y el paso de CI con `oasdiff` (hoy ningún contrato dice `v1-frozen` salvo la intención de `common.yaml`, así que congelar es poner la etiqueta en las primeras líneas) | `package.json` raíz, CI | Coordinador / P1 |
| P1-7 | Una cuenta NATS por servicio con permisos de publicación solo sobre sus temas; prueba: con las credenciales de `pay-payments`, publicar en `pay-merchants.api_key.created` ⇒ denegado | `platform/` | P1, antes de la ola 3 |
| P1-10, P4-5 | DDL de `pay_edge`, `pay_webhooks`, `pay_connectors` y `pay_qr` al pipeline `.puml → SQL/ → base → ORM` (D-18) | repo `mantra-core-health-model` | P1, P4 |
| P3-13, P4-4.6 | `eslint.config.mjs`: globals de Node para `**/*.cjs` o ignorar `**/jest.config.cjs` (hoy `yarn lint` falla en los de todos los servicios) | `eslint.config.mjs` | P1 |
| P3-14, P4-4.5, P4-4.9, P5-15 | `createIsolatedDatabase` con `max` configurable y 10 por defecto en vez de 60 (el Compose ya sube `max_connections` a 400; falta lo otro) | `@pay/testing` | P1 |
| P4-4.1, P4-4.8 | Documentar en `@pay/idempotency` que un `5xx` no se guarda y que **todo `4xx` sí**: un error transitorio con estado 4xx deja la clave inutilizable; los transitorios son `5xx`. Opcional: marcar un `ProblemError` como no cacheable | `@pay/idempotency` | P1 |
| P4-4.2 | Helper de «matriz de identidad» (ruta × servicio) en `@pay/service-auth`; `pay-connectors` y `pay-qr` la escribieron a mano | `@pay/service-auth` | P1 |
| P4-4.3, P4-4.4 | `log-safe.ts` (enmascara segmentos de ruta que no parecen nombre o id) y `@PublicRoute()` en el controlador de `health.spec.ts` de la plantilla | `platform/templates/service` | P1 |
| P4-4.7 | `OutboxRelay.stop()` espera el ciclo en curso y `EventsModule` lo espera antes de `drain()` | `@pay/outbox` | P1 |
| P5-4 | `loadEventContract` (valida un evento contra el AsyncAPI por `subject`) a `@pay/testing`; hoy hay una copia en `pay-merchants` y otra en `pay-schedules` | `@pay/testing` | P1 |
| P5-5 | `quoteFee(schedule, channel, gross)` en `@pay/money` | `@pay/money` | P1 |
| P5-8 | `OperatorGuard` / `OperatorAuthenticator` a `@pay/service-auth` (hoy copiados en `pay-merchants` y `pay-risk`; `pay-settlement` tiene su propio `operator-token.ts`) | `@pay/service-auth` | P1 + identidad |

**Documentos fuera de mi alcance que quedan desactualizados:** `docs/plan/PLAN-MAESTRO.md` §3.3 (agregar la fila `merchant:{id}:debt`, deudora, `credits_must_not_exceed_debits`, y el contracargo
partido) y el §4 (las tablas de contratos ahora incluyen `internal/qr/v1` y `internal/merchants/v1`). `contracts/README.md` no cambia.

## 8 · Evidencia y lo que no se cubrió

**Comandos y salidas literales** (en [`evidencia/`](./evidencia/)):

| Archivo | Qué es |
|---|---|
| `contracts-lint-antes.txt`, `contracts-lint-despues.txt` | `yarn contracts:lint`: 11 → 13 contratos válidos (se suman `internal-qr-v1` e `internal-merchants-v1`) |
| `contracts-events-antes.txt`, `contracts-events-despues.txt` | `yarn contracts:events`: 38 → 40 mensajes, 38 → 40 ejemplos válidos, 333 → 350 mutantes rechazados de 350, 0 PII, `bad: 0` |
| `test-<servicio>.txt` | `yarn workspace <servicio> test`, una suite a la vez, contra el Postgres, Temporal y NATS del Compose (`test-pay-edge.txt` y `test-pay-settlement.txt` no terminan en `exit=`: su resumen es la línea `Tests:`) |
| `typecheck.txt` | `yarn workspace @pay/problem build` y `typecheck` de los 11 servicios: todos con código 0 |

| Servicio | Resultado | Lo rojo, ¿por qué? |
|---|---|---|
| `pay-edge` | 321 pasan · **3 rojas** | `routes.spec.ts`: la tabla de rutas debe seguir al contrato (§5) |
| `pay-ledger` | 155 pasan · **1 roja** | `KNOWN_422_GAPS`: la prueba pide borrar las entradas cuando el contrato declara el 422 (§5). Con TigerBeetle local de `platform/scripts/tigerbeetle-dev.sh` |
| `pay-settlement` | 394 pasan · **1 roja** · 9 `ENVIRONMENT` | La roja es el conteo de rutas «fuera del contrato». Las 9 de `ledger-real.spec.ts` esperan TigerBeetle: sin él fallan por tiempo; con él pasan (`test-pay-settlement-ledger-real.txt`, 9 de 9) |
| `pay-connectors` | 516 pasan · **3 rojas** | `contract.spec.ts`: `GET /refunds/{id}` exige ruta, matriz de identidad y conteo (§5) |
| `pay-payments` | 207 pasan | — |
| `pay-schedules` | 129 pasan | — |
| `pay-merchants` | 90 pasan | — |
| `pay-risk` | 149 pasan | — |
| `pay-webhooks` | 344 pasan | — |
| `pay-qr` | 44 pasan | — |
| `pay-vault` | 58 pasan | — |
| `@pay/problem`, `@pay/testing` | 29 y 6 pasan (el conteo de 19 a 20 operaciones se cambió a mano en `@pay/testing`) | — |

Las **8 pruebas rojas** son todas del mismo tipo: pruebas que exigen que el servicio y el contrato digan lo mismo (rutas, conteos, `KNOWN_422_GAPS`). No hay una sola
prueba de comportamiento en rojo. No se debilitó ninguna aserción ni se borró ninguna prueba: el único cambio de prueba que hice es el conteo `19 → 20` de `@pay/testing`, que sigue al contrato.
Para clasificar los fallos (regla 80.4) se leyó cada mensaje; no hubo una corrida base en paralelo.

**Procesos:** TigerBeetle se levantó con el script del repo solo para `pay-ledger` y los 9 tests de `ledger-real`, y se detuvo (`tigerbeetle-dev.sh stop`). Al cerrar no queda
ningún `jest` ni `tigerbeetle` corriendo; los contenedores del Compose (`postgres`, `temporal`, `redis`, `nats`, `jaeger`, `watchman`) ya estaban arriba antes de empezar y no se tocaron.

**No cubierto:**

- **Ningún flujo de punta a punta** (E1–E8) ni integración real entre servicios: las suites de cada servicio usan sus dobles; eso es el trabajo de la ola 2. Por eso el peldaño es `RUNS`/`TESTED` y no `VERIFIED`.
- **`contracts:breaking` / `oasdiff`:** no está instalado; la compatibilidad se argumentó por el diff y las suites.
- **Los contratos nuevos de P4 y P5** (`internal-qr`, `internal-merchants`) son copias de las propuestas que esos servicios ya prueban; sus pruebas todavía apuntan a la copia de `docs/trabajo/ola-1/` (§5), así que hoy nada prueba la copia de `contracts/` salvo `yarn contracts:lint`.
- **Los consumidores de los eventos:** las operaciones `receive` del AsyncAPI siguen siendo la intención del PLAN §4, no lo que cada servicio escucha de verdad (por ejemplo, `pay-settlement` consume dos eventos, no todos los declarados). Las agregué cuando un servicio lo hace (P2-9) o lo hará (contradicción, transferencia), marcadas como «a implementar»; no audité el resto.
- **`ProblemCode` nuevo y `dist/`:** Jest resuelve `@pay/*` a `src/` (`jest.base.cjs`), así que las suites ya vieron el catálogo nuevo. Para `tsc` reconstruí `@pay/problem` (`dist/` está ignorado por git) y los 11 `typecheck` salen con código 0 (`evidencia/typecheck.txt`); quien compile en otra máquina debe correr `yarn workspace @pay/problem build` primero.
- **Cambios de descripción sin prueba de comportamiento:** las notas sobre ids, modo, errores y resultado ambiguo describen lo que leí en el código (citado en §3); no hay una prueba que las fije.

> Nota de higiene: `services/pay-payments/test/failures.matrix.spec.ts` reescribe `docs/trabajo/ola-1/P3/evidencia/fallos-p3.md` cada vez que corre (un tiempo medido
> cambió de 876 a 910 ms). Revertí ese archivo para no tocar la evidencia de la ola 1; quien corra esa suite lo va a ver modificado.
