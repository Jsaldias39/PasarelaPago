# Propuestas de P3 para el coordinador (ola 2, tandas 2b y 2c)

> P3 no edita `contracts/` ni `contracts/packages/`: las aplica el coordinador. Cada una trae el parche exacto y qué cambia en `pay-payments` cuando se aplique.

## PROP-15 · `payment_method_unavailable` como código estable del catálogo
- **Hoy:** el `POST /payment_intents` de una transferencia bancaria sin cuenta recaudadora (T-03) responde `422 validation_failed`; el motivo va en `detail` (`payment_method_unavailable: …`) y en el código de CAMPO `errors[].code = payment_method_unavailable` (ya documentado en `schemas/problem.schema.json`). La fila guarda `failure_code = validation_failed` y `failure_reason = payment_method_unavailable`; el evento `payment_intent.failed` y `last_error.code` dicen `validation_failed`. Respuesta y evento usan el MISMO código del catálogo.
- **Por qué proponerlo:** es un error de cliente estable y distinguible (el comercio puede mostrar «transferencia no disponible» sin parsear `detail`), y `internal-connectors-v1.yaml` ya promete «`pay-payments` responde `422 payment_method_unavailable`».
- **Parche:**
  1. `contracts/packages/problem/src/catalog.ts`: `payment_method_unavailable: { status: 422, title: 'El medio de pago no está disponible' },` (y su documentación en `schemas/problem.schema.json`, lista de códigos).
  2. `contracts/asyncapi/payments.yaml` → `PaymentIntentFailedData.failure_code.enum`: agregar `payment_method_unavailable`.
  3. `contracts/openapi/public-v1.yaml` → `PaymentIntent.last_error` (texto de códigos) y la respuesta `422` de `POST /payment_intents`: agregar el código.
  4. `contracts/openapi/internal-payments-v1.yaml` → descripción de `failure_code`: agregar el código.
- **Qué cambia en P3 al aplicarla:** `settleIntent` guarda `failure_code = payment_method_unavailable`, `normalizeFailureCode` ya no necesita nada, el 422 usa `code: payment_method_unavailable` y desaparece `failure_reason` para este caso (la columna queda para otros motivos finos). Una prueba (`ola2.tanda2b.spec.ts` §1) pasa de `validation_failed` a `payment_method_unavailable` en los tres lugares.

## PROP-16 · `X-Pay-Mode` opcional en `internal-risk-v1.yaml`
- **Hoy:** `pay-payments` manda `X-Service-Id` a pay-risk pero NO `X-Pay-Mode`, porque el contrato de riesgo no declara el parámetro `PayMode` (sí lo declaran ledger, conectores y payments). Una prueba lo fija («el contrato de riesgo no declara PayMode: no se inventa»).
- **Parche:** si riesgo va a calcular límites o reglas distintos por modo, agregar `- $ref: 'common.yaml#/components/parameters/PayMode'` a `POST /assessments`. P3 lo enviaría desde `RiskClient.assess` (la activity ya conoce `intent.mode`).

