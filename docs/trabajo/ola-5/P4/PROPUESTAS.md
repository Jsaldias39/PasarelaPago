# P4 — Propuestas al contrato `internal-connectors-v1.yaml` (reembolsos)

Origen: hallazgos F4 y F6 de `docs/trabajo/ola-5/integracion/revision/REVISION-DINERO.md`. Estas propuestas **no cambian el contrato**: el código eligió lo más
conservador que el contrato ya permite. Hay que confirmarlas con el dueño del contrato (P4) y con el consumidor (`pay-payments`).

## PR-1 — Reintento de una clave cuyo `refund_id` tomó otra clave: `409 invalid_state_transition` (F4)

- **Situación.** Clave K1 con `refund_id=re_X` quedó `failed` por un `502 connector_unavailable` (sin efecto). Otra clave K2 con el mismo `re_X` se creó y avanzó
  (el índice `connector_refunds_refund_id_uidx` excluye lo `failed`). Al reintentar K1, reabrir su fila la devolvería al índice y choca (`23505`).
- **El contrato no lo define.** `POST /charges/{id}/refunds` declara `409` genérico (`common.yaml#/components/responses/Conflict`) y `422`; el `INSERT` ya responde
  `409 invalid_state_transition` («Ya hay un reembolso con ese refund_id») para el mismo `refund_id` en otra clave. No dice nada del choque al reabrir.
- **Lo implementado (conservador).** El mismo `409 invalid_state_transition` y el mismo `detail`, capturando el `23505` de ese índice en la reapertura. La fila de K1 sigue
  `failed` / `connector_unavailable` / sin referencia (la transacción se deshace entera), no hay segundo envío al banco, K2 no se toca. Es definitivo y es un 4xx: la
  `Idempotency-Key` de K1 lo guarda y lo repite (24 h), igual que cualquier conflicto determinista.
- **Alternativa descartada.** Devolver a K1 el reembolso ya resuelto de K2: respondería a K1 con el `cr_…` y, quizá, el importe de otra petición; `pay-payments` podría dar por
  cerrado con otra fila lo que pidió con otra clave. Un 409 explícito es más seguro.
- **A confirmar.** (a) Si `pay-payments` espera, tras ese 409, usar una clave nueva o consultar el reembolso de K2 (hoy el 409 del `INSERT` ya le llega igual).
  (b) Proponer añadir a la descripción del `POST` un párrafo: «`409 invalid_state_transition` también si, al reintentar una clave cuyo reembolso quedó `failed`, el
  `refund_id` ya lo tomó otra clave». Dueño: P4. Consumidor: P3 (`pay-payments`).

## PR-2 — Un `failed` del proveedor con código `connector_unavailable` se guarda como `rejected_by_provider` (F6)

- **Situación.** `connector_unavailable` es a la vez el centinela interno «el conector garantiza que no salió nada» (502 del contrato) y un `failure_code` de texto libre que un
  proveedor podría devolver. Con el mismo literal, un `failed` del proveedor (con referencia) se reabría y se reenviaba.
- **Lo implementado.** `settle()` (solo recibe resultados del proveedor o rechazos del conector) guarda `rejected_by_provider` cuando el código recibido es el centinela. La rama
  «sin efecto» de `send` sigue escribiendo el centinela directamente. El 502 hacia afuera no cambia. `provenUnsent` no cambia (exige además `provider_reference IS NULL`).
- **Efecto visible (solo en ese caso, hoy latente).** `GET /refunds/{id}` y el 201 muestran `failure_code: rejected_by_provider` en vez de `connector_unavailable`; el evento
  `connector.transaction.status_changed` sale con `validation_failed` (el cubo de «otros códigos» de `eventFailureCode`, uno de los cuatro valores que admite el AsyncAPI) en vez de
  `connector_unavailable`, que para los consumidores significa «no se envió nada» (`pay-payments` lo usa para anular la retención) y aquí sería falso: el proveedor respondió.
- **A confirmar.** (a) Que `validation_failed` es el código de evento deseado para ese caso o si el AsyncAPI debería admitir `rejected_by_provider` en `kind: refund`
  (hoy solo lo admite el de transferencias). (b) Filas ya guardadas con `failed` + `connector_unavailable` + referencia (no las produce ningún conector actual; el banco simulado
  devuelve `validation_failed`): siguen reabriéndose como antes; si existieran en una base real habría que decidirlas con una migración, no con un `UPDATE` suelto.
  Dueño: P4.

