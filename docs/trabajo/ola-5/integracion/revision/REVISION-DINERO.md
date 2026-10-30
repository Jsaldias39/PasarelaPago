# Revisión adversarial (dinero) — olas 3 a 5

- Revisor: agente independiente, SOLO LECTURA (no se editó código, no se commiteó, no se corrió ninguna suite).
- Rama: `claude/adoring-allen-ly7r6f` (HEAD `faac855` al revisar). Reglas de referencia: CLAUDE.md 4 a 11.
- Método: lectura de código y de los commits `e2c74a1`, `cef55ca`, `6b730e2`; dos reproductores de un solo archivo contra `services/pay-payments/dist/` (Node, sin base ni red externa; scripts en el scratchpad de sesión). No hay PostgreSQL ni Svix levantados en esta máquina, así que **nada de lo que dependa de la base o de Svix se ejecutó**.
- Etiquetas: **CONFIRMADO** = lo ejecuté y vi el resultado. **INFERENCIA** = sale de leer el código, no se ejecutó.

## Resumen por severidad

| # | Sev. | Punto | Hallazgo | Estado |
|---|---|---|---|---|
| F1 | MAYOR (condicional a `RISK_ALLOW_BELOW_THRESHOLD=true`, apagada por defecto) | 3 | La franquicia «bajo el umbral pasa» puede dar ALLOW con una evaluación de riesgo viva o ya resuelta como `deny`: el reintento interno del `HttpClient` enmascara el timeout; un 5xx y un `unexpected_response` también se tratan como «no hay evaluación» | masking CONFIRMADO; el resto INFERENCIA |
| F2 | MAYOR (condicional a despliegue/restauración) | 4 | El reconciliador de Svix borra como «huérfano» todo `we_…` que su base no conoce, sin espacio de nombres por entorno/modo y sin freno de volumen: una base restaurada o un Svix compartido borra endpoints legítimos | INFERENCIA |
| F3 | MENOR | 2 | Con `ignoreTimeouts`, un timeout de la sonda deja el breaker en `half_open` para siempre y el resto de las llamadas recibe `circuit_open`; sin tope de concurrencia contra un riesgo colgado | CONFIRMADO (breaker); impacto INFERENCIA |
| F4 | MENOR | 1 | Reabrir un reembolso `failed` puede chocar con `connector_refunds_refund_id_uidx` (23505 sin capturar): la clave original queda en 500 para siempre | INFERENCIA |
| F5 | MENOR | 4 | Ventana de huérfano: gracia de 10 min (configurable a 1) comparada con el reloj de Svix; un alta fallida deja un endpoint vivo con secreto jamás entregado hasta el barrido | INFERENCIA |
| F6 | MENOR | 1 | `connector_unavailable` es a la vez centinela interno y un `failure_code` que el proveedor puede devolver sin validar: un `failed` del proveedor con ese código se reabre y se reenvía (línea 118) | INFERENCIA (latente) |
| F7 | MENOR | 3 | `decision: 'allow'` con `screened:false` se acepta (el contrato dice que nunca ocurre; no hay defensa en profundidad) | INFERENCIA |
| F8 | MENOR | 4 | `SvixApiError` distinto de 400/422 (p. ej. 404 de app, 413) en `publish` se propaga como transitorio: redelivery sin fin; el 409 «ya existe» cuenta como `noEndpoints` | INFERENCIA |

Sin hallazgos (con la evidencia de qué se probó): punto 1 en su pregunta central (`provenUnsent`), punto 5 (`createWithRetry`). Ver más abajo.

---

## Punto 1 — `provenUnsent` en `refunds.service.ts` (commit `e2c74a1`)

### Pregunta central: ¿puede `provenUnsent` ser `true` habiendo llegado una orden anterior al banco? — **No encontré camino. Sin hallazgo.**

Qué probé (todo por lectura, citando línea):

