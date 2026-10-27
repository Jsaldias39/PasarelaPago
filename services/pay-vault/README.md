# pay-vault

Servicio de la pasarela de pagos ALOVIDA, generado con `platform/scripts/new-service.sh`. Ver `docs/plan/PLAN-MAESTRO.md` y tu carril.

- **Base propia:** `pay_vault`. No leas la base de ningún otro servicio.
- **Salud:** `GET /health/live` (el proceso) y `GET /health/ready` (la base propia).
- **Errores:** RFC 9457 (`application/problem+json`) con `code` estable y `request_id`.
- **Eventos:** outbox + relé hacia NATS JetStream (stream `PAY_<NOMBRE>`). Los consumidores usan `processOnce` (inbox).
- **Entorno:** ver `.env.example`. Sin variable obligatoria, el servicio no arranca.
- **Imagen:** `docker build -f services/pay-vault/Dockerfile -t pay-vault .` desde la raíz del repo.

## Qué hace (P3, ola 1)

- Implementa `internal-vault-v1.yaml`: `capture_sessions`, `tokens/{token}` (metadatos y borrado) y `tokens/{token}/reveal` (solo `pay-connectors`, auditado, `Cache-Control: no-store`).
- **No guarda tarjetas.** Delega en un `VaultBackend` (`src/backend/`); hoy solo existe `FakeVaultBackend`, un DOBLE en memoria que la configuración prohíbe con `PAY_MODE=live` (`VAULT_BACKEND=fake`). La base solo tiene metadatos del token, sesiones y auditoría (`sql/001_vault.sql`).
- **Tokens por comercio:** el de otro comercio es indistinguible de uno inexistente (404).
- **El PAN no sale de acá:** `test/pan-leak.spec.ts` recorre todas las tablas, los logs y las respuestas buscando el PAN de prueba.

Pendiente en la plantilla: un adaptador que exponga la transacción de MikroORM como `Queryable`, para escribir una
entidad y encolar su evento en **la misma** transacción. Se resuelve con el primer servicio que lo necesite (P2/P3).
