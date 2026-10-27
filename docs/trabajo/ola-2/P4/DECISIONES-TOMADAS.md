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