1. **Quién escribe `connector_refunds.status='failed'`.** `grep connector_refunds` en `services/pay-connectors/src`: solo `refunds.service.ts` toca la tabla (más `schema-map.ts`). Escritores de `failed`:
   - la rama «sin efecto» (`refunds.service.ts:163-167`), que fija `failure_code='connector_unavailable'` y deja `provider_reference` en NULL;
   - `settle()` (`:193-196`), invocado desde `send` con `error.code` de `ConnectorRejectedError` (`validation_failed | invalid_state_transition | internal_error`, `domain/connector.ts`; ninguno es `connector_unavailable`) o con `result.failureCode`/`observed.failureCode` del proveedor, **siempre junto a un `providerReference` string** (`mockbank-http.client.ts:80` exige `bank_reference` string; si falta lanza `ConnectorAmbiguousError`).
   - No hay otro servicio, callback, poller ni conciliación que escriba esa tabla (el poller y `apply.ts` operan sobre `connector_charges`).
   Por lo tanto `failed + connector_unavailable + provider_reference NULL` solo lo deja la rama «sin efecto».
2. **La rama «sin efecto» solo se alcanza con `ConnectorUnavailableError` y `!prior`** (`:159`). Qué produce `Unavailable`: `mockbank-http.client.ts` `NEVER_CONNECTED` (conexión jamás establecida), `503 bank_unavailable` con cuerpo exacto, `403` con problem body (compuerta previa a cualquier efecto) y `this.connector(code)` sin conector cargado (`provider-gateway.ts:34`). Todo lo demás (timeout, `ECONNRESET`, 5xx, 502/HTML, 404 sin cuerpo, 2xx ilegible) es `Timeout/Ambiguous` (`:166-175`, `classify`). El timeout deja la fila `pending` (`:171-173` solo lanza, no escribe).
3. **El reintento interno no puede esconder un ambiguo.** `callIdempotent` (`provider-gateway.ts:70-82`): tras un `Timeout` interno, un `Unavailable`/`Rejected` posterior se eleva a `ConnectorTimeoutError`. Así, un Unavailable que sale de `send` implica «ningún intento de esta llamada llegó».
4. **Secuencias entre envíos.** Estados de la fila y `prior = flagged && !provenUnsent`:
   - 1.º envío: `flagged=false` ⇒ `prior=false`; Unavailable ⇒ `failed/cu` (probado sin enviar). Correcto.
   - Reenvío desde `failed/cu/null`: `provenUnsent=true` ⇒ `prior=false`. Si ahora sale un `Timeout`, la fila queda `pending` (reabierta en `:136`, nunca vuelve a `failed`); el siguiente envío ve `pending` ⇒ `provenUnsent=false`, `flagged=true` ⇒ `prior=true` ⇒ todo Unavailable/Rejected es ambiguo (500). Correcto.
   - Caída entre reabrir (`:136`) y reclamar (`:141`): fila `pending` con flag ⇒ `prior=true`; conservador, nunca produce un falso «sin efecto». Cubierto por el test «el proceso cayó entre reabrir y reclamar».
   - El `UPDATE` de liberación exige `status='pending' AND provider_reference IS NULL AND send_claims = mine` (`:163-167`): si `status()` (`:100-103`) o un reclamo posterior tocó la fila, `rowCount=0` ⇒ 500 ambiguo.
5. **Carreras entre reintentos concurrentes.** `withSendLock` (`send-lock.ts`) serializa por `pg_try_advisory_lock(hashtext('send:'+id))` sostenido durante `work()`; el estado se relee dentro del candado (`:117`). Dos envíos no solapan. `provenUnsent` se calcula de la fila leída dentro del candado y la reapertura/reclamo ocurren bajo el mismo candado. `status()` no toma el candado pero solo actúa sobre `pending` con `FOR UPDATE` y `settle … WHERE status='pending'`.
6. **Doble ejecución.** No encontré camino. Defensa en profundidad: la referencia al proveedor es `cr_…` (idempotente por referencia) y el banco simulado la honra (`bank.refundStatus(...)` en los tests de `charges.spec.ts` «correcto» y «corrida %i»).

