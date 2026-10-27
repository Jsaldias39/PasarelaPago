# pay-schedules

Pagos programados de la pasarela de pagos ALOVIDA (carril P5, `P5.H3`): el médico paga una obligación mensual (7.7) y un proveedor paga su comisión a ALOVIDA (7.8).

- **Base propia:** `pay_schedules`. No leas la base de ningún otro servicio.
- **Esquema:** `sql/001_schedules.sql` es **SQL de referencia, a mover a `mantra-core-health-model`** (D-18).
- **API pública** (la reenvía `pay-edge`, con `X-Merchant-Id` y `X-Pay-Mode: test|live`, D-28): `POST|GET /mandates`, `DELETE /mandates/{id}`. Contrato: `contracts/openapi/public-v1.yaml`.
- **Eventos:** `mandate.created|canceled`, `scheduled_payment.executed|failed|insufficient_funds` (solo ids y montos). Consume `merchant.activated|suspended|closed` de `pay-merchants` (réplica con inbox).

## Cómo ejecuta

Una corrida (`ExecutorService.runOnce`, cada `RUN_INTERVAL_SECONDS`) materializa un pago por `(mandato, periodo)` (UNIQUE en la base) y avanza los pendientes con `pay-ledger`:
`hold merchant:{pagador}:available → schedule:{mandato}:reserve` → confirmar → asiento `reserve → merchant:{beneficiario}:available` (`platform:fees` en las comisiones).
Cada fase se guarda antes de la siguiente y cada llamada lleva una clave estable por (pago, fase, intento).

- **Un resultado ambiguo no es un fallo** (regla 11 del CLAUDE.md): un timeout, un corte o un 5xx se reintentan con la **misma** clave; nunca se anula una retención ni se borra una fila. Si la política se agota con algo sin resolver, el pago queda `failed` con `needs_review = true` para una persona.
- **Sin fondos:** `paused_insufficient_funds`, aviso `scheduled_payment.insufficient_funds` con `retry_at`, y reintento con un `attempt` nuevo del libro mayor. Agotada la política: `scheduled_payment.failed`.
- **La política de reintentos no tiene valor por defecto** (`RETRY_DELAYS_SECONDS`): la fija el negocio; sin ella el servicio no arranca.

## Entorno

Ver `.env.example`. Obligatorias y sin valor por defecto: `LEDGER_URL`, `RETRY_DELAYS_SECONDS`.

## Lo que NO es real todavía

- **`pay-ledger` es un [DOBLE] en las pruebas** (`test/doubles/ledger.double.ts`, valida cada llamada contra `internal-ledger-v1.yaml`). Falta correr el flujo contra el libro mayor real de P2.
- El consumidor NATS de `merchant.*` (`replica.consumer.ts`) no se probó contra un NATS real; sí el parseo, el orden y el inbox.
- `scheduled_payment.executed.ledger_transfer_id` cita el asiento `tx_…` que devuelve el libro mayor (contrato de la ola 2); los eventos llevan el `mode` del mandato.

## Comandos

```bash
yarn typecheck && yarn test        # Postgres REAL; el libro mayor es un [DOBLE] declarado
```
