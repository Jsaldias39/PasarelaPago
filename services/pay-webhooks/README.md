# pay-webhooks

Servicio de la pasarela de pagos ALOVIDA, generado con `platform/scripts/new-service.sh`. Ver `docs/plan/PLAN-MAESTRO.md` y tu carril.

- **Base propia:** `pay_webhooks`. No leas la base de ningún otro servicio.
- **Salud:** `GET /health/live` (el proceso) y `GET /health/ready` (la base propia).
- **Errores:** RFC 9457 (`application/problem+json`) con `code` estable y `request_id`.
- **Eventos:** outbox + relé hacia NATS JetStream (stream `PAY_<NOMBRE>`). Los consumidores usan `processOnce` (inbox).
- **Entorno:** ver `.env.example`. Sin variable obligatoria, el servicio no arranca.
- **Imagen:** `docker build -f services/pay-webhooks/Dockerfile -t pay-webhooks .` desde la raíz del repo.

Pendiente en la plantilla: un adaptador que exponga la transacción de MikroORM como `Queryable`, para escribir una
entidad y encolar su evento en **la misma** transacción. Se resuelve con el primer servicio que lo necesite (P2/P3).

## Motor de entrega de webhooks (P1.H3)

`WEBHOOKS_ENGINE=svix|inprocess` (ver `.env.example`). `svix` usa un servidor [Svix](https://github.com/svix/svix-webhooks) real por REST (`src/engine/svix/`);
`inprocess` es un doble que firma y reintenta con Postgres y es el único admitido sin Svix en sandbox. Bajo `PAY_MODE=live` solo arranca con `svix`.
Las pruebas de `test/svix/` corren contra un svix-server real (1.104.0, `platform/compose.yml`, perfil `full`) y FALLAN si no está: levantalo con

```bash
HUB=mirror.gcr.io SVIX_WHITELIST_NAMES='["receptor.comercio.example"]' SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION=true SVIX_RETRY_SCHEDULE=1,2,3 \
  docker compose -f platform/compose.yml --profile full up -d svix-db svix
```

(`HUB=mirror.gcr.io` solo si no hay acceso a Docker Hub; las tres variables `SVIX_*` abren perillas de pruebas y nunca se usan en producción.) Detalle y
evidencia: `docs/trabajo/ola-5/P1/INFORME.md`.
