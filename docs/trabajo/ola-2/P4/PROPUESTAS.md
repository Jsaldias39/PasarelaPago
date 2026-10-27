# Propuestas de P4 — ola 2, tanda 2b

| # | Cambio propuesto | Por qué |
|---|---|---|
| 1 | `contracts/asyncapi/connectors.yaml`: agregar `mode` (`test\|live`, opcional) a `ConnectorTransactionStatusChangedData` y `ConnectorTransferStatusChangedData` | La coordinación pidió `mode` opcional «porque el contrato ya lo admite», pero en los eventos del conector **no** está (`additionalProperties: false`); sin él un consumidor tiene que ir al registro para saber el modo. P4 lo publicaría desde `pay_mode` del cobro/reembolso/transferencia. |
| 2 | `contracts/openapi/internal-qr-v1.yaml`: declarar el parámetro `PayMode` (`common.yaml`) en las 6 operaciones y el `403` | `pay-qr` ya lo exige en toda ruta (D-28); el contrato no lo dice. |
| 3 | `contracts/openapi/internal-connectors-v1.yaml`: aclarar que `GET /statements` acepta `X-Pay-Mode` pero `pay-settlement` no lo manda | Hoy el contrato lo lista; la implementación lo trata como opcional (D-P4-30). Decidir si `pay-settlement` debe mandarlo y, entonces, exigirlo. |
| 4 | Plantilla (`platform/templates/service`) y los 10 `test/health.spec.ts`: `expect(text).not.toContain('4111')` es **intermitente** (≈ 1–2 % por corrida): el `request_id` es un UUID aleatorio y puede contener `4111` (p. ej. `…a641118`). | Pasó en `pay-qr` durante esta tanda. Afirmar con el número completo (`4111111111111111`), como ya hicieron `pay-connectors` y `pay-qr`. **Los otros 8 servicios siguen con el defecto.** Es una de las causas posibles de «fallos intermitentes bajo carga». |
