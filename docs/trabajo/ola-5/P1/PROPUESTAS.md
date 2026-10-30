# Propuestas de cambio de contrato y de plataforma · P1 · ola 5 (`SvixEngine`)

> **Ningún contrato fue modificado** (`contracts/` no se tocó). Cada propuesta lleva el parche, quién lo aprueba y la prueba que lo respalda.
> La #1 es una **discrepancia real entre el contrato y el servidor Svix**; el resto son decisiones que dependen de otras personas.

| # | Propuesta | Toca | Aprueba | Urgencia |
|---|---|---|---|---|
| 1 | `webhook-id` deja de ser «el id del evento»: con Svix es el `msg_…` del mensaje | `public-v1.yaml` (`WebhookEvent`), DT-24, receptores de ejemplo | P1 + P5 (consumidor `INT`) + comercios | **Alta** antes de usar Svix en live |
| 2 | Definir la baja `too_many_failures` por TIEMPO (no por «N entregas agotadas») | `public-v1.yaml` (descripción del webhook), DT-12 | P1 + negocio | Media |
| 3 | Webhooks operativos de Svix en vez del sondeo por endpoint | `pay-webhooks` + plataforma | P1 | Media (antes de la escala de T-01) |
| 4 | Fijar `SVIX_MAIN_SECRET` y mover los secretos de Svix a OpenBao | `platform/`, despliegue | P1 + seguridad | **Alta** antes de claves reales |
| 5 | M6 con Svix: salida por proxy y prueba de DNS rebinding | `platform/` (Coolify) | P1 plataforma | Alta antes de live |
| 6 | Corregir `docs/spikes/svix.md` y el OpenAPI de Svix que «por entorno» no se cumple | docs | P1 | Baja |

## 1 · `webhook-id` ≠ id del evento (discrepancia con el contrato)

**Qué dice el contrato.** `public-v1.yaml`, esquema `WebhookEvent`: «`id` es el id del evento **y el mismo `webhook-id`**; no cambia en los reintentos». DT-24 (ola 1): el `webhook-id` es el `id` del CloudEvent, igual para todos los endpoints y reintentos.

**Qué hace Svix 1.104.0** (observado en 63 pruebas contra el servidor real, ver `evidencia/P1.H3.M1-E6-svix-log.txt`): `webhook-id` es el `msg_…` que Svix asigna al crear el mensaje (`webhook-id=msg_3LOgwjHQy1HWs4odb9pNI3hgcal`). Lo fija `worker.rs` (`msg_task.msg_id`), no se puede elegir desde la API y el `eventId` no sale en ninguna cabecera. **Sí** cumple lo esencial: es estable en todos los reintentos (`[500,500,200]` con el mismo `msg_…`) y único por mensaje, así que la deduplicación por `webhook-id` sigue funcionando. El `id` del cuerpo (`WebhookEvent.id`) sigue siendo el id del CloudEvent.

**Qué NO se cambió.** El contrato, DT-24 ni `@pay/webhook-signature` (verifica con el `webhook-id` que reciba: probado con v1 y v1a).

**Parche propuesto** (`public-v1.yaml`, `WebhookEvent.description`):

```diff
-        `id` es el id del evento y el mismo `webhook-id`; no cambia en los reintentos.
+        `id` es el id del evento y no cambia nunca. `webhook-id` identifica el MENSAJE: es opaco, único y no cambia en los reintentos
+        (con el motor en proceso coincide con `id`; con Svix es un `msg_…`). Para deduplicar, usá `id` del cuerpo o `webhook-id`;
+        no asumas que son iguales.
```

**Impacto.** (a) Consumidores que usan `webhook-id` como clave de deduplicación, como el receptor de `INT` (`gateway_event_ref = pay-gateway:<webhook-id>`): siguen deduplicando. (b) Quien cruce `webhook-id` con el id del evento de NATS, no: debe leer `id` del cuerpo. (c) Si el negocio exige que `webhook-id == id`, no se puede con Svix OSS: habría que firmar en este servicio (motor propio) o publicar una cabecera propia `x-pay-event-id` (Svix permite cabeceras fijas por endpoint, no por mensaje, así que tampoco sirve) — decisión de negocio.

