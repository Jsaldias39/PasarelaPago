# Propuestas de P4 a contratos y librerías compartidas (ola 1)

P4 no edita `contracts/` ni `contracts/packages/`: lo que hace falta cambiar queda acá como parche para quien integra.
Nada de esto está aplicado.

## 1. Contrato nuevo: `internal-qr-v1.yaml` (pay-qr)

Propuesto en `propuesta/internal-qr-v1.yaml` (validado con Redocly, y `services/pay-qr/test/qr.spec.ts` lo usa como contrato).
Mover a `contracts/openapi/internal-qr-v1.yaml` y registrarlo en el lint de contratos. Lo llama solo `pay-connectors`.

## 2. `internal-connectors-v1.yaml`

| # | Cambio propuesto | Por qué |
|---|---|---|
| 2.1 | Agregar `refund_id` (`re_…`) a `POST /charges/{id}/refunds` | El evento `connector.transaction.status_changed` tiene `refund_id` y hoy va `null`: pay-connectors no conoce el id de pay-payments. |
| 2.2 | `ChargeCreate.card_token`: aclarar si es obligatorio para `card` | El contrato dice «para card, se usa card_token», pero D-17 prefiere la página alojada del banco (sin token). Se aceptó opcional (DECISIONES D-P4-06). |
| 2.3 | Agregar `bad_request` (400) al catálogo de `@pay/problem` | El contrato referencia `BadRequest` (400) y hoy solo existe `idempotency_key_required` con 400. Se usa un problema construido a mano con `code: bad_request` (`src/raw-problem.ts`) para el callback firmado con cuerpo ilegible y para `GET /transfers/{reference}` mal formada. |
| 2.4 | `GET /statements`: documentar que `description` sale siempre `null` | Mientras no se revise el formato del banco, la glosa no sale del servicio (puede traer nombres o cuentas). |
| 2.5 | `POST /transfers` y `POST /charges/{id}/refunds`: documentar el `500 internal_error` como **resultado ambiguo** | Con la regla 11 el conector responde `502 connector_unavailable` solo si garantiza que no envió nada; un timeout o un `Unavailable` posterior a un intento ambiguo sale como `500 internal_error` con la fila conservada, y se resuelve con `GET /transfers/{reference}`. Hoy el contrato de reembolsos solo lista 502. |
| 2.6 | `Transfer.status`: `failed` siempre trae `failure_code` | Lo exige la base (`connector_transfers_failed_reason_ck`) y el contrato lo da por implícito. Códigos hoy: `rejected_by_bank`, `connector_unavailable`, `rejected_by_provider`, `validation_failed`. |
| 2.7 | Cobro cobrado/fallido/vencido/anulado: `next_action` ausente | Ya es así en la implementación; documentar. |

## 3. Eventos (`contracts/asyncapi/connectors.yaml`)

| # | Cambio propuesto |
|---|---|
| 3.1 | **Unificar `mock` ↔ `simulator`**: la API usa `mock` y los eventos `simulator`. Hoy se traduce en `src/domain/status-map.ts` (`eventConnectorCode`). Elegir uno. |
| 3.2 | `failure_code` de los eventos solo admite `connector_unavailable \| validation_failed \| internal_error`. Un rechazo del proveedor (`card_declined`) sale como `validation_failed`. Agregar `card_declined` (y `rejected_by_bank`) al catálogo de eventos. |
| 3.3 | **Evento de estado de la transferencia saliente** (no hay canal): `connector.transfer.status_changed`, `subject: tr_…`, `data: { transfer_id, reference, connector, status (pending\|in_transit\|paid\|failed), amount_minor, currency, failure_code, provider_occurred_at, observed_via }`, sin `merchantid` obligatorio. Consumidor: `pay-settlement` (inbox `pay-settlement.connector.transfer.status_changed`). Hoy `pay-settlement` consulta `GET /transfers/{reference}`. |
| 3.4 | El evento `connector.health.degraded` se publica al pasar a **`down`** (sale del ruteo), no en el primer fallo; el estado intermedio `degraded` de `GET /connectors/health` no publica nada. Aclarar la descripción («empezó a fallar y sale del ruteo») o agregar `connector.health.changed`. |
| 3.5 | Evento por reembolso: hoy `kind: refund` con `observed_via: status_inquiry` (el reembolso es síncrono). Si se vuelve asíncrono, agregar `callback`. |