No cubierto (punto 1): no ejecuté los tests de `charges.spec.ts` (requieren PostgreSQL aislado, que no está levantado aquí). No verifiqué que el candado de sesión sobreviva a un corte de la conexión del `LOCK_POOL` a mitad de `work()` (si Postgres/pgbouncer cierra esa sesión, el candado se libera mientras `work()` sigue: dos envíos podrían solaparse; el límite lo pone la idempotencia por referencia del banco, no esta lógica). Lo anoto como riesgo residual, no como hallazgo.

### F4 — MENOR — reapertura de un `failed` contra el índice único `connector_refunds_refund_id_uidx` — INFERENCIA

- Archivo: `services/pay-connectors/src/core/refunds.service.ts:136`; índice en `services/pay-connectors/sql/ddl.sql:223` (`UNIQUE (pay_mode, refund_id) WHERE refund_id IS NOT NULL AND status <> 'failed'`).
- Escenario: cobro de 10000. Clave K1 con `refund_id=re_X`, 5000, proveedor caído ⇒ 502, fila `cr1` queda `failed` (sale del índice). Clave K2 con el mismo `re_X`, 5000 ⇒ el `INSERT` pasa (el índice excluye `failed`), `cr2` queda `succeeded`. Se reintenta K1: la revalidación de importe (`:132-135`: 5000 + 5000 ≤ 10000) pasa y el `UPDATE … SET status='pending'` (`:136`) intenta volver a meter `cr1` en el índice ⇒ `23505`. A diferencia del `INSERT` (`:56-60`), aquí no se captura `uniqueViolation`: sube un error de base sin mapear ⇒ 500 y la clave K1 no puede completarse jamás (cada reintento repite el mismo choque).
- Impacto: no mueve dinero de más (el índice lo impide), pero deja una clave en 500 permanente y una respuesta genérica. Mismo error `internal_error` que «ambiguo», lo que además es engañoso (no es ambiguo: es un conflicto definitivo).
- No lo ejecuté (sin PostgreSQL).

### F6 — MENOR (latente) — `connector_unavailable` como centinela y como código del proveedor — INFERENCIA

- Archivos: `refunds.service.ts:118` (la excepción «reintentable» se decide solo por `failure_code === 'connector_unavailable'`), `:102` y `:157` (guardan el `failureCode` que dice el proveedor, string libre de `body.failure_code`, `mockbank-http.client.ts:80`).
- Escenario: un conector (hoy ninguno lo hace; el banco simulado devuelve `validation_failed`) que responda un reembolso `failed` con `failure_code:'connector_unavailable'` y su `bank_reference` ⇒ la fila queda `failed/cu` **con** referencia. En el siguiente envío la línea 118 no la da por resuelta (porque el código coincide con el centinela), la reabre (`:136`) y vuelve a ordenarla. `provenUnsent` es `false` (hay referencia), así que `prior=true` y no se afirma «sin efecto»: no hay riesgo de falso 502, pero un fallo declarado definitivo por el proveedor deja de ser terminal y se reenvía y se vuelve a publicar `refund:<id>:failed`. El test «inválido: CON referencia del proveedor» cubre solo el estado forjado a mano, no este camino.
- Impacto: bajo hoy (latente); crece cuando exista un conector real.

---

## Punto 2 — breaker del cliente de riesgo (`cef55ca`: `http.ts:65`, `deps.ts:34`)

### Qué se pierde

- Un timeout ya no cuenta ni reinicia nada (`http.ts:65`). Un `pay-risk` que solo agota tiempo (lento o colgado) nunca abre el breaker.
- Cada llamada de cobro sigue pagando `2 × RISK_TIMEOUT_MS (300) + 50 ms` por intento de actividad, por hasta `ACTIVITY_MAX_ATTEMPTS=6` intentos, sin tope de concurrencia ni apertura. Con `maxConcurrentActivityTaskExecutions` por defecto del SDK (`worker.ts` no lo fija), esas llamadas ocupan ranuras del mismo worker que ejecuta `recordLedger`/`inquireCharge` (actividades de dinero ya cobrado). Es degradación de latencia, no de corrección: por eso MENOR. INFERENCIA.

### F3 — MENOR — el semiabierto queda pegado — CONFIRMADO

Reproductor (`halfopen.cjs`, contra `dist/clients/http.js`, reloj inyectado):