## 2 · Baja por fallos: umbral de tiempo

El contrato dice «tras varias entregas agotadas seguidas, el endpoint se deshabilita (`too_many_failures`)» y DT-12 fijó **5** entregas agotadas seguidas (cifra propia). Svix deshabilita un endpoint que **falla de forma continua** durante `SVIX_ENDPOINT_FAILURE_DISABLE_AFTER` (120 h por defecto; `cfg.rs`, `endpoint_failure_disable_after`), sin contar entregas. El reconciliador mapea ese estado a `too_many_failures`, así que la API pública no cambia, pero **el criterio es otro**. «Varias» es vago, no hay ruptura de contrato; lo que cambia es lo que le toca esperar al comercio (días, no 5 mensajes). **Se propone** escribirlo así en el contrato: «el endpoint que no responde `2xx` durante 5 días seguidos se deshabilita». No se ejercitó el disparador real (120 h): solo su efecto (`No cubierto` del informe).

## 3 · Sondeo vs webhooks operativos de Svix

El 410 no lo trata Svix, así que se detecta mirando los intentos 4xx de cada endpoint (`GET …/attempt/endpoint/{id}?status_code_class=400`), una llamada por endpoint habilitado y por ciclo (15 s). Con miles de endpoints son miles de llamadas por ciclo. Svix puede **avisar** con webhooks operativos (en `worker.rs` de `main`: `OperationalWebhook::MessageAttemptFailing`, `MessageAttemptExhausted` y `EndpointDisabled`; se configuran con `operational_webhook_address`, `cfg.rs`; los nombres de evento y el payload NO se verificaron contra el servidor 1.104.0). **Se propone**, antes de T-01: que `pay-webhooks` exponga un receptor interno de esos avisos (autenticado con la firma de Svix) y reconcilie solo los endpoints mencionados, dejando el sondeo completo como barrido lento de respaldo. Lo hecho hoy es correcto y simple; lo que no hace es escalar.

## 4 · Secretos de Svix

- `platform/compose.yml` no fija `SVIX_MAIN_SECRET`: sin él Svix **guarda las claves de firma de los endpoints sin cifrar** en su base (`cfg.rs`: «used for client-side encryption of sensitive data … once set, it can't be changed»). Debe fijarse antes de la primera clave real, con un valor en OpenBao.
- `SVIX_JWT_SECRET` (`dev-only-change-me` en el compose) y el JWT de `WEBHOOKS_SVIX_AUTH_TOKEN` también, desde OpenBao. El JWT del servicio debería tener la vida más corta que permita la rotación (`svix-server jwt generate` emite uno de ~10 años).
- Svix guarda el payload de cada mensaje 90 días (`payloadRetentionPeriod`); la política de payload (sin PII) lo hace tolerable, pero es un copia más de datos de pagos fuera de nuestras bases. Decisión de retención: P1 + negocio.

## 5 · SSRF (M6) con Svix

Ver INFORME §4. Falta: (a) `SVIX_PROXY_ADDR` apuntando a un proxy de salida sin ruta a la red interna (hoy DT-21 «control de despliegue»); (b) una prueba de **DNS rebinding** contra Svix (un nombre que cambia de IP pública a privada tras el registro), que exige un DNS controlable en el entorno de pruebas; (c) decidir si se confía en el filtro de Svix (que bloqueó 4 destinos privados en las pruebas) o se sigue exigiendo el proxy.

## 6 · Documentación

- `docs/spikes/svix.md` (fuera de alcance, no editado) da por hecho que Svix usa las cabeceras `webhook-*` por defecto; hace falta `SVIX_WHITELABEL_HEADERS=true`.
- El OpenAPI de Svix 1.104.0 dice que el `eventId` es único «para cualquier aplicación del entorno»; en la práctica lo es por aplicación. El adaptador contempla ambos (si Svix lo hiciera por entorno, un 409 sin mensaje en la aplicación del comercio se rechaza como `event_id_conflict`).
