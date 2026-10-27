# Propuestas de P3 para el coordinador (ola 2, tanda 2b)

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

## Resueltas por el coordinador en la tanda 2a (ya no son propuestas)
PROP-2 (`tx_`/`hd_`), 3 (`mock`), 4 (`risk_denied`/`payment_declined`), 5 (`contradiction_detected`), 7 (cuenta en `bank_transfer_instructions`), 8 (`ch_`/`cr_`), 9 (D-28), 10 (`GET /refunds/{id}`), 11 (`GET /refunds/{id}` del conector). PROP-6 (disputas) sigue siendo decisión del dueño; PROP-13 y 14 son de plataforma.