```
tras 2x 5xx: open
pasado el reset: half_open
sonda: timeout
tras timeout de la sonda: half_open
concurrentes durante la sonda: [ 'circuit_open', 'circuit_open', 'circuit_open' ]
```

- Qué pasa: si el breaker se abrió por 5xx/red y luego `pay-risk` se vuelve lento, la sonda del semiabierto vence por timeout, no se cuenta (`:65`), `openedAt` no se renueva y `state` sigue `half_open`. Desde entonces **una** llamada a la vez es sonda (cada una vence a los 300 ms) y las demás reciben `circuit_open` al instante, sin llegar a riesgo.
- Efecto: esas llamadas gastan intentos de la actividad (backoff 0,5 a 5 s) sin haber consultado a riesgo; con un riesgo lento más de ~12 s, intentos agotados ⇒ `failed/risk_unavailable`. Es fail-closed (no hay cobro), pero es justo el patrón que `cef55ca` quería evitar («las actividades gastan sus reintentos contra `circuit_open`»), reaparece por el camino 5xx ⇒ semiabierto. El test `risk-breaker.timeouts.spec.ts` no cubre la transición `open → half_open → timeout`.

### Fail-closed en todos los caminos (pregunta explícita) — ver F1

Con la configuración por defecto (`RISK_ALLOW_BELOW_THRESHOLD` apagada, umbral 0) **todos** los caminos de error cierran (`activities.ts:221-226`: `failClosed = amount >= umbral || !flag` ⇒ siempre verdadero). El único camino que devuelve `proceed:true` sin decisión de riesgo es la franquicia, y solo con el flag encendido y `amount < umbral`. `live-guard.ts` no prohíbe el flag en `live`. Ver F1.

---

## Punto 3 — `assessRisk` / `isRiskInFlight` (`activities.ts:30-34, 180-232`)

Combinaciones revisadas:

| Combinación | Resultado | Veredicto |
|---|---|---|
| 409 `idempotency_request_in_progress` | `isRiskInFlight` ⇒ reintento misma clave; agotado ⇒ `failed/risk_unavailable` con constancia | correcto |
| 409 con otro código / cualquier 4xx con `code` | `UpstreamRejection` ⇒ `integrationError` ⇒ fail-closed con constancia | correcto |
| `201 review/screened:false` con razón no definitiva | `RiskScreeningUnavailable` ⇒ en vuelo ⇒ reintento; agotado ⇒ cierra | correcto (si la razón es de negocio distinta de las 3 definitivas, cierra como `risk_unavailable` y no como `risk_denied`: fail-closed igual) |
| `deny`/`review` válidos | `risk_denied` | correcto |
| `allow` | `proceed:true` | ver F7 |
| Timeout puro, intentos 1..max | reintento; agotado ⇒ cierra | correcto |
| Cobro doble | `createCharge` es idempotente por `intent.chargeId` y por clave `${intent}:charge`; no encontré combinación que cree dos cargos | sin hallazgo |

### F1 — MAYOR (condicional) — la franquicia deja pasar con una evaluación viva — masking CONFIRMADO, resto INFERENCIA

- Archivos: `services/pay-payments/src/clients/http.ts:117-132` (el bucle conserva solo el ÚLTIMO error: `last = error`), `services/pay-payments/src/temporal/activities.ts:206-226`, comentario en `:204-205` («5xx, red, breaker abierto: ahí no hay ninguna evaluación en vuelo»).
- Escenario A (CONFIRMADO el enmascaramiento): `RISK_ALLOW_BELOW_THRESHOLD=true`, umbral 1.000.000, cobro de 10.000, intento 1 de la actividad. Primera llamada HTTP a `pay-risk`: llega, la evaluación queda viva, el cliente vence (timeout). `HttpClient` reintenta tras 50 ms (misma clave) y recibe un 503 (o `circuit_open` si el breaker se abrió entretanto por otras llamadas). `request()` lanza el último error, no el timeout. Reproductor `masking.cjs`:
  ```
  error visto por assessRisk: UpstreamError server_error 503 | llamadas que llegaron al servidor: 2
  ```
  En `assessRisk`, `attempt === 1` ⇒ `earlierAttemptSent=false` (`:209`), `isRiskInFlight(error)` es falso (kind `server_error`) ⇒ cae en la franquicia (`:221-228`) ⇒ `proceed:true` ⇒ cobro sin decisión de riesgo, mientras la primera evaluación sigue viva y puede quedar `deny`. El test `ola3.risk-inflight.spec.ts:228` («un timeout y DESPUÉS un 5xx») usa `hangFirst: 2`, es decir cuelga las DOS llamadas HTTP del intento 1 y recién el 5xx llega en el intento 2 (donde sí rige `earlierAttemptSent`); el caso «timeout y 5xx dentro del MISMO intento» no está cubierto.
