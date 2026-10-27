# pay-schedules

Servicio de la pasarela de pagos ALOVIDA, generado con `platform/scripts/new-service.sh`. Ver `docs/plan/PLAN-MAESTRO.md` y tu carril.

- **Base propia:** `pay_schedules`. No leas la base de ningún otro servicio.
- **Salud:** `GET /health/live` (el proceso) y `GET /health/ready` (la base propia).
- **Errores:** RFC 9457 (`application/problem+json`) con `code` estable y `request_id`.
- **Eventos:** outbox + relé hacia NATS JetStream (stream `PAY_<NOMBRE>`). Los consumidores usan `processOnce` (inbox).
- **Entorno:** ver `.env.example`. Sin variable obligatoria, el servicio no arranca.
- **Imagen:** `docker build -f services/pay-schedules/Dockerfile -t pay-schedules .` desde la raíz del repo.

Pendiente en la plantilla: un adaptador que exponga la transacción de MikroORM como `Queryable`, para escribir una
entidad y encolar su evento en **la misma** transacción. Se resuelve con el primer servicio que lo necesite (P2/P3).
