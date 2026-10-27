# pay-payments

Servicio de la pasarela de pagos ALOVIDA, generado con `platform/scripts/new-service.sh`. Ver `docs/plan/PLAN-MAESTRO.md` y tu carril.

- **Base propia:** `pay_payments`. No leas la base de ningún otro servicio.
- **Salud:** `GET /health/live` (el proceso) y `GET /health/ready` (la base propia).
- **Errores:** RFC 9457 (`application/problem+json`) con `code` estable y `request_id`.
- **Eventos:** outbox + relé hacia NATS JetStream (stream `PAY_<NOMBRE>`). Los consumidores usan `processOnce` (inbox).
- **Entorno:** ver `.env.example`. Sin variable obligatoria, el servicio no arranca.
- **Imagen:** `docker build -f services/pay-payments/Dockerfile -t pay-payments .` desde la raíz del repo.

## Qué hace (P3, ola 1)

- **API pública** (la reenvía `pay-edge` sin el prefijo `/v1`, con `X-Merchant-Id`): `POST|GET /payment_intents`, `GET /payment_intents/{id}`, `POST /payment_intents/{id}/cancel`, `POST /payment_intents/{id}/refunds`.
- **API interna** (`pay-schedules`): `POST /intents`, `GET /intents/{id}` (cobros por mandato con saldo del comercio).
- **Workflows de Temporal** (`src/temporal/`): `PaymentWorkflow` (riesgo → cargo en el conector → espera/vencimiento/consulta de estado → asiento en el ledger → evento), `RefundWorkflow` (retención en dos fases) y `DisputeWorkflow`. El worker corre en el mismo proceso (`TEMPORAL_RUN_WORKER=true`) o aparte (`node dist/worker-main.js`).
- **Consumidores JetStream** (`src/events/`): `connector.transaction.status_changed`, `merchant.*`, `fee_schedule.published`, todos con inbox.
- **Resultado ambiguo ≠ fallo** (CLAUDE.md regla 11): ver `docs/trabajo/ola-1/P3/DECISIONES-TOMADAS.md` P3-D12.
- **Esquema:** `sql/001_payments.sql` (de referencia hasta que entre al modelo, D-18) más las tablas de `@pay/idempotency` y `@pay/outbox`.
- **Pruebas:** `yarn test` corre contra Postgres, NATS y Temporal REALES del Compose local y contra dobles de riesgo, conectores y ledger que validan el contrato OpenAPI (`test/doubles/`). `payment.kill.spec.ts` compila `dist/` y mata el worker con SIGKILL.

Pendiente en la plantilla: un adaptador que exponga la transacción de MikroORM como `Queryable`, para escribir una
entidad y encolar su evento en **la misma** transacción. Se resuelve con el primer servicio que lo necesite (P2/P3).