- Escenario B (INFERENCIA, contradice regla 11): un 5xx sin cuerpo del contrato no prueba que `pay-risk` no evaluó (se cae tras escribir el `deny` y antes de responder). El código lo clasifica «no hay evaluación» (`:204`). Idéntico para `unexpected_response` (`http.ts:163,168`): un 2xx con cuerpo ilegible o un 4xx sin `code` (p. ej. 401/403/404 de un proxy o de service-auth mal configurados) cae en la franquicia (kind `unexpected_response` ⇒ `isUpstreamError`) y, con el flag encendido, deja pasar todo el tráfico bajo el umbral de forma indefinida sin ninguna constancia.
- Escenario C (INFERENCIA): `attempt` (`Context.current().info.attempt`) vuelve a 1 en una ejecución nueva de la actividad (otra ronda de `untilResolved`, o una nueva ejecución del workflow para el mismo intento). Una evaluación enviada por la ejecución anterior queda sin protección: error de red en el intento 1 de la ronda nueva ⇒ franquicia.
- Impacto: dinero. Un cobro que riesgo decidió denegar (sanciones) puede ejecutarse. Acotado por: flag apagado por defecto, monto bajo el umbral, `deny` solo si riesgo llegó a decidir.
- Qué no está roto: con el flag apagado (por defecto) el mismo camino cierra `failed/risk_unavailable` (`:222-224`).

### F7 — MENOR — `allow` con `screened:false` — INFERENCIA

- `activities.ts:195`: `isScreeningUnavailable` solo mira `review`; un `allow` con `screened:false` (el contrato `internal-risk-v1.yaml` dice que no existe, líneas 27, 73, 215) pasa. Si `pay-risk` tuviera un defecto, se cobra sin cribado. Defensa en profundidad ausente; la invariante de `evaluate()` (`pay-risk/src/rules/engine.ts:61-67`) la sostiene hoy.

---

## Punto 4 — `SvixEngine` y reconciliador (`engine/svix/*`)

### Lo que está bien (probado por lectura)

