# Decisiones tomadas por P3 sin confirmación (ola 1)

> Cada una es el supuesto más conservador que se encontró. Quien tiene que confirmarla está en la última columna.

| ID | Ambigüedad | Supuesto tomado | Confirmar con |
|---|---|---|---|
| P3-D1 | Q-16: estado inicial del intento y cuándo se emite `requires_action` | El intento nace `processing` y emite `payment_intent.created` con `status: processing`. Pasa a `requires_action` (evento propio) cuando el conector devuelve la acción del pagador; vuelve a `processing` al confirmarse el pago mientras se asienta en el ledger; luego termina. Un cobro con saldo AloVida pasa directo de `processing` a su final. | P3 + dueño |
| P3-D2 | Q-20: emisor del `wallet_authorization` | Puerto `WalletAuthorizer`. En producción su implementación es `DisabledWalletAuthorizer`, que NIEGA todo: el saldo AloVida queda deshabilitado en lugar de inventar un emisor. Las pruebas usan un doble declarado. | Dueño + identidad |
| P3-D3 | Q-08: umbral de riesgo caído | `RISK_FAIL_CLOSED_THRESHOLD_MINOR` por defecto `0`: ante un riesgo caído, TODO cobro se rechaza (`risk_unavailable`) hasta que el negocio fije un monto. Sin números inventados. | Cumplimiento / negocio |
| P3-D4 | Una decisión `review` del riesgo | Se trata como `deny` (fail-closed): no hay revisión humana automática en esta ola. El cobro falla con `validation_failed` porque el catálogo no tiene `risk_denied` (ver PROP en PROPUESTAS.md). | P5 + dueño |
| P3-D5 | Un comercio desconocido para la réplica | Se trata como no activo: `403 forbidden` (no `merchant_suspended`, que se reserva para los que la réplica conoce como `suspended`/`closed`/`pending`). | P5 |
| P3-D6 | Comercio sin tarifa publicada para el medio | `422 validation_failed` con `errors[].code = fee_schedule_missing`: no se cobra sin tarifa. | P5 |
