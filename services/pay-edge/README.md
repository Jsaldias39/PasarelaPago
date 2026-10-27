# pay-edge

Servicio de la pasarela de pagos ALOVIDA, generado con `platform/scripts/new-service.sh`. Ver `docs/plan/PLAN-MAESTRO.md` y tu carril.

- **Base propia:** `pay_edge`. No leas la base de ningún otro servicio.
- **Salud:** `GET /health/live` (el proceso) y `GET /health/ready` (la base propia).
- **Errores:** RFC 9457 (`application/problem+json`) con `code` estable y `request_id`.
- **Eventos:** outbox + relé hacia NATS JetStream (stream `PAY_<NOMBRE>`). Los consumidores usan `processOnce` (inbox).
- **Entorno:** ver `.env.example`. Sin variable obligatoria, el servicio no arranca.
- **Imagen:** `docker build -f services/pay-edge/Dockerfile -t pay-edge .` desde la raíz del repo.

Pendiente en la plantilla: un adaptador que exponga la transacción de MikroORM como `Queryable`, para escribir una
entidad y encolar su evento en **la misma** transacción. Se resuelve con el primer servicio que lo necesite (P2/P3).

## Modo, claves y comercios (D-26, D-28, D-32)

- **`PAY_MODE=sandbox|live` es obligatorio y no tiene valor por defecto.** Bajo `live` el borde no arranca con servicios dueños en loopback
  (un doble local) ni sin `NATS_URL` (sin él la réplica de claves no se enteraría de revocaciones ni de cierres). Pruebas: `test/config.spec.ts`
  y `e2e/flows/live-guard.e2e.ts`.
- **El modo de la petición sale del registro de la clave** (D-28), nunca del token ni del cliente.
- **Claves de un comercio (D-32):** suspender lo BLOQUEA (`403 merchant_suspended`, reactivable con `merchant.activated`); cerrarlo REVOCA sus
  claves (`401 unauthorized`, indistinguible de una clave inexistente, y terminal). El borde lo aplica con `api_key.revoked` Y con
  `merchant.closed` (revoca las claves que conoce y rechaza las que lleguen después), en menos de 5 s. Pruebas: `test/replica.spec.ts`
  (§ D-32, tres niveles) y `e2e/flows/key-lifecycle.e2e.ts` (procesos reales).
