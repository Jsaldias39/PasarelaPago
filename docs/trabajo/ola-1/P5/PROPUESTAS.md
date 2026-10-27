# Propuestas de contrato del carril P5 (ola 1)

Cambios que P5 necesita en `contracts/` o en librerías de otros carriles. **No se aplicaron**: cada una espera la
aprobación de su dueño. Quien integra las mueve; hasta entonces las pruebas de P5 usan las propuestas de esta carpeta.

| ID | Propuesta | Dueño que aprueba | Estado |
|---|---|---|---|
| PR-01 | Mover `propuestas/internal-merchants-v1.yaml` a `contracts/openapi/` (cambiar los `$ref` a `common.yaml#/…`). Back-office de `pay-merchants`: 13 operaciones, validadas con Redocly. | integrador | abierta |
| PR-02 | `POST /api_keys` y `POST /api_keys/{id}/rotate`: la repetición con la misma `Idempotency-Key` devuelve **200 sin el secreto** (hoy el contrato solo declara 201). | P1 (`public-v1`) | abierta |
| PR-03 | **`X-Pay-Mode: test\|live`** como cabecera de las rutas públicas internas (`/merchants/me`, `/api_keys*`, `/mandates*`), fijada por `pay-edge` desde el registro de la clave (D-28). Sin ella o inválida ⇒ 403 `forbidden`. Una clave de un modo no crea claves del otro (403) y no lista, rota ni revoca las del otro (404). Los datos de `test` y `live` no se mezclan. | P1 (`pay-edge`) + integrador | abierta |
| PR-04 | `loadEventContract` (validar un evento emitido contra el AsyncAPI por `subject`) → `@pay/testing`. Hoy vive en `services/pay-merchants/test/support/event-contract.ts`. | P1 | abierta |
| PR-05 | `quoteFee(schedule, channel, gross)` en `@pay/money` (hoy `pay-merchants/src/fees/quote.ts` delega en `splitFee` sin aritmética propia) para que P2 y P3 no lo reescriban. | P1 (`@pay/money`) | abierta |
| PR-06 | Código de error `already_exists` en el catálogo de `@pay/problem` (hoy un NIT repetido sale como `validation_failed` con `errors[].code = already_registered`). | P1 | abierta |
| PR-07 | `api_key.revoked`: agregar la razón `merchant_closed` (hoy cerrar un comercio NO revoca sus claves; los consumidores aplican `merchant.closed`). | P1 (AsyncAPI) | abierta |
| PR-08 | `OperatorGuard` / `OperatorAuthenticator` (credencial JWT de la persona operadora, roles por operación) a `@pay/service-auth`: hoy está copiado en `pay-merchants` y `pay-risk`. Roles propuestos: `merchant_operator`, `kyc_reviewer`, `legal_admin`, `pricing_admin`, `security_operator`, `risk_admin`. | P1 + servicio de identidad (Q-21, Q-23) | abierta |
| PR-09 | **`pay-ledger`: devolver los ids `tf_…` en la respuesta de `POST /transactions`** (campo `transfer_ids`, aditivo). `scheduled_payment.executed` exige `ledger_transfer_id` (`tf_…`) y hoy la respuesta síncrona solo trae `tx_…`. Sin esto, un pago programado queda `executed` con `needs_review = true` y SIN evento (el dinero sí se movió). | P2 (`pay-ledger`) | abierta |
| PR-10 | **`public-v1.yaml`: `Mandate` es inalcanzable.** `allOf: [MandateCreate, {id, object, status, …}]` y `MandateCreate` trae `additionalProperties: false`, así que ninguna respuesta con `id` lo cumple. Usar `unevaluatedProperties: false` o un esquema base sin `additionalProperties`. `pay-schedules` verifica el resto del contrato y tolera solo esos cinco campos (`verifiedMandate`). | P1 | abierta |
| PR-11 | **`internal-risk-v1.yaml`**: (a) `screening.entity_type` (`person\|business`) opcional: con él se hace UNA búsqueda en Watchman en vez de dos (Watchman es el cuello de botella); (b) la operación de carga de límites (`propuestas/internal-risk-rule-sets-v1.yaml`); (c) el `503` del contrato dice «cribado caído ⇒ 503» pero el carril P5 dice «Watchman caído ⇒ `review`, nunca `allow`»: se implementó `review` con `screened:false` y rastro (ver D5-23); aclarar el 503. | P3 (consume) + P5 | abierta |
| PR-12 | **Eventos `mandate.*` y `scheduled_payment.*` sin `mode`** (D-28). `pay-schedules` guarda `mode` por mandato y llama al libro mayor con `X-Pay-Mode`; los consumidores (webhooks) no pueden distinguir un evento `test` de uno `live`. Agregar `mode` a esos eventos y a `merchant.*`. | P1 (AsyncAPI) | abierta |
| PR-13 | `POST /mandates`: faltan `PATCH`/reanudar y el **tope por mandato** del plan («beneficiario, monto, calendario y tope»): el contrato no tiene campo de tope; se implementó un tope global opcional (`MANDATE_MAX_AMOUNT_MINOR`, sin valor por defecto). | P1 + dueño | abierta |
| PR-14 | `internal-ledger-v1.yaml`: el `Leg.code` `release` se usó para el asiento inverso de un pago cuyo beneficiario se bloqueó; `adjustment` sería más exacto. Confirmar con P2. Además `Hold` no declara cómo se informa un `void` repetido con la misma clave. | P2 | abierta |
| PR-15 | `@pay/testing.createIsolatedDatabase` abre pools de hasta 60 conexiones por contexto y Postgres local tiene `max_connections = 100`: varios carriles corriendo suites a la vez producen fallos intermitentes por carga/conexiones. | P1 | abierta |

## Bug encontrado en código ajeno (no corregido)

- `services/pay-edge/src/proxy/edge.pipeline.ts:85` reenvía `x-pay-mode: sandbox` para las claves `test` (`principal.mode === 'test' ? 'sandbox' : 'live'`). D-28 fija el valor `test|live`: con `sandbox`, `pay-merchants` responde 403 en **todas** sus rutas públicas. Dueño: P1.
- `contracts/openapi/public-v1.yaml` `Mandate` (PR-10) y `pay-ledger` sin `tf_…` (PR-09): ver arriba.
- `pay-settlement` y `pay-webhooks` tienen errores de `yarn lint` (no son de P5): `pay-settlement/src/settlement/export.service.ts`, `statement-parsers.ts`, `test/statement-parsers.spec.ts`, `pay-webhooks/src/ssrf/https-transport.ts`, `test/payload-policy.spec.ts`, `test/ssrf.spec.ts` (variables sin usar, espacios irregulares, `any`).
