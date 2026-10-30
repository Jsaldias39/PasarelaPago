> **AVANCE P1.H3.M1: DoD ejecutado contra Svix real; la transición `A MEDIAS → HECHO` la decide el integrador (quien implementa no se aprueba).** `SvixEngine` existe, pasa la suite de contrato del motor y 63 pruebas contra svix-server 1.104.0 REAL + Postgres real + NATS real. Quedan sin ejercitar lo listado en «No cubierto».

# Informe P1 · ola 5 — `SvixEngine`, el motor de entrega real (P1.H3.M1)

- Fecha: 2026-10-30 · Carril: [`P1-plataforma-contratos-y-borde.md`](../../../plan/carriles/P1-plataforma-contratos-y-borde.md) · Rama: `claude/adoring-allen-ly7r6f` · **Sin commit** (lo hace el integrador).
- Peldaño de evidencia: **`TESTED`** para `pay-webhooks` con Svix real (los tests dirigidos al cambio pasan, con el servidor real y sin mocks del motor). No es `REGRESSION_VERIFIED`: falta la regresión de todo el sistema (E1–E8, ola 3) y los puntos de «No cubierto».
- Lo que cambió respecto de la ola 1: el motor en proceso sigue siendo un **doble**; ahora hay además un adaptador real detrás de la MISMA interfaz (`DeliveryEngine`). La suite de contrato (`test/engine-contract.ts`) la pasan los dos.

## 1. Cómo se verificó la API de Svix (nada inventado)

La imagen oficial se bajó por el espejo (`HUB=mirror.gcr.io`): `svix/svix-server:v1.104.0`, digest `sha256:fb0872f4d53e5ced46eef9349a15cc02e0ddae35d041a6f9f00fbee9dd1a0711` (el mismo que `latest` el 2026-10-30; `platform/compose.yml` ahora fija `v1.104.0`).
Fuentes, en este orden: (1) el `/api/v1/openapi.json` DEL SERVIDOR en ejecución (297 670 bytes, `info.version` 1.1.1) para rutas, cuerpos y parámetros; (2) el comportamiento observado con `curl` y con las pruebas; (3) el código de `svix/svix-webhooks@main` en `raw.githubusercontent.com` (`cfg.rs`, `worker.rs`, `endpoint/secrets.rs`, `core/types/mod.rs`, `v1/endpoints/message.rs`) para configuración y semántica. **El código de `main` no es el de 1.104.0** (el tag `v1.104.0` da 404 en `raw`): todo lo que se usa de él se comprobó además contra el servidor real.