## 4. Librerías compartidas

| # | Cambio propuesto |
|---|---|
| 4.1 | `@pay/idempotency`: un `HandlerResult` con status ≥ 500 no se guarda y libera el bloqueo (correcto). Documentarlo en el README de la librería: P4 depende de eso para que un `502/500` ambiguo se pueda reintentar con la misma clave. |
| 4.2 | `@pay/service-auth`: exportar un helper de pruebas «matriz de identidad» (ruta × servicio) — P4 lo escribió a mano en `test/contract.spec.ts`. |
| 4.3 | Plantilla de servicio (`platform/scripts/new-service.sh`): el serializador de `pino-http` registraba `req.url` tal cual (una ruta como `/callbacks/4111…` dejaba un número de tarjeta en el log) y `ProblemFilter` repetía la URL cruda en `instance`. P4 lo corrigió en `pay-connectors` y `pay-qr` con `src/log-safe.ts` (enmascara los segmentos que no parecen nombre o id). **Los demás servicios generados de la plantilla tienen el mismo defecto.** Copiar `log-safe.ts` a la plantilla. |
| 4.4 | Plantilla: la prueba `health.spec.ts` generada necesita `@PublicRoute()` en su controlador de prueba en cuanto el servicio instala `ServiceIdentityGuard` (le pasó a `pay-qr` y a `pay-connectors`). |
| 4.5 | `@pay/testing`: `createIsolatedDatabase` crea el pool con `max: 60`; con varios archivos de prueba en paralelo contra el mismo Postgres puede agotar conexiones. No fue un problema acá (13 archivos), anotado. |

## 5. Modelo (`mantra-core-health-model`, D-18)

Declarar el esquema de `sql/001_connectors.sql` (tablas `connector_charges`, `connector_refunds`, `connector_transfers`,
`connector_callback_events`, `connector_api_attempts`, `connector_health`, `connector_callback_endpoints`, `routing_rule_sets`,
`bank_transfer_references`, `statement_exceptions`) y `pay-qr/sql/001_qr_codes.sql`. El verificador de deriva (P4.H1.M2) queda para entonces.
| 4.6 | `eslint.config`: ignorar `**/jest.config.cjs` (o darle `languageOptions.globals` de Node/CommonJS). Hoy `yarn lint` de la raíz falla en el `jest.config.cjs` de **todos** los servicios (`require`/`module`/`__dirname` no definidos). |
| 4.7 | `@pay/outbox` `OutboxRelay.stop()` no espera el ciclo de publicación en curso: al apagar un servicio con un evento a mitad de publicar, `EventsModule` registra `El relé del outbox falló` (`CONNECTION_DRAINING`). Es benigno (el evento queda sin `published_at` y sale en el próximo arranque: entrega al menos una vez) pero ensucia el cierre. Que `stop()` devuelva una promesa que espere el ciclo y que `EventsModule` la espere antes de `drain()`. |
| 4.8 | `@pay/idempotency`: toda respuesta 4xx se **guarda y se repite** para esa clave. Un error transitorio con status 4xx (un 409 «sin capacidad», un 429) dejaría la clave inutilizable para siempre. Documentarlo en el README de la librería, o permitir que un `ProblemError` se marque como no cacheable. P4 usa 500 para lo transitorio. |
| 4.9 | `@pay/testing` `createIsolatedDatabase`: pool de 60 conexiones por archivo de prueba y `max_connections=100` en el Postgres compartido. Con varios archivos de prueba en paralelo (y las suites de otros carriles) se puede agotar el servidor («too many clients», 53300): ese es el único camino por el que una entrega de callback dejó de ser `applied`/`duplicate` en las pruebas (ver `test/infra-faults.spec.ts`). Bajar el tope a ~10 o subir `max_connections` en `platform/compose.yml`. |
