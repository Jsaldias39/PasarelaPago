# Decisiones de P4 en la ola 2 (tanda 2a, adaptación a contratos)

| ID | Ambigüedad | Supuesto tomado | Confirma |
|---|---|---|---|
| D-P4-22 | ¿Qué hacer si llega otro pedido con el mismo `refund_id` pero otra `Idempotency-Key`? | `409 invalid_state_transition` (índice único parcial sobre los `refund_id` no fallidos). Devolver el reembolso original sería más amable, pero el contrato solo declara `201`, y el riesgo de un segundo reembolso pesa más. Un `cr_…` fallido libera su `refund_id`. | P3 |
| D-P4-23 | `GET /refunds/{id}` cuando el proveedor responde `not_found` explícito para un reembolso `pending` | Se informa `pending` con `stale: false` y la fila no cambia: el contrato solo define `404` para «este servicio no lo tiene», y pasar a `failed` por un `not_found` rompería la regla 11 si el proveedor es eventualmente consistente. Lo resuelve una persona o el reintento con la misma clave. | P3 |
| D-P4-24 | `observed_via` de `connector.transfer.status_changed` | `status_inquiry` en todos los casos: el estado se averigua en la respuesta de la orden o al consultar, no por un callback del banco (el banco no notifica transferencias salientes en lo que conocemos). | P2 |
| D-P4-25 | Códigos de fallo de la transferencia | Se guardan y se publican los cuatro del contrato: `rejected_by_bank`, `rejected_by_provider`, `connector_unavailable`, `validation_failed`. Cualquier rechazo genérico del adaptador sale como `rejected_by_provider` (la base exige que `failed` traiga código). | P2 |
| D-P4-26 | Cuenta de la transferencia en sandbox | `BANK_TRANSFER_BANK_NAME/ACCOUNT_HOLDER/ACCOUNT_NUMBER`: los tres o ninguno (configuración a medias falla al arrancar). Los valores de `.env.example` y de las pruebas son SINTÉTICOS y llevan «SANDBOX». Sin variables, nada se inventa. | Dueño / T-03 |
| D-P4-27 | `GET /refunds/{id}` con id mal formado | `404 resource_not_found` (coherente con los cobros), no `400`: «mal formado» y «no existe» no se distinguen. | P3 |
| D-P4-28 | `ct_…` | No se emite. El aceptarlo como alias es del lado de los consumidores; el productor ya cita `ch_`/`cr_`. | P2/P3 |

## Tanda 2b — D-28 (`X-Pay-Mode`)

| ID | Ambigüedad | Supuesto tomado | Confirma |
|---|---|---|---|
| D-P4-29 | Nombre de las columnas de modo | `pay_mode` (`test\|live`, el de la CLAVE del pedido) y `connector_mode` (`sandbox\|live`, el del conector; antes `mode`). La API sigue mostrando el modo del conector como `mode`. | P3/P2 |
| D-P4-30 | Extractos (`GET /statements`) y salud (`GET /connectors/health`) | El contrato declara el modo **opcional** y `pay-settlement` no lo manda al pedir extractos: si viene se valida igual (inválido o de otro despliegue ⇒ `403`), si no viene no hay modo. El extracto del banco no es por modo; con modo, filtra solo el emparejamiento con cobros. Se exige en las 8 operaciones que mueven o consultan cobros, reembolsos y transferencias. | P2 |
| D-P4-31 | `403` vs `404` ante un id del otro modo | `404` (no revela que existe), como el ledger. La discordancia de modo contra el DESPLIEGUE es `403`. | — |
| D-P4-32 | Orden de las comprobaciones | Identidad de servicio (403) → modo (403) → `Idempotency-Key` (400) → cuerpo (422). Sin modo válido no hay ningún efecto. | — |
| D-P4-33 | `mode` en los eventos | **No se agregó**: `connectors.yaml` no lo admite (`additionalProperties: false` en `data` y en el sobre; solo los eventos públicos de `payments.yaml` lo admiten). Propuesta en `PROPUESTAS.md`. Los consumidores obtienen el modo del registro (`GET` por id, con su propia cabecera). | Coordinador |
| D-P4-34 | `pay-qr` | Exige `PAY_MODE` (sandbox\|live) al arrancar, igual que `pay-connectors`: es un cambio de configuración obligatoria. `POST /qr/decode` (sin estado) también exige el modo, por uniformidad. | P1 |
| D-P4-35 | Callbacks | El modo sale del **registro del cobro**; un `X-Pay-Mode` en el callback se ignora. Un callback de una referencia ajena queda con `pay_mode` nulo. Los barridos internos (poller, conciliación) usan el modo del registro, nunca una cabecera. | — |
