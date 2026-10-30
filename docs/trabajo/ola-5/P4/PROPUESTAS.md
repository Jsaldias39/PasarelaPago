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