- **Idempotencia por `eventId`.** `publish`: 202 ⇒ `created`; 409 ⇒ `getMessage(app, eventId)`; si el mensaje está y su `eventId` coincide ⇒ 0 entregas nuevas; si no está ⇒ `EngineRejectedError('event_id_conflict')` (`svix-engine.ts:136-142`). Un timeout/5xx/429 se reintenta con el mismo `eventId` (`svix-client.ts:236-262`), y si se agota sube y NATS reentrega. La publicación ocurre dentro de `processOnce` (`event-ingest.ts:80-82`): si el commit del inbox falla tras crear el mensaje, la redelivery recibe 409 ⇒ éxito. Sin duplicados posibles por esa vía.
- **Secretos y tokens en logs.** `SvixApiError`/`SvixUnavailableError` solo llevan estado y un código normalizado (`errorCode`, regex `^[a-z_]{1,64}$`); nadie loguea cuerpos ni cabeceras; el token no aparece en errores; `redirect:'error'`; el reconciliador y `publish` loguean ids y tipos, no URL, payload ni claves. La clave se genera acá, se manda a Svix y se sella con KEK para el replay (`endpoint.service.ts:102,120`); no se guarda en claro.
- **Alta ambigua.** `provisionEndpoint` resuelve el 409 comparando la clave releída con la generada (`svix-engine.ts:87-88`); válido para `v1` y `v1a` (la pública).
- **Rotación ambigua.** `rotateSecret` con `attempts:1` y verificación de estado antes de repetir (`:96-113`); no empuja la misma clave dos veces.
- **SSRF/URL.** `TargetGuard` (https, sin credenciales, puerto 443, nombre no interno, todas las IP públicas, WHATWG normaliza las formas numéricas) se aplica en el alta (`endpoint.service.ts:93`). La URL que se manda a Svix es la original; el control de entrega pasa a Svix (documentado en `docs/trabajo/ola-5/P1/INFORME.md` §4: lo probaron para 4 destinos privados; **DNS rebinding sin probar**, propuesta #5 abierta). No añado hallazgo nuevo; confirmo que la brecha sigue abierta y que `platform/compose.yml:142` usa `SVIX_JWT_SECRET: dev-only-change-me` (solo perfil `full`, dev).

### F2 — MAYOR (condicional) — borrado de «huérfanos» sin espacio de nombres ni freno — INFERENCIA

- Archivo: `services/pay-webhooks/src/engine/svix/svix-reconciler.ts:147-162`; app de Svix = `merchantId` sin prefijo de entorno/modo (`svix-engine.ts:75`); `WEBHOOKS_SVIX_URL` no contiene entorno.
- Escenario 1 (restauración): se restaura la base de `pay-webhooks` desde un backup/PITR anterior. Los endpoints creados después del punto de restauración (con su secreto ya entregado al comercio) siguen en Svix, pero la tabla no los conoce. Para todo comercio que conserve al menos un endpoint en la base restaurada, el reconciliador los clasifica huérfanos (`we_…`, sin fila, `createdAt` > gracia) y los borra de Svix en el ciclo siguiente (cada 15 s). El comercio pierde la entrega sin aviso, y el endpoint no se recrea («no se recrea», `:119`).
- Escenario 2 (Svix compartido): dos despliegues (sandbox y live, o staging y producción) apuntados al mismo servidor Svix comparten la aplicación `mc_…` del mismo comercio; cada reconciliador ve como huérfanos los endpoints del otro y los borra tras 10 minutos. Nada en `config.ts` (`parseSvix`) lo impide ni lo detecta.
- Falta un freno proporcional (tope de borrados por pasada o relación huérfanos/total que detenga y alerte) y un prefijo/etiqueta de propietario en el `uid` o en los metadatos del endpoint. Borrar es irreversible (el secreto del comercio se perdió con el endpoint).

### F5 — MENOR — la gracia compara relojes y el alta puede durar más — INFERENCIA

- `svix-reconciler.ts:150`: `now() - Date.parse(svix.createdAt) < orphanGraceMs` mezcla el reloj de este servicio con el de Svix (no se aplica `clockMarginMs` como en los intentos). `config.ts:149` permite `WEBHOOKS_SVIX_ORPHAN_GRACE_MINUTES` desde 1; el alta mantiene abierta una transacción mientras hace hasta `WEBHOOKS_SVIX_MAX_ATTEMPTS` (hasta 10) × `WEBHOOKS_SVIX_TIMEOUT_MS` (hasta 30 s) por llamada, más `ensureEventTypes` por cada tipo público (`svix-engine.ts:146-153`). Con valores no por defecto el endpoint ya puede tener más edad que la gracia cuando se confirma la fila; el reconciliador lo borra (la comprobación `still` ve la fila solo si ya hizo commit) y queda un endpoint local sin contraparte. Con los valores por defecto (10 min, 4 intentos, 5 s) la ventana real es de segundos: no es explotable así.
- Relacionado: un alta que falla DESPUÉS de crear el endpoint en Svix (respuesta perdida, rollback) deja un endpoint vivo, suscrito, con un secreto que el comercio nunca recibió; entrega eventos firmados con una clave desconocida hasta el barrido (hasta 10 min). No hay borrado compensatorio en `provisionEndpoint`. Impacto: entregas duplicadas inutilizables, no pérdida de dinero.

### F8 — MENOR — errores definitivos tratados como transitorios en `publish` — INFERENCIA

- `svix-engine.ts:129-135` solo traduce 400/422 a rechazo definitivo. Un 404 (la aplicación del comercio no existe en Svix, caso que el reconciliador solo registra), un 413 (payload grande) o un 401 propagan `SvixApiError` ⇒ el consumidor lo trata como transitorio ⇒ redelivery sin fin del mismo evento. Además, el 409 «ya existe» devuelve 0 y `event-ingest.ts:96` lo cuenta como `noEndpoints` (métrica engañosa).

### Observación sobre la ventana de 410

- `svix-reconciler.ts:130`: lee los últimos 100 intentos 4xx; con el `since` fijo por errores persistentes de otro comercio (la marca solo avanza en pasada sin errores, `:100`) la ventana crece y un 410 anterior a los 100 más nuevos 4xx queda fuera; si Svix lo deshabilitó, se registra como `too_many_failures` y no `gone_410`. Efecto limitado (el endpoint queda deshabilitado de todos modos). No lo clasifico como hallazgo de dinero.

No cubierto (punto 4): no corrí `test/svix/*` (necesitan svix-server y Postgres reales), no verifiqué contra Svix real la forma de `expect` de cada operación (p. ej. el estado de `rotate`), y no intenté un rebinding de DNS.

---

## Punto 5 — `createWithRetry` en `e2e/lib/sandbox-seed.ts:257-276` — sin hallazgo

Qué probé:

1. La afirmación del comentario se verifica en `contracts/packages/idempotency/src/index.ts:14-20`: todo `ProblemError` con estado < 500 se guarda y se repite 24 h; un 5xx libera la clave. Por eso un 422 con la misma clave repite el 422.
2. La clave derivada `K~r<attempt>` solo se estrena tras un 422 (`:273`), nunca tras 401/404/409/5xx (esas se reintentan con la misma clave y la misma derivada). Una clave derivada que devolvió un resultado ambiguo se sigue usando hasta obtener respuesta, de modo que no hay creación doble por cambio de clave en un ambiguo.
3. Un 422 tras un ambiguo previo: la reanudación bajo la misma clave devuelve la respuesta guardada o continúa desde el punto de recuperación; un 422 nuevo solo puede ser validación determinista (que ocurre antes de crear). El único camino a un duplicado sería un servidor que rechace con 422 por «ya existe» y a la vez acepte una clave nueva; `findMandate` por descripción (`:237`) se ejecuta antes de crear, y la creación está acotada por `timeoutMs`.
4. Menores sin impacto de dinero: `res.json.id` no se valida en el 200/201 (`:269`) y un 422 permanente consume los 45 s antes de fallar.

No cubierto: no ejecuté `e2e/` (necesita el stack completo).

---

## Qué quedó sin ejercitar (consolidado)

- Ninguna suite ni E2E se ejecutó (sin PostgreSQL, Temporal, NATS ni Svix en esta máquina). Los dos únicos reproductores ejecutados fueron scripts de Node de un solo archivo contra `services/pay-payments/dist/clients/{http,risk.client}.js` (su lógica coincide con `src/` en las líneas citadas). `dist/` podría estar desfasado respecto a `src/`; revisé `src/` por lectura para las mismas rutas.
- F1 (escenarios B y C), F2, F4, F5, F6, F7, F8: inferencias. Cada una tiene un reproductor propuesto en su descripción; F4 se reproduce con tres peticiones HTTP contra `pay-connectors` real; F2 con una base restaurada y `SvixReconciler.runOnce()`.

## Recomendación de prioridad

1. F1: distinguir en `HttpClient` (o en `RiskClient.assess`) que hubo un intento previo ambiguo (p. ej. propagar `ambiguous=true` o conservar el primer timeout) y clasificar 5xx y `unexpected_response` como ambiguos para la franquicia; añadir el test «timeout y 5xx en el MISMO intento».
2. F2: prefijo/etiqueta de propietario en los `uid` (o metadatos) y tope de borrados por pasada con alarma.
3. F3, F4: acotados y sin pérdida de dinero.
