# Decisiones tomadas por P4 (ola 1) sin confirmación

Cada una usa el supuesto conservador. Quien confirma está en la última columna. Ninguna cambia un contrato.

| ID | Ambigüedad | Supuesto tomado | Dónde | Confirma |
|---|---|---|---|---|
| D-P4-01 | Q-01/Q-11: formato de callbacks, firma y extractos del Mercantil | No se inventa nada: el adaptador del banco no existe (P4.H2.M3/M4 `BLOQUEADAS`). El simulador firma con Standard Webhooks, como fija el contrato para `mock`. | `src/connectors/mock/` | Mercantil (15 pedidos de `docs/spikes/banco-mercantil.md`) |
| D-P4-02 | Nombre de los secretos de cada conector | `CONNECTOR_<CODIGO>_WEBHOOK_SECRET`, un espacio de nombres por conector; [DEV] por entorno `PAY_SECRET_…`. OpenBao queda detrás de `SecretProvider`. | `src/domain/secrets.ts` | P1 (OpenBao) |
| D-P4-03 | Callback con una referencia que no es nuestra | `200 contradiction` sin cobro, registrado en `connector_callback_events` (no `404`): el proveedor no debe reintentar eternamente y la conciliación lo ve. | `src/core/apply.ts` | P2 |
| D-P4-04 | Callback con importe distinto del cobrado | `contradiction`: nunca se da por pagado un cobro con otro monto. | `src/core/apply.ts` | P3 |
| D-P4-05 | Mapa de estados | Proveedor (`pending/authorized/captured/failed/canceled/expired`) → público: `pending`+acción ⇒ `requires_action`, `authorized` ⇒ `pending`, `captured` ⇒ `succeeded`. | `src/domain/status-map.ts` | P3 |
| D-P4-06 | `card_token` ¿obligatorio para tarjeta? | Opcional (D-17: página alojada por defecto); rechazado para otros medios; **no se persiste**. | `src/core/charge.dto.ts` | P3 |
| D-P4-07 | Idempotencia repetida de `POST /charges` | Se responde el estado original (`201`) con `Idempotency-Replayed: true`, como `@pay/idempotency` (el `200` del contrato no se usa para la repetición por clave). `POST /transfers` sí devuelve `200` para el mismo par `business_ref`+`attempt` con otra clave. | `src/http/send.ts` | P1 |
| D-P4-08 | Un solo cobro vivo por intento | Índice único parcial: un segundo cobro del mismo `payment_intent_id` ⇒ `409 invalid_state_transition` mientras el primero esté pendiente, autorizado o cobrado. | `sql/001_connectors.sql` | P3 |
| D-P4-09 | Timeout ambiguo | Se reintenta la MISMA llamada (`timeoutRetries`, 2) con la misma referencia; si persiste ⇒ `502` y la fila queda marcada; **nunca** se cambia de conector (regla 11). | `ProviderGateway.callIdempotent` | P3 |
| D-P4-10 | Umbral de salud | 3 fallos consecutivos ⇒ `down` (sale del ruteo, publica `degraded`); 1 éxito ⇒ `up` (publica `recovered`). Configurable. | `src/core/health.service.ts` | P3 |
| D-P4-11 | Un QR estático vigente por comercio | Un segundo pedido devuelve el mismo (`200`). | `services/pay-qr` | P3/P5 |
| D-P4-12 | GUID del operador en el QR | Configurable (`QR_ACCOUNT_GUID`) y provisional: el perfil boliviano NO está verificado (REQ-P4-7 `AMBIGUOUS`). | `services/pay-qr/docs/perfil-qr-bo.md` | BCB / Mercantil |
| D-P4-13 | Glosa del extracto | No sale del servicio (`description: null`). | `src/core/statements.service.ts` | P2 |
| D-P4-14 | Excepciones de conciliación | `unmatched`, `amount_mismatch`, `late_credit` se registran sin repetirse; solo `bank_transfer` confirma cobros desde el extracto. | `statements.service.ts` | P2 |
| D-P4-15 | `404` de una referencia de transferencia | `transfer_not_found` SOLO si el proveedor responde explícitamente `not_found`; sin fila nuestra también (la fila se escribe antes de llamar). Un rechazo genérico o un error NO es `not_found`. | `transfers.service.ts` | P2 |
| D-P4-16 | `Unavailable` tras un intento ambiguo | Se eleva a ambiguo (`500 internal_error`), la fila se conserva con `may_have_reached_provider`. `connector_unavailable` solo en la primera llamada. | `ProviderGateway`, `transfers.service.ts`, `refunds.service.ts`, `charges.service.ts` | P2/P3 |
| D-P4-17 | Transferencia con `connector_unavailable` definitivo | La fila pasa a `failed` (motivo `connector_unavailable`), no se borra; el reintento es el siguiente `attempt`. | `transfers.service.ts` | P2 |
| D-P4-18 | Reembolso de una transferencia bancaria | Rechazado (`validation_failed`): devolver una transferencia es una orden de pago saliente no modelada. | `bank-transfer.connector.ts` | P2 |
| D-P4-19 | Nombre y ciudad del comercio en el QR | Valores fijos declarados (`ALOVIDA PAY` / `Santa Cruz`) hasta que `pay-merchants` exponga un contrato. | `src/connectors/qr-http.client.ts` | P5 |
| D-P4-20 | Fallo de `raw` vs `json` en callbacks | `/callbacks/*` recibe el cuerpo CRUDO (la firma se calcula sobre bytes exactos); el resto, JSON de hasta 256 kB. | `src/app.setup.ts` | P1 |
| D-P4-21 | Carrera entre envíos concurrentes de una misma transacción de dinero (HIGH) | Envío serializado por `pg_try_advisory_lock` con sondeo (el que espera devuelve su conexión al pool: sin interbloqueo); lectura+marca del flag en una sola sentencia; flag y `send_claims` MONÓTONOS (trigger en la base); «no se envió» solo con `send_claims = mine` y `prior = false` en la misma sentencia del cambio de estado; el segundo envío vuelve a leer y no llama si ya quedó resuelto. Aplica a transferencias, reembolsos y cobros. | `src/core/send-lock.ts`, `sql/001_connectors.sql` | P1/P2/P3 |
