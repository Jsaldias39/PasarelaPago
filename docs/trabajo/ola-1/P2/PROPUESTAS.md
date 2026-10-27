# Propuestas de P2 sobre contratos y catálogos

> P2 **no edita** `contracts/`: lo que su código necesita y el contrato no dice está acá, con la fila del contrato que habría que tocar.
> «En el código» = cómo se comporta hoy el servicio mientras el contrato no cambie.

| # | Contrato | Propuesta | En el código |
|---|---|---|---|
| 1 | `internal-ledger-v1.yaml` | Publicar la matriz llamador → tipo de cuenta que hoy vive solo en `accounts.ts` (P2-D1). | Matriz mínima; 403/422 fuera de ella. |
| 2 | `ledger-settlement.yaml` | `LedgerTransferPostedData.kind` no tiene valor para `release` (pending → available). Agregar `release` o decidir que no se publica. | `release` no publica evento. |
| 3 | `internal-ledger-v1.yaml` | `HoldCreate` sin `code`: agregarlo (`payout`, `mandate`, `adjustment`). | Se deduce del destino. |
| 4 | `common.yaml` + `@pay/problem` | Varias rutas declaran `400 BadRequest` pero el catálogo no tiene un código de 400 genérico. Agregar `bad_request` o dejar de declarar el 400. | `422 validation_failed`; `KNOWN_422_GAPS` (exacta) en las pruebas de ledger y settlement. |
| 5 | `internal-settlement-v1.yaml` | Ninguna operación declara `503 ledger_unavailable` (ni `502`/`503` de conectores), y el servicio los devuelve cuando el ledger no responde. Declararlos. | 503 `ledger_unavailable` (nada guardado: la misma `Idempotency-Key` retoma). |
| 6 | `ledger-settlement.yaml` | `payout.created` exige `settlement_batch_id`, pero hay pagos sin lote (`manual`, mandatos). Hacerlo opcional o definir el evento de un pago suelto. | Un pago suelto emite `payout.paid`/`payout.failed`, **no** `payout.created`. |
| 7 | `ledger-settlement.yaml` | `payout.failed.failure_code` no admite el rechazo definitivo del riel (`rail_rejected`). Agregarlo. | HTTP y base guardan `rail_rejected`; el evento sale como `internal_error`. |
| 8 | `ledger-settlement.yaml` / `internal-settlement-v1.yaml` | `reconciliation.exception.opened.kind` no tiene `unknown_reference` (el HTTP sí) y `ConnectorCode` usa `simulator` donde el HTTP usa `mock`. Alinearlos. | `unknown_reference` sale como `missing_in_ledger`; `mock` como `simulator`. |
| 9 | `ledger-settlement.yaml`, `merchants-schedules.yaml` | `pay-settlement` consume `ledger.transfer.posted` (para saber qué comercios existen sin leer la base de nadie) y `fee_schedule.published` (abono mensual). Agregarlo como consumidor. | Consumidores durables con inbox. |
| 10 | `internal-settlement-v1.yaml` | `POST /charges` (cobro neto de comisión programada 7.8 o deuda por contracargo D-22; `Idempotency-Key`; cuerpo en `schemas.ts#chargeCreate`). | Implementado, **fuera del contrato**; la prueba de contrato lista las rutas extra. |
| 11 | `internal-settlement-v1.yaml` | `GET /exports/accounting?period_from&period_to&format=json\|csv` (P2.H2.M7). | Implementado, **fuera del contrato**. Formato a confirmar con M16. |
| 12 | `internal-settlement-v1.yaml` | `resolve` no declara `401`: una credencial inválida es `403` (P2-D22). Declarar `401` si se prefiere distinguir. | 403 sin decir por qué. |
| 13 | `internal-settlement-v1.yaml` + `public-v1.yaml` | Los dos contratos definen `GET /payouts` en el mismo servicio. Documentar que una sola ruta atiende a `pay-edge` (forma pública, comercio de `X-Merchant-Id`) y a los internos (forma completa). | Una ruta, dos formas según el llamador; `merchant_id` y `status` no existen en la consulta pública (422). |
| 14 | `internal-settlement-v1.yaml` | Nombrar al llamador de las operaciones de operación (hoy «consola interna») y agregarlo a `ServiceId`. | `pay-console` provisorio (P2-D6). |
| 15 | `internal-settlement-v1.yaml` | `StatementFormat` por conector: hoy `Accept` decide, pero la conciliación necesita saber de antemano si espera JSON, CSV o camt.053. | `SETTLEMENT_STATEMENT_FORMATS`. |
| 16 | `internal-connectors-v1.yaml` | Elegir el `connector` de `TransferCreate` según el modo (`mock` en sandbox) y definir qué es `destination_ref` (Q-22). | `SETTLEMENT_TRANSFER_CONNECTOR`; `destination_ref = merchant_id`. |
| 17 | `internal-ledger-v1.yaml` (`Account`) + PLAN-MAESTRO §3.3 | Agregar al plan de cuentas `merchant:{id}:debt` (deudora, no se paga de más) y ampliar el patrón `Account`, que hoy no la admite. Documentar para P3 que un contracargo es un asiento de dos patas (`pending → clearing` por lo que haya, `debt → clearing` por el exceso). | La cuenta existe y el ledger la acepta (`pay-payments` y `pay-settlement`); las respuestas que la mencionan se validan con una excepción **exacta** (solo el patrón `Account`) en `test/helpers/app.ts`. |