## PROP-17 · La razón social del comercio llega a `pay-payments` (D-29) — APLICADA en la tanda 2d (D-33)
- **Hoy (verificado en `contracts/`):** NO hay fuente contractual del nombre legal del comercio para `pay-payments`. `internal-merchants-v1.yaml` lo recibe en `MerchantCreate.legal_name`, pero (a) `MerchantAdmin` (la respuesta de `GET /merchants/{id}`, rol `merchant_operator`) solo trae `display_name` y `legal_type`, y (b) los eventos `merchant.created|activated|suspended|closed` (`asyncapi/merchants-schedules.yaml`, `additionalProperties: false`) no lo llevan. P3 NO lo inventa (ni usa `display_name`, ni el id) y no puede leer la base de `pay-merchants` (separación #5).
- **Efecto de hoy:** el cobro sale a pay-risk SIN `screening`; el contrato obliga a pay-risk a responder `201 review / screening_not_provided`, y `review` ⇒ `risk_denied` (D-30). Es decir: **con el contrato vigente, ningún cobro puede pasar el riesgo**. Es fail-closed, no un error silencioso, pero es un bloqueo funcional.
- **Parche mínimo (una de dos, recomendada la primera):**
  1. `asyncapi/merchants-schedules.yaml` → `MerchantCreatedData` y `MerchantActivatedData`: agregar `legal_name: { type: string, minLength: 1, maxLength: 300 }` (opcional en `activated`, obligatoria en `created`). Es dato del comercio, no del pagador; la razón social es información pública del registro, pero igual no se registra en logs.
  2. Alternativa: `internal-merchants-v1.yaml` → agregar `legal_name` a `MerchantAdmin` y permitir `GET /merchants/{id}` a `pay-payments` (hoy exige rol `merchant_operator`).
- **Qué cambia en P3 al aplicarla:** NADA de código. Ya está hecho: `merchant_replica.legal_name` (columna), `EventHandlers.merchantChanged` lo guarda si el evento lo trae (un `suspended`/`closed` sin el campo no lo borra) y `assessRisk` lo manda como `screening {name, entity_type: business}`. Con la opción 2 habría que sumar una consulta al crear el cobro.

## PROP-18 · Nombre opcional del pagador en `PaymentIntentCreate` (D-29) — APLICADA en la tanda 2d (D-33; P3 ya lo acepta)
- **Hoy:** `PaymentIntentCreate` (`public-v1.yaml`, `additionalProperties: false`) no tiene ningún dato del pagador, y el token de tarjeta de `pay-vault` tampoco lo expone (`holder_name` solo existe en `CardData`, la entrada de la bóveda, y nunca sale de ella). P3 no acepta un campo fuera del contrato (lista blanca, regla 96.2): la API pública no puede traer hoy un nombre de pagador.
- **Lo que SÍ está hecho:** la columna `payment_intents.payer_name` (dato personal: no sale en respuestas ni eventos y se BORRA al llegar el intento a un estado terminal), el cribado del pagador en `assessRisk` (segunda evaluación, `entity_type: person`, clave `${intentId}:risk:payer`) y la regla «invitado sin nombre ⇒ no se manda nada y no se bloquea el cobro». Probado con intentos creados directamente contra el repositorio.
- **Parche:** `public-v1.yaml` → `PaymentIntentCreate.properties.payer: { type: object, additionalProperties: false, properties: { name: { type: string, minLength: 1, maxLength: 200, x-sensitive: true } } }` (opcional, y `pay-edge` debe reenviarlo). P3 cambia solo `parseCreateIntent` (acepta `payer.name`, `noPan` incluido) y `createIntent` (lo pasa a `intentsRepo.insert`).

## PROP-19 · Una sola evaluación de riesgo con varios nombres a cribar — RESUELTA por PROP-20 (tanda 2e): UNA evaluación
- **Hoy:** `AssessmentCreate.screening` admite UN nombre; para cribar comercio y pagador P3 hace DOS evaluaciones (`${intentId}:risk` y `${intentId}:risk:payer`) del MISMO `payment_intent_id`. Riesgo: si `pay-risk` cuenta velocidad o límites por evaluación y no por intento, el pagador con nombre contaría doble. El contrato no dice cómo se cuenta.
- **Parche (P5):** o bien aclarar en `internal-risk-v1.yaml` que una `Idempotency-Key` distinta sobre el mismo `payment_intent_id` NO suma a velocidad ni a límites, o bien reemplazar `screening` por `screenings: [{ name, entity_type, role: merchant|payer }]` y devolver la peor decisión. P3 adaptaría `RiskClient.assess` en una línea.

## PROP-20 · El contrato de riesgo debe decir cómo viajan los DOS nombres — APLICADA por el coordinador (2e): `merchant_name` + `name` en UNA evaluación
- **Hoy (verificado leyendo `services/pay-risk`, sin ejecutarlo):** `internal-risk-v1.yaml` solo conoce `screening: {name, entity_type}` (un nombre por evaluación, `additionalProperties: false`). `pay-risk` implementa OTRA cosa (su PR-17): `screening.merchant_name` + `merchant_entity_type` para el comercio y `name` para el PAGADOR (`assessments.service.ts:95-96`; `merchant_name` ausente ⇒ `screening_not_provided`, línea 69 de `rules/engine.ts`; `assessments.controller.ts` lo valida con esos campos).
- **Consecuencia:** `pay-payments` sigue el contrato escrito (evaluación 1: `screening {name: razón social, entity_type: business}`). El `pay-risk` real lo lee como el nombre del PAGADOR, no encuentra `merchant_name` y responde `review / screening_not_provided` ⇒ `risk_denied`. **Aunque llegue `legal_name`, el cobro de E1/E2 sigue denegado contra el pay-risk real.** Contra el doble (que valida el contrato) pasa, y por eso mis pruebas no lo ven.
- **Parche recomendado (contrato + P3, una sola evaluación):** `internal-risk-v1.yaml` → `AssessmentCreate.screening`: agregar `merchant_name` (1..200) y `merchant_entity_type` (`person|business`, por defecto `business`), y volver `name` OPCIONAL (el pagador, solo si se conoce). Eso elimina la segunda evaluación y la discusión de PROP-19 (una evaluación, una clave `${intentId}:risk`).
  - **Qué hago en P3 al aplicarlo (≈15 líneas):** `RiskClient.assess` manda `screening {merchant_name, merchant_entity_type: 'business', name?: payer, entity_type: 'person'}`; `assessRisk` hace UNA llamada; el doble y las pruebas de 2c/2d pasan a esperar una sola evaluación con ambos nombres (los casos «pagador en la lista ⇒ risk_denied» y «invitado sin nombre ⇒ no bloquea» se conservan).
- **Alternativa:** que P5 acepte también el contrato escrito (`name` + `entity_type: business` sin `merchant_name` = comercio). Peor: ambigua con el pagador.
- Mientras no se decida, P3 NO cambia el formato (el doble valida el contrato y un campo extra sería una violación).

## Resueltas por el coordinador en la tanda 2a (ya no son propuestas)
PROP-2 (`tx_`/`hd_`), 3 (`mock`), 4 (`risk_denied`/`payment_declined`), 5 (`contradiction_detected`), 7 (cuenta en `bank_transfer_instructions`), 8 (`ch_`/`cr_`), 9 (D-28), 10 (`GET /refunds/{id}`), 11 (`GET /refunds/{id}` del conector). PROP-6 (disputas) sigue siendo decisión del dueño; PROP-13 y 14 son de plataforma.


## Propuestas de la tanda 3c (P3 no toca `contracts/`, `platform/`, `e2e/` ni otros carriles)

## P3-21 · No registrar el mensaje de un error de actividad de Temporal (logger del SDK)
- **Hoy:** el logger de Temporal (`DefaultLogger`) escribe `Activity failed { error: Error: <mensaje + pila> … }` con el error completo de una actividad que falla (se ve en las salidas de las suites). Los errores de nuestras actividades no traen datos de personas, pero un error de `pg` puede traer un valor de columna en el mensaje o en `detail`.
- **Propuesta (mía, sin implementar por ahora):** pasar a `Runtime.install` un logger propio que, para `Activity failed` y `Workflow failed`, escriba solo `activityType`, `attempt` y el NOMBRE del error. Probar con un canario en el mensaje de una actividad.

## P3-22 · Librería compartida para el guardia del pool (P1)
- **Hoy:** `guardPool` existe copiado en pay-merchants, pay-connectors, pay-payments y pay-vault (y otros dos casos más con variantes). Es el defecto transversal que más veces se repitió.
- **Propuesta:** moverlo a un paquete `@pay/pg-pool` en `contracts/packages/` con la prueba de corte a mitad de transacción incluida, y que la plantilla de servicio (`platform/templates/service`) lo traiga. Mientras tanto cada servicio conserva su copia y su prueba.

## P3-23 · Plantilla de Dockerfile: base glibc cuando hay módulos nativos (P1)
- **Hoy:** la plantilla usa `node:22-alpine`. `@temporalio/core-bridge` solo se distribuye para glibc: la imagen de pay-payments construía y no arrancaba (`ld-linux-x86-64.so.2`). Lo mismo aplica a cualquier servicio que use el cliente nativo de TigerBeetle u otro `.node` (pay-ledger ya mostró un problema de `io_uring` distinto).
- **Propuesta:** documentar en la plantilla cuándo cambiar a `node:22-bookworm-slim`, y que `verify-template.sh` arranque la imagen (no solo la construya).

## P3-24 · Prueba de idempotencia concurrente en pay-vault (mía)
- Falta `Promise.all` de 10 `POST /capture_sessions` con la misma clave (una sola fila) y de `DELETE /tokens/{t}`. No se escribió en 3c porque el coordinador reservó la máquina; está en PENDIENTE del reporte.