## PR-3 — `refund.failed` no tiene valor para «el proveedor rechazó el reembolso» (RE-REVISION-DINERO F-C3)

- **Situación.** `pay-connectors` puede dejar un reembolso `failed` con `failure_code: rejected_by_provider` (o `validation_failed`, `rejected_by_bank`): es un rechazo DEFINITIVO del
  proveedor, distinto de «el conector no estaba disponible» (`connector_unavailable`, que garantiza que no salió nada). `pay-payments` lo cierra bien (anula la retención del ledger
  y deja el reembolso `failed`), pero el evento público `refund.failed` solo admite cinco valores de `failure_code` (`contracts/asyncapi/payments.yaml`, `RefundFailedData`:
  `insufficient_funds`, `connector_unavailable`, `ledger_unavailable`, `invalid_state_transition`, `internal_error`) y `refundFailureCode` (`pay-payments/src/events/emit.ts`)
  publica cualquier otro código como `internal_error`.
- **Por qué no se mapea a un valor existente.** Ninguno es equivalente: `connector_unavailable` diría «no se envió nada» (falso: el proveedor respondió; es exactamente el engaño que
  cerró F6/PR-2), `insufficient_funds`/`ledger_unavailable`/`invalid_state_transition` son causas del ledger. `internal_error` es honesto pero pierde la causa.
- **Lo implementado.** Nada: el contrato `payments.yaml` NO se cambió (regla de la ola: un contrato `v1-frozen` no se rompe sin la aprobación de su dueño y de sus consumidores).
  El código del proveedor sigue guardado en la fila del reembolso (`failure_code` interno) y consultable por `GET`; solo el evento público lo aplana. Efecto: cosmético, para el
  comercio que lee `refund.failed` por webhook.
- **Propuesta.** Añadir `rejected_by_provider` al enum de `failure_code` de `RefundFailedData` en `contracts/asyncapi/payments.yaml` (aditivo: «se agregan valores; no se renombran»,
  como ya dice el contrato de `contradiction_detected`) y a `REFUND_FAILURE_CODES` en `emit.ts`; opcionalmente también `validation_failed` y `rejected_by_bank`, que hoy tienen
  el mismo problema. Un consumidor que valide el enum de forma cerrada (`additionalProperties: false` + `enum`) rechazaría el valor nuevo: hay que avisar a `pay-webhooks`,
  `pay-settlement` y `pay-schedules` (sus consumidores de `refund.failed`) y desplegar primero los consumidores.
- **A confirmar.** Dueño del contrato (`payments.yaml`): P3 (`pay-payments`). Consumidores: P1 (`pay-webhooks`), P2 (`pay-settlement`), P5 (`pay-schedules`).

## Notas de la re-revisión de dinero sobre reembolsos (RE-REVISION-DINERO F-C1 y F-C2; solo documentación, sin cambio de código)

- **F-C1 — el `409` por choque de `refund_id` no es alcanzable desde `pay-payments`.** `pay-payments` envía SIEMPRE `Idempotency-Key = ${refundId}:refund` y `refund_id = refundId`
  (`activities-money.ts:61`): una sola clave por `re_X`. El choque de PR-1 exige DOS claves con el mismo `re_X`, que `pay-payments` nunca produce. Si de todos modos llegara el `409`,
  `ConnectorsClient.createRefund` lo devuelve como `{ ok:false, status:409 }`, el `RefundWorkflow` cierra `failed` y anula la retención; **no** reintenta con otra clave ni crea un
  segundo reembolso. El único daño posible es el inverso (otra clave movió el dinero de ese `re_X` y `pay-payments` lo cierra fallido con la retención anulada); solo sería alcanzable
  desde un SEGUNDO llamador de `POST /charges/{id}/refunds` que reutilice el `refund_id`. Hoy no existe: si aparece uno, hay que revisar este punto antes de habilitarlo.
- **F-C2 — filas anteriores a F6 se reabren.** Una fila `connector_refunds` `failed` con `failure_code = connector_unavailable` **y** con referencia del proveedor, creada antes de
  PR-2, se reabre y se reenvía en el siguiente envío (solo se reconocen como resueltas las que NO llevan el literal). Solo puede existir en una base de sandbox ya poblada; no la
  produce ningún conector actual (el banco simulado devuelve `validation_failed`). Si existiera en una base real, se decide con una migración revisada, no con un `UPDATE` suelto
  (el reembolso es un registro de dinero de solo-agregar).
