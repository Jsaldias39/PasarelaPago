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

### Propietario de los endpoints en Svix, tope de borrados y errores (REVISION-DINERO F2, F5, F8)

- **`WEBHOOKS_SVIX_NAMESPACE`** (con `svix`): el propietario de los endpoints que ESTE despliegue crea. Se estampa en `metadata.pay_owner` de cada endpoint y el
  reconciliador **solo borra huérfanos que lleven su marca**. Sandbox: `sandbox` si no se declara. **Live: obligatorio** y distinto de `sandbox`
  (`^[a-z0-9][a-z0-9-]{1,31}$`; p. ej. `prod-bo`). Dos despliegues que comparten un Svix deben tener espacios distintos. Los endpoints anteriores a la marca no la
  tienen y **no se borran nunca**.
- **`WEBHOOKS_SVIX_MAX_ORPHAN_DELETES`** (defecto 5): tope de huérfanos que una pasada borra. Si hay más candidatos (base restaurada, Svix compartido) **no se borra
  ninguno**, se registra un aviso con `alert: true` (solo cifras) y se cuenta en `GET /health/ready` → `delivery_engine.orphan_guard` (`cap_trips`, `withheld_total`).
  `0` desactiva el borrado. Si `cap_trips` > 0, hay que mirar por qué antes de subir el tope.
- **`WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS`** (defecto 60): desfase tolerado entre el reloj de este servicio y el de Svix; la gracia efectiva de un huérfano es
  `WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES` + este margen. La gracia no puede ser menor que el peor caso de un alta (`ensureEventType` × tipos + `ensureApp` +
  `createEndpoint` + `getEndpointKey` + borrado compensatorio, cada uno agotando `WEBHOOKS_SVIX_MAX_ATTEMPTS` × `WEBHOOKS_SVIX_TIMEOUT_MS`): si lo es, no arranca.
- **Alta fallida tras crear el endpoint en Svix:** si la transacción del alta falla de forma definitiva (el servidor de base de datos respondió con un error o se perdió el
  bloqueo de la `Idempotency-Key`) y la fila no existe, se borra ese endpoint de Svix. Un corte de conexión es ambiguo: no se borra y lo resuelve el reconciliador.
- **Errores de Svix al publicar:** 400/422/413 ⇒ rechazo definitivo (`rejected_by_engine`, `term`); 401/403 ⇒ `EngineMisconfiguredError`: el evento queda pendiente (`nak` de 60 s),
  el consumidor detiene el lote 30 s y se cuenta en `events.engineMisconfigured` (debe ser 0); 404 de la aplicación ⇒ se recrea una vez y se reintenta, pero si los endpoints
  tampoco existen ⇒ `EngineDriftError` (pendiente, con alerta). Un 409 «ya existe» cuenta en `events.alreadyPublished`, no en `noEndpoints`.

