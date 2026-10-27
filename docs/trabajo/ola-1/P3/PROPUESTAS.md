# Propuestas de cambio a contratos y librerías compartidas (P3, ola 1)

> Las escribe P3 y NO las aplica: `contracts/` y `@pay/*` no son de este carril. Cada una trae el parche exacto.

## PROP-1 · Los contratos de ledger y conectores no declaran 503 (la caída sale como 500)
- **Dónde:** `contracts/openapi/internal-ledger-v1.yaml`, `internal-connectors-v1.yaml` (solo `internal-risk-v1.yaml` declara `503`).
- **Hallazgo:** el doble del ledger intentó responder `503 ledger_unavailable` y el validador de contrato lo rechazó: el contrato solo tiene `500` (`ServerError`, cuyo texto dice «dependencia caída (`ledger_unavailable`)»).
- **Qué hace P3 hoy:** trata todo 5xx como falla de la dependencia (reintento acotado + circuit breaker), así que funciona con 500 o 503.
- **Parche propuesto:** en `common.yaml` agregar `ServiceUnavailable` (503, `application/problem+json`, `Retry-After`) y referenciarlo en las operaciones de ledger y conectores; o aclarar que la caída es `500` con ese `code`.

## PROP-2 · El id del asiento no coincide entre contratos (`tx_…` vs `tf_…`)
- **Dónde:** `internal-ledger-v1.yaml` (`Transaction.id`: `^tx_[a-z0-9]{10,40}$`) y `asyncapi/payments.yaml` (`LedgerTransferId`: `^tf_[a-z0-9]{10,40}$`).
- **Qué hace P3 hoy:** al publicar `payment_intent.succeeded`, `refund.succeeded` y `dispute.lost` convierte `tx_<cuerpo>` en `tf_<cuerpo>` (`transferIdForEvent`).
- **Parche propuesto:** unificar. Lo más simple: que el evento use el patrón `^(tx|hd)_…` del ledger (el cuerpo ya identifica el asiento) y se elimine la conversión.

## PROP-3 · El código de conector del evento (`simulator`) no coincide con el de la API (`mock`)
- **Dónde:** `internal-connectors-v1.yaml` (`Connector`: `mock|mercantil_qr|mercantil_card|bank_transfer`) vs `asyncapi/payments.yaml` (`ConnectorCode`: `simulator|…`).
- **Qué hace P3 hoy:** mapea `mock → simulator` al publicar `payment_intent.processing`.
- **Parche propuesto:** usar `mock` en los dos (o `simulator` en los dos).

## PROP-4 · Faltan códigos de error para «riesgo denegó» y «tarjeta rechazada»
- **Dónde:** `contracts/packages/problem/src/catalog.ts` y el enum `failure_code` de `PaymentIntentFailedData`.
- **Qué hace P3 hoy:** un `deny`/`review` de riesgo y un rechazo del conector (422) terminan en `failure_code: validation_failed`.
- **Parche propuesto:** agregar `risk_denied` (422) y `payment_declined` (422) al catálogo y al enum del evento.

## PROP-5 · No hay evento para una contradicción del conector (REQ-P3-3 pide «se publica para conciliación humana»)
- **Qué hace P3 hoy:** la guarda en la tabla `intent_contradictions` (única por intento+evento) y la registra en el log con ids, sin datos de personas.
- **Parche propuesto:** agregar `payment_intent.contradiction_detected` (`data`: `payment_intent_id`, `merchant_id`, `current_status`, `incoming_status`, `detected_at`) a `asyncapi/payments.yaml`, para que P2 (conciliación) lo consuma.

## PROP-6 · No existe API para disputas (apertura, evidencia, resultado)
- **Dónde:** ni `public-v1.yaml` ni `internal-payments-v1.yaml` tienen operaciones de disputas; solo hay eventos `dispute.*`.
- **Qué hace P3 hoy:** implementa `DisputesService` + `DisputeWorkflow` (probados por servicio, sin HTTP).
- **Parche propuesto:** `POST /disputes`, `POST /disputes/{id}/evidence`, `POST /disputes/{id}/resolve` en `internal-payments-v1.yaml`, con `X-Service-Id` de quien hoy recibe el aviso del banco (P4).

## PROP-7 · La acción `bank_transfer_instructions` del conector no trae los datos de la cuenta
- **Dónde:** `internal-connectors-v1.yaml` (`ChargeNextAction`: solo `reference`) vs `public-v1.yaml` (`NextAction.bank_transfer`: `bank_name`, `account_holder`, `account_number` obligatorios).
- **Qué hace P3 hoy:** toma esos tres datos de la configuración (`BANK_TRANSFER_*`), que describe la cuenta recaudadora (que todavía no existe, T-03). Sin configurarla, el medio `bank_transfer` responde `422 payment_method_unavailable`.
- **Parche propuesto:** que el conector devuelva `bank_name`, `account_holder` y `account_number` en la acción (la cuenta es del conector/banco, no de pay-payments).