| Qué usa el adaptador | Dónde se verificó | Observación que importa |
|---|---|---|
| `POST /api/v1/app?get_if_exists=true` `{uid,name}` | OpenAPI + curl | 201 al crear, 200 si existía: idempotente por `uid` |
| `POST /api/v1/event-type` `{name,description}` | OpenAPI + curl | **Obligatorio antes de suscribir un endpoint a un tipo** (422 «event types don't exist»); 409 `event_type_exists` si ya está. El mensaje, en cambio, acepta un tipo no registrado |
| `POST …/app/{uid}/endpoint` `{uid,url,eventTypes,secret}` | OpenAPI + curl | `eventTypes: null` = todos. **`secret` acepta `whsk_…` (Ed25519) aunque el OpenAPI solo documente `whsec_`** (patrón `^(whsec_)?…`); `GET …/secret` devuelve entonces la **`whpk_…` pública**, igual a la que calcula `@pay/webhook-signature`. 409 si el `uid` existe |
| `POST …/endpoint/{id}/secret/rotate` `{key,gracePeriodSeconds}` | OpenAPI + curl + pruebas | Las entregas posteriores llevan **dos firmas** (`v1,… v1,…`; con v1a, `v1a,… v1a,…`); vencida la gracia (probado con 1 s) una sola. La gracia admite 0–7 días |
| `PATCH …/endpoint/{id}` `{disabled}` | OpenAPI + curl | Un endpoint deshabilitado **no recibe mensajes nuevos y Svix descarta los reintentos pendientes** (observado: 2 intentos 410, deshabilitar, 0 más en 8 s) |
| `DELETE …/endpoint/{id}` | OpenAPI | 204; 404 si no existe |
| `GET …/app/{app}/endpoint` (paginado por `iterator`/`done`) | OpenAPI | 404 si la aplicación no existe |
| `POST …/app/{uid}/msg` `{eventId,eventType,payload}` | OpenAPI + curl | 202; **409 `conflict` si el `eventId` ya existe**; 422 «Payload must be an object»; 404 si la aplicación no existe |
| `GET …/msg/{eventId}` | OpenAPI + curl | Acepta el `id` (`msg_…`) **o el `eventId`** |
| `GET …/attempt/endpoint/{ep}?status_code_class=400&after=` | OpenAPI + curl | `responseStatusCode`, `statusText`, `timestamp`; del más nuevo al más viejo |

Lo que NO coincide con lo que se daba por supuesto (hallazgos):

1. **`webhook-id` ≠ id del CloudEvent.** Svix pone el `msg_…` que él asigna (estable en los reintentos y para todos los endpoints del mensaje) y el `eventId` no sale en ninguna cabecera. Contradice DT-24 y la descripción de `WebhookEvent` en `public-v1.yaml`. No se cambió el contrato: **PROPUESTAS.md, #1**.
2. **Por defecto Svix entrega `svix-id/svix-timestamp/svix-signature`**, no `webhook-*` (`docs/spikes/svix.md` daba por hecho `webhook-*`). Hace falta `SVIX_WHITELABEL_HEADERS=true` en el servidor (agregado a `platform/compose.yml`; `assertSvixReady` falla con un mensaje claro si falta).
3. **Svix NO trata el `410` de forma especial** (reintenta como cualquier fallo; `worker.rs` no lo menciona y se observó). La regla REQ-P1-6 la cumple el reconciliador de este servicio (§3).
4. **El `eventId` es único por aplicación**, no «por entorno» como dice el OpenAPI: el mismo `eventId` en dos comercios creó dos mensajes (prueba `LÍMITE: el eventId es único POR APLICACIÓN…`).
5. **Svix no valida la URL al registrar** (aceptó `https://127.0.0.1/`); sí bloquea al entregar los rangos privados (`requests to this IP range are blocked`, §4).
6. **La baja por fallos de Svix es de TIEMPO** (`endpoint_failure_disable_after`, 120 h por defecto, fallando de forma continua), no «5 entregas agotadas seguidas» como el motor en proceso: **PROPUESTAS.md, #2**.
7. Svix guarda la clave del endpoint en su base y la cifra **solo si tiene `SVIX_MAIN_SECRET`**, que `platform/compose.yml` no fija: ver «Para producción».

## 2. Qué se implementó (`services/pay-webhooks/`)

| Pieza | Archivo | Responsabilidad |
|---|---|---|
| Cliente REST (`fetch`, **sin dependencias nuevas**) | `src/engine/svix/svix-client.ts` | Rutas verificadas arriba. Dos errores que no se mezclan: `SvixApiError` (4xx definitivo) y `SvixUnavailableError` (timeout, red, 429, 5xx = **resultado ambiguo**, se reintenta con los mismos identificadores). Token y cuerpos nunca van en un error |
| Motor | `src/engine/svix/svix-engine.ts` | `provisionEndpoint` / `rotateEndpointSecret` / `removeEndpoint` / `publish` |
| Reconciliador | `src/engine/svix/svix-reconciler.ts` + `svix-reconcile.runner.ts` | 410 ⇒ deshabilitar; baja de Svix ⇒ `too_many_failures`; convergencia; huérfanos |
| Rechazo definitivo | `EngineRejectedError` en `delivery-engine.ts`; manejo en `event-ingest.ts` | Un mensaje que nunca se entregará se descarta (`term` en NATS) y se cuenta (`rejectedEngine`), en vez de reintentarse 20 veces |
| Configuración | `src/config.ts` | `WEBHOOKS_ENGINE=svix\|inprocess`; sin valor por defecto en live; en live **solo `svix`**; `WEBHOOKS_SVIX_URL` y `WEBHOOKS_SVIX_AUTH_TOKEN` obligatorios si es `svix`, validados al arrancar; https obligatorio en live; gracia ≤ 168 h con Svix |
| Cableado / salud | `webhooks.module.ts`, `health.controller.ts`, `worker.runner.ts` | Con `svix` no corre el `DeliveryWorker`; `/health/ready` informa `delivery_engine.kind` y el último resumen del reconciliador |

Mapeo: comercio `mc_…` ⇒ aplicación Svix con `uid = mc_…`; `webhook_endpoints.id` `we_…` ⇒ endpoint con `uid = we_…`; evento público ⇒ mensaje con `eventId =` **id del CloudEvent**. Las claves las **genera este servicio** con `@pay/webhook-signature` (`whsec_` / `whsk_`) y se las pasa a Svix; así v1a se conserva en la rotación y la clave que ve el comercio es, por construcción, la que firma (se comprueba releyéndola). No se guardan en `webhook_secrets` con este motor.

Regla 11 aplicada: un timeout/5xx/corte al crear el mensaje se reintenta con el MISMO `eventId`; el 409 posterior se resuelve con `GET …/msg/{eventId}` («ya existía»: 0 entregas nuevas); si no se resuelve el error sube, NATS reentrega y NUNCA se borra ni se anula nada. La rotación ambigua **mira la clave vigente antes de repetir**. El alta ambigua reconoce su propio 409 por la clave.

## 3. Evidencia (salidas literales en `evidencia/`)

**Gates** (uno a la vez; Svix, Postgres, NATS y Redis reales arriba):

```text
yarn typecheck            exit=0          evidencia/gate-typecheck.txt
yarn build                exit=0          evidencia/gate-build.txt
yarn eslint services/pay-webhooks  exit=0 (60 archivos, 0 errores, 0 avisos)   evidencia/gate-eslint.txt
yarn test  corrida 1      Test Suites: 17 passed, 17 total · Tests: 495 passed, 495 total · 27,0 s   evidencia/gate-test-run1.txt
yarn test  corrida 2      Test Suites: 17 passed, 17 total · Tests: 495 passed, 495 total · 27,1 s   evidencia/gate-test-run2.txt
```

(El informe de la ola 1 registraba 344 pruebas en 9 suites; esta ola agrega 4 suites de Svix —63 pruebas— y amplía `health.spec.ts`.) Una línea por prueba de Svix real: [`evidencia/P1.H3.M1-svix-real-verbose.txt`](./evidencia/P1.H3.M1-svix-real-verbose.txt) (63/63). E6 y cabeceras de la rotación: [`evidencia/P1.H3.M1-E6-svix-log.txt`](./evidencia/P1.H3.M1-E6-svix-log.txt).

**DoD de la fila — «Test de integración contra Svix real»:**

| # | Pedido | Prueba (archivo · título) | Qué demuestra |
|---|---|---|---|
| 1 | Mismo evento dos veces ⇒ UN mensaje y UNA entrega | `svix-integration.spec.ts` · `(1) idempotencia …` (3 pruebas); `svix-e6.spec.ts` (3 de los 12 eventos se publican dos veces en NATS) | `messages(merchant) == [eventId]` (un mensaje en Svix), el receptor HTTPS real cuenta 1 petición. Tres caminos: barrera del inbox; **inbox perdido** (409 de Svix); **transacción revertida después de crear el mensaje**. E6: 15 publicaciones ⇒ 12 mensajes ⇒ 12 entregas 200 |
| 2 | Correcto / límite / inválido | ver abajo | |
| 3 | Entrega firmada verificada con `@pay/webhook-signature` | `(2) correcto … llega por HTTPS …` | Cabeceras `webhook-*` (sin `svix-*`), `verify()` pasa; cuerpo alterado, firma alterada y secreto ajeno lanzan `WebhookVerificationError` |

Correcto: entrega firmada (v1) · rotación v1 con **dos firmas** verificadas por separado con el secreto viejo y con el nuevo (y un secreto ajeno falla) · v1a: `whpk_` verifica, y en la rotación dos firmas `v1a` · gracia de 1 s vencida ⇒ una sola firma · **endpoint caído que vuelve**: 500, 500, 200 con el mismo `webhook-id`, aceptado una vez, marca de tiempo nueva en cada intento.
Límite: evento sin endpoint / tipo no suscripto / comercio ajeno ⇒ 0 entregas y **ningún mensaje** en Svix · `*` vs tipo exacto · `eventId` de 256 caracteres pasa y de 257 se rechaza · mismo `eventId` en dos comercios · 410 con 3 eventos en vuelo ⇒ deshabilitado en Svix y en la tabla, sin más intentos ni mensajes · baja por la API · gracia 0 y 168 h en la configuración.
Inválido: payload que no es un objeto (arreglo, cadena, `null`, número, no JSON) ⇒ `EngineRejectedError(payload_invalid)` y nada en Svix · URL a la red interna ⇒ 422 **antes** de tocar Svix (no existe ni la aplicación) · el ingest convierte el rechazo del motor en `rejected` y no deja fila en el inbox · token de Svix inválido ⇒ 401, **una sola llamada**, el token no aparece en el error · Svix no responde nunca ⇒ `SvixUnavailableError` tras 4 intentos del mismo POST, sin mensaje creado, y la reentrega con el mismo `eventId` lo crea.
**Resultado ambiguo (regla 11)** con un `fetch` que pierde la respuesta *después* de que Svix ejecutó: crear el mensaje (⇒ un mensaje, una entrega), crear el endpoint (el 409 se reconoce como propio y el secreto entregado es el que firma), rotar (una sola llamada de rotación, dos firmas y no tres).
E6: `svix-e6.spec.ts` — 12 eventos por NATS real, el endpoint sano falla 2 veces por evento y luego 200 (`[500,500,200]` para cada `webhook-id`), el endpoint 410 lo deshabilita **el reconciliador por su temporizador** y deja de recibir.

**Cómo se concilia la firma de Svix con la política documentada.** Svix firma con **Standard Webhooks** (`HMAC-SHA256` base64, `v1,…`; Ed25519 como `v1a,…`) sobre `{webhook-id}.{webhook-timestamp}.{cuerpo}`: es el mismo esquema que `@pay/webhook-signature` y que `public-v1.yaml`. Por eso el mismo `verify()` del comercio valida lo que firma Svix (probado, v1 y v1a), sin cambiar el contrato de la firma. **La única discrepancia es el valor de `webhook-id`** (hallazgo 1). Además, Svix reserializa el payload (`payload` es `object` en su API): los bytes que se firman son los que Svix envía, y el comercio los verifica tal cual los recibe.

## 4. M6 (SSRF) con Svix: el control cambia de dueño

Con el motor en proceso, este servicio resolvía y fijaba la IP en cada entrega. Con Svix **la entrega la hace Svix**, así que ese control es suyo. Qué quedó probado: nuestro guard sigue rechazando con 422 al registrar (loopback, metadatos, `10.x`, http); **Svix, por su cuenta, bloquea al entregar** `169.254.169.254`, `127.0.0.1`, `localhost` y la IP privada del anfitrión (`responseStatusCode 0`, «requests to this IP range are blocked (see the server configuration)»; el receptor, que sí escuchaba en esa IP, recibió 0 peticiones). Qué NO queda probado: el **DNS rebinding** (un nombre que cambia de IP pública a privada tras el registro) con Svix, porque la prueba no controla el DNS del contenedor. El control de red de salida (`SVIX_PROXY_ADDR` / red sin ruta interna) es de despliegue (DT-21) y sigue pendiente. Ver PROPUESTAS.md #5.

## 5. No cubierto

- **Escala y carga**: el reconciliador sondea una llamada por endpoint habilitado y por ciclo (15 s por defecto); no se midió con miles de endpoints. PROPUESTAS.md #3 (webhooks operativos de Svix).
- **La baja por fallos de Svix** (`endpoint_failure_disable_after`, 120 h) **no se ejerció**: se simuló su efecto (`PATCH disabled`) y se comprobó el mapeo a `too_many_failures`. El disparador real no se esperó.
- **Los «10 minutos» de E6** del plan no se esperaron: la escalera de Svix en las pruebas es 1, 2 y 3 s (`SVIX_RETRY_SCHEDULE`); la escalera por defecto (5 s … 10 h) no se ejecutó.
- **DNS rebinding** con Svix (§4) y la salida por proxy.
- **Svix con Redis que evicta claves, reinicio de Svix a mitad de entrega, varias réplicas de `pay-webhooks`** (los reconciliadores concurrentes son idempotentes por diseño, pero no se probaron dos a la vez).
- **mTLS/https hacia Svix** (la prueba usa http local; el código exige https en live y lo valida en la configuración, probado solo como configuración).
- **Retención de payloads en Svix** (90 días por defecto, `payloadRetentionPeriod`): no se fijó ni se probó.
- La **suite de otros servicios** y el E2E E1–E8: no se corrieron (fuera de alcance).
- Un `DELETE` de endpoint cuyo resultado sea ambiguo: la baja revierte la transacción y el cliente reintenta (404 de Svix = ya no está); no hay prueba específica de la pérdida de la respuesta de ese `DELETE`.

## 6. Para producción (no es código de este carril; riesgos abiertos)

1. **`SVIX_MAIN_SECRET`** debe fijarse en el servidor Svix *antes* de guardar claves reales (no se puede cambiar después); sin él Svix guarda las claves de firma sin cifrar en su base.
2. `SVIX_JWT_SECRET` y el JWT de `WEBHOOKS_SVIX_AUTH_TOKEN` deben venir de OpenBao; los de `compose.yml` son de desarrollo.
3. `SVIX_WHITELIST_NAMES`, `SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION` y `SVIX_RETRY_SCHEDULE` corto son **solo de pruebas** (en `compose.yml` quedan cerradas por defecto).
4. `SVIX_PROXY_ADDR` hacia un proxy de salida sin ruta a la red interna (M6/DT-21).
5. Correr el compose de Svix con acceso al registro habitual (aquí se usó `HUB=mirror.gcr.io`).

## 7. Procedimiento para repetirlo

```bash
cd /home/user/pasarelapago
HUB=mirror.gcr.io SVIX_WHITELIST_NAMES='["receptor.comercio.example"]' SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION=true SVIX_RETRY_SCHEDULE=1,2,3 \
  docker compose -f platform/compose.yml --profile full up -d svix-db svix     # redis, postgres y nats ya corren
cd services/pay-webhooks && yarn typecheck && yarn build && yarn test         # 495 pruebas
cd ../.. && yarn eslint services/pay-webhooks
docker compose -f platform/compose.yml --profile full stop svix svix-db
```

Las pruebas de `test/svix/` **fallan, no se saltean**, si Svix no está (o no tiene las tres perillas): `assertSvixReady` entrega una petición firmada a un receptor HTTPS del anfitrión antes de empezar y, si no llega, dice qué falta.

## 8. Archivos tocados

Nuevos: `services/pay-webhooks/src/engine/svix/{svix-client,svix-engine,svix-reconciler,svix-reconcile.runner}.ts`; `services/pay-webhooks/test/svix/{svix-client.spec,svix-engine-contract.spec,svix-integration.spec,svix-e6.spec}.ts`, `svix-env.ts`, `svix-harness.ts`; `services/pay-webhooks/test/doubles/https-receiver.ts`; `docs/trabajo/ola-5/P1/{INFORME,PROPUESTAS,DECISIONES-TOMADAS}.md` y `evidencia/`.
Modificados: `services/pay-webhooks/src/{config,webhooks.module,health.controller}.ts`, `src/engine/{delivery-engine,worker.runner}.ts`, `src/events/event-ingest.ts`, `.env.example`, `README.md`, `test/{harness,health.spec,engine-contract}.ts`; `platform/compose.yml` (servicio `svix`: etiqueta fijada `v1.104.0`, `SVIX_WHITELABEL_HEADERS`, `SVIX_ENDPOINT_HTTPS_ONLY`, `extra_hosts`, y tres perillas de prueba cerradas por defecto).

## 9. Correcciones de la revisión independiente (REVISION-DINERO F2, F5, F8)

Decisiones DT-41 a DT-45 en `DECISIONES-TOMADAS.md`. Evidencia: `evidencia/f2f5f8-rojo.txt` (los specs nuevos contra el `src` anterior: 36 pruebas en rojo) y `evidencia/f2f5f8-verde.txt` (mismas pruebas en verde; `yarn eslint services/pay-webhooks`, `typecheck`, `build` con código 0; `yarn test` completo dos veces: 20 suites, 543 pruebas, 0 fallos). Todo contra Svix 1.104.0 y Postgres reales.

| Hallazgo | Corrección | Prueba |
|---|---|---|
| F2 | `metadata.pay_owner = WEBHOOKS_SVIX_NAMESPACE` en cada endpoint nuevo; el reconciliador solo trata como huérfano el que lleva SU marca; tope de borrados por pasada (defecto 5, suma de comercios): al superarlo no borra ninguno, avisa y expone `orphan_guard` en `/health/ready` | `test/svix/svix-reconciler-guards.spec.ts`, `test/health.spec.ts` |
| F5 | gracia efectiva = gracia + margen de reloj; gracia mínima = peor caso de un alta, validada al arrancar; borrado compensatorio del endpoint si el alta falla de forma definitiva después de crearlo | ídem + `test/svix/svix-engine-errors.spec.ts` |
| F8 | 413 ⇒ rechazo definitivo; 401/403 ⇒ `EngineMisconfiguredError` (evento pendiente, lote detenido, alerta); 404 de aplicación ⇒ recrear una vez y reintentar, salvo deriva ⇒ `EngineDriftError`; el 409 cuenta como `alreadyPublished` | `test/svix/svix-engine-errors.spec.ts` |

Cambió el arreglo (no la aserción) de una prueba existente: el huérfano de `svix-integration.spec.ts` ahora nace con la marca del entorno (sin ella, por diseño, no se borra) y el reconciliador «estricto» fija `clockMarginMs: 0`. Y la aserción de `health.spec.ts` sobre `config.svix` se amplió con los tres campos nuevos. Ninguna prueba se borró, se saltó ni se debilitó.

No cubierto de esta corrección:
- **Restauración con pocos huérfanos:** si una base restaurada deja ≤ tope endpoints propios sin fila, se borran tras la gracia (la marca distingue entornos, no «alta revertida» de «alta posterior al punto de restauración»). El tope y el aviso lo acotan, no lo eliminan.
- **Endpoints anteriores a la marca** (si los hay en algún Svix): nunca se borran; si quedaran huérfanos se limpian a mano.
- **Dos entornos con el MISMO `WEBHOOKS_SVIX_NAMESPACE`** sobre un Svix compartido: no se detecta (solo se exige que live ≠ `sandbox`).
- **`max_deliver: 20` del consumidor NATS:** con 401/403 sostenido, tras ~20 reentregas NATS deja de entregar el evento. El nak de 60 s, la pausa de 30 s y la alerta lo retrasan; subir `max_deliver` o publicar un aviso de agotamiento es un cambio de consumidor durable fuera de este alcance. El consumidor real contra NATS no se ejerció (se probó `handle` con un mensaje de mentira).
- **413 real de Svix:** no se provocó (400 KB no lo dispara en 1.104.0); se probó con un `fetch` que devuelve 413.
- **COMMIT realmente dudoso:** el caso ambiguo se probó terminando el backend de la transacción (`pg_terminate_backend`); no se probó una pérdida de red exactamente entre el `COMMIT` enviado y su respuesta.
- E2E del repo (`e2e/`) y la CLI `envprobe`: no se corrieron; ningún flujo de e2e arranca `pay-webhooks` en live con `svix`, así que `WEBHOOKS_SVIX_NAMESPACE` obligatorio en live no los afecta hoy (grep sin coincidencias fuera de logs antiguos).

## 10. Correcciones de la re-revisión de dinero (RE-REVISION-DINERO F-B1, F-B2, F-D1 de pay-webhooks, F-B3, F-B4, F-B5)

Decisiones DT-46 a DT-52 y ambigüedad A-10 en `DECISIONES-TOMADAS.md`. Procedimientos operativos: `docs/runbooks/sandbox-a-produccion.md` §7. Todo contra Postgres, NATS 2.10.29 y svix-server 1.104.0 reales. Evidencia en `evidencia/`:
`fb-nats-semantica.txt` (semántica medida de JetStream), `fb-svix-reactivar.txt` (deshabilitar/reactivar en Svix), `fb-rojo-webhooks.txt` y `fb-rojo-consumidores.txt` (pruebas nuevas contra el código anterior), `fb-mutaciones.txt`, `fb-gate-*.txt`.

| Hallazgo | Causa | Arreglo | Prueba |
|---|---|---|---|
| **F-B1** (MAYOR) | el reconciliador borraba (`deleteEndpoint`, irreversible) todo endpoint propio sin fila local pasada la gracia; tras restaurar la base, los posteriores al punto de restauración son legítimos (sonda B reproducida: 3 de 3 borrados) | `svix-reconciler.ts` (`handleOrphans`): por defecto `PATCH disabled:true` + `alert: true`; `WEBHOOKS_SVIX_ORPHAN_ACTION=delete` opt-in (live exige además `WEBHOOKS_SVIX_ORPHAN_DELETE_ACK=irreversible`, `config.ts` `parseOrphanAction`) y siempre bajo el tope (superado ⇒ no borra y deshabilita); marca de liberado `pay_orphan_review=released` (`svix-namespace.ts`); `orphan_guard` ampliado en `/health/ready` | `test/svix/svix-reconciler-orphan-action.spec.ts` (8, Svix real: restauración ⇒ 0 borrados y 3 deshabilitados con el secreto intacto; el deshabilitado no recibe; liberar con un `PATCH` restablece la entrega y el reconciliador lo respeta; re-adoptar la fila; reactivar sin marca se vuelve a deshabilitar; liberado nunca se borra; delete opt-in y tope) y `test/health.spec.ts` (configuración) |
| **F-B2** (MAYOR) | `max_deliver: 20` + `nak` fijo: tras 20 entregas JetStream da el mensaje de baja del consumidor (medido: `num_ack_pending: 0`, `ack_floor` atrás, queda en el stream, solo sale un aviso sin oyente) | `max_deliver: -1`, `ack_wait` 30 s y espera `2 s·2^(n-1)` ≤ 5 min por `deliveryCount` en los cinco consumidores (`consumer-redelivery.ts` en cada servicio; `event-consumer.ts`, `nats-consumers.ts`, `events.module.ts`, `replica.consumer.ts` ×2); migración de un durable existente con `consumers.update`; log `alert: true` desde la entrega 10; `events.max_delivery_count_seen` | `test/event-redelivery.spec.ts` (webhooks), `pay-payments/test/events.redelivery.spec.ts`, `pay-settlement/test/nats.spec.ts`, `pay-edge/test/replica-redelivery.spec.ts`, `pay-schedules/test/nats-redelivery.spec.ts`: durable creado con la configuración vieja, caída de 25 entregas (> 20), el evento se aplica al volver, UNA vez (inbox), un duplicado con otro id de NATS no lo repite, lo inservible se `term`ina |
| **F-D1** (MAYOR, webhooks) | nada comprobaba que los triggers existieran en la base desplegada | `append-only-guards.ts` + `health.controller.ts`: `checks.append_only_guards: { ok, missing[] }`; live + `ok:false` ⇒ 503; sandbox 200 visible y `warn`; fail-closed | `test/append-only-guards.spec.ts`: base creada con el DDL anterior (sin triggers), trigger apagado/otra función/otro evento, consulta caída, live 503 / sandbox 200, reaplicar el DDL restablece `ok:true` |
| **F-B3** (MENOR) | `/^[0-9A-Z]{5}$/` aceptaba `EPIPE`/`EBADF`/`ELOOP` y un `FATAL 57P01` | `isDefiniteDatabaseError` en `endpoint.service.ts`: clase SQLSTATE real de PostgreSQL y `severity === 'ERROR'` | `test/definite-database-error.spec.ts` (tabla y errores reales del driver, incluido un `57P01` FATAL real) |
| **F-B4** (MENOR) | el reconciliador solo recorre comercios con ≥ 1 endpoint local | solo documentación (README, runbook §7.2, comentario de `SvixReconciler`) | — |
| **F-B5** (MENOR) | dos despliegues con el MISMO namespace sobre un Svix compartido no se distinguen | solo documentación (runbook §7.2, README): cambiar el namespace al clonar un entorno | — |

**Pruebas existentes que cambiaron (arreglo, no aserción):** `svix-reconciler-guards.spec.ts` y `svix-integration.spec.ts` prueban el BORRADO, que ahora es opt-in: se les fijó `orphanAction: 'delete'` y sus aserciones quedaron iguales (con el defecto nuevo habrían dado rojo: el defecto ya no borra). `health.spec.ts`: la aserción de `config.svix` se amplió con `orphanAction: 'disable'`. `svix-engine-errors.spec.ts`: el mensaje de mentira del consumidor no traía `info.deliveryCount` (el consumidor ahora lo lee); se le añadió y las esperas aseveradas (`nak:60000`, `nak:2000`) son las mismas. `test/harness.ts`: opción `sqlFiles` (DDL alternativo para las pruebas de F-D1). Ninguna prueba se borró, saltó ni debilitó.

**Hallazgo de la verificación (cambia lo que pidió la re-revisión):** el `backoff` del servidor NO sirve para esto aunque la API lo acepte: con `backoff` configurado, `nak(retardo)` solo vale en la primera reentrega y un `nak()` plano reentrega en caliente (DT-49). Por eso la espera la fija el código.

**Gates:** @@GATES@@

**No cubre.**
- **Restauración real:** la «restauración» de F-B1 se reproduce borrando las filas posteriores al «respaldo» (mismo estado: Svix las tiene, la base no); no se ejecutó `pg_dump`/`pg_restore` de `pay-webhooks`.
- **Eventos entre la restauración y la reactivación:** un endpoint deshabilitado no recibe mensajes y Svix no los encola para él (medido); los eventos de ese intervalo se reenvían a mano con `…/resend` solo si Svix tiene el mensaje (si la tabla local no conocía el endpoint, el servicio ni lo publicó: hay que re-publicar desde NATS). No se automatizó.
- **Reactivación en producción:** el `PATCH`/`INSERT` del runbook se probó con el cliente y el repositorio del servicio, no con `curl`/`psql` literales contra un Svix de producción; ver cómo se obtienen las columnas del `INSERT` a partir de Svix (`signature_scheme` se infiere del prefijo de la clave) en el runbook.
- **Durables varados ANTES de migrar:** la migración no los revive (se avisa `possibly_stranded`); recuperarlos exige borrar el durable (probado con un script, `fb-nats-semantica.txt`, no con los servicios reales ni con volumen).
- **F-B2 en producción:** NATS sin autenticación de desarrollo, sin clúster (R1), sin la retención real del stream; el volumen de reproceso al recrear un durable depende de ella. Un evento que falla siempre pero no se `term`ina (un error de código no clasificado) ahora gira cada ≤ 5 min indefinidamente con `alert: true` en vez de quedar varado en silencio; no hay cola de muertos (A-10).
- **Rol de la aplicación:** F-D1 se probó con el pool de pruebas; `pg_trigger` es legible por cualquier rol.
- Los otros servicios de la lista de F-B2 solo se probaron en su consumidor; `pay-payments` y `pay-settlement` comparten árbol con los cambios de otro agente (gates de esos servicios: ver arriba).
