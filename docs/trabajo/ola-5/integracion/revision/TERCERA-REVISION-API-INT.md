# Tercera revisión adversarial — carril INT en `mantra-core-health-api` (reserva de despacho, N1–N7)

- Revisor: distinto del revisor original, del re-revisor y del implementador. SOLO LECTURA sobre `/home/user/mantra-core-health-api` (rama `claude/adoring-allen-ly7r6f`, HEAD `97eaa006c`): no edité ni commiteé nada. Todo lo que ejecuté corrió en un `git worktree` aparte (ya borrado, `git worktree prune` hecho) con `flock /tmp/pay-heavy.lock`. Bases y roles `mantra_it_rev3*` creados por mis arneses: ya no existen (verificado contra `pg_database` y `pg_roles`: 0 y 0).
- Referencias previas: [RE-REVISION-API-INT.md](./RE-REVISION-API-INT.md) (N1…N8) y `git show 97eaa006c`.
- Cada hallazgo dice si lo **CONFIRMÉ ejecutando** o es **INFERENCIA** (lectura).
- Evidencia: [`TERCERA-REVISION-API-INT.evidencia/`](./TERCERA-REVISION-API-INT.evidencia/) (`rev3-charge.int-spec.ts`, `rev3-b1-rls.int-spec.ts`, `n1.mts` y las tres salidas). Nota sobre `salida-run1-primera-corrida.txt`: tiene 2 fallos que son defectos de MI arnés (un `Set` de claves que acumulaba llamadas entre modos, y un control de pool ejecutado con el rol restringido sin tenant ⇒ 404); ambos se corrigieron y repitieron en `salida-run2-…` (105/105 en verde en 3 suites, incluido el int-spec existente del carril).

## Conclusión

**La reserva `dispatching:<uuid>` funciona como se diseñó** y no logré romper el invariante central: con la marca, N despachos simultáneos sobre la misma deuda producen UN solo cobro en ambos modos (`RLS_ENFORCE=false` y `true` con rol `NOBYPASSRLS`), la propia intención retoma con la misma clave tras un 504, N1/N3/N5/N6/N7 están cerrados, la marca nunca se trata como un `pi_…` real en ningún camino, y no hay restos de mutaciones ni specs debilitados.

**Pero encontré un defecto BLOQUEANTE para encender el flag con `RLS_ENFORCE=true` y dos MENOR con consecuencia de dinero:**

1. **P1 (BLOQUEANTE si `RLS_ENFORCE=true`; no afecta con `false`) — interbloqueo por espera circular de conexiones del pool.** `runCommitted` (`services/payments-committed-transaction.ts:33`) abre `em.fork().transactional(...)`, que toma una SEGUNDA conexión mientras la transacción del `TenantContextInterceptor` retiene la primera durante toda la petición. Con N cobros simultáneos y pool de N conexiones, todos retienen una y esperan otra: ninguno avanza. Y la app no fija `connectionTimeoutMillis` (`src/orm/config/orm.config.ts:99,109`; `pg` espera sin límite por defecto), así que en producción **se cuelga todo acceso a la base**, no solo el cobro. CONFIRMADO ejecutando (tabla abajo). Con el pool por defecto (`DB_POOL_MAX=10`), 10 cobros simultáneos congelan la API.
2. **P2 (MENOR, consecuencia: doble cobro) — la liberación de la reserva borra la marca de OTRA petición de la misma intención.** Doble clic sobre la misma intención + un rechazo definitivo/429 agotado en una de las dos peticiones: `releaseReservation` borra la marca que escribió la otra petición, que sigue en vuelo; otra intención de la deuda pasa la compuerta y se crean dos cobros vivos con sus dos QR entregados. CONFIRMADO ejecutando. Arreglo de una línea (borrar solo si la marca sigue siendo la que escribió esta petición).
3. **P3 (MENOR) — "rechazo definitivo" es cualquier 4xx.** `classify` (`gateway/payments-gateway.client.ts:240`) trata todo 4xx distinto de 429/409-en-curso como definitivo y la reserva se libera, sin exigir el cuerpo de error del contrato. La regla 11 de la pasarela dice que un 404/502 sin el cuerpo exacto no prueba que no se ejecutó, y la doc de la API dice «4xx del contrato». CONFIRMADO ejecutando (404/400/408/413/499 ⇒ reserva liberada).

### ¿Se puede marcar INT.M3 HECHO?

**No todavía para "encender el flag".** Con el flag APAGADO (default) no encontré regresión: el código nuevo es inalcanzable salvo N1 (verificado lineal) y el 409 `PAYMENT_INTENT_VIA_GATEWAY` para intenciones que ya tengan referencia. Con el flag ENCENDIDO:
- `RLS_ENFORCE=false`: no hay hallazgo bloqueante; P2 y P3 son MENOR y se pueden cerrar o aceptar por escrito.
- `RLS_ENFORCE=true`: P1 bloquea. Hasta resolverlo, la afirmación honesta es `TESTED` para el camino con RLS y `VERIFIED` solo con `RLS_ENFORCE=false`.

Condiciones mínimas para encender el flag (en orden):
1. Cerrar P1: o (a) que la compuerta/asociación/liberación no abran una segunda conexión con RLS (usar la transacción de la petición cuando el bloqueo no importa, o sacar el cobro del interceptor), o (b) como mínimo `connectionTimeoutMillis` en `driverOptions` + un tope de concurrencia de cobros estrictamente menor que `DB_POOL_MAX` menos el tráfico concurrente. Repetir mi arnés (`(3/POOL)`) y que el caso K=pool pase.
2. Cerrar P2 (comparar la marca antes de borrar) y P3 (liberar solo ante problema RFC 9457 del contrato; el resto, conservar).
3. Alerta operativa sobre el log `payments.gateway.debt-gate` (marcas vencidas) y sobre los terminales 404 del receptor (ver P5): hoy nadie los consume.
4. Verificar con el front el contrato de `sourceRefType` (ver P8).
5. Runbook para marcas colgadas si se apaga el flag (ver P6).

## Resumen por severidad

| Sev. | # | Hallazgo | Prueba |
|---|---|---|---|
| **BLOQUEANTE** (solo con `RLS_ENFORCE=true`) | P1 | Espera circular de conexiones: el interceptor retiene la 1ª y `runCommitted` pide la 2ª; K cobros simultáneos con pool K ⇒ todos fallan/se cuelgan; la app no tiene timeout de adquisición | CONFIRMADO ejecutando |
| MENOR (dinero) | P2 | `releaseReservation` borra la marca de otra petición en vuelo de la misma intención ⇒ otra intención despacha ⇒ 2 cobros vivos | CONFIRMADO ejecutando |
| MENOR | P3 | Cualquier 4xx libera la reserva (404/408/413/499…), contra la regla 11 y contra la doc | CONFIRMADO ejecutando (+ lectura) |
| MENOR | P4 | Expiración de la marca: segura para el pagador en el caso normal (el QR del cobro de A nunca se entregó), pero deja un cobro huérfano e irreintentable (409) y solo es insegura si la llamada de A queda detenida > 15 min | Normal CONFIRMADO; stall CONFIRMADO ejecutando con la marca envejecida a mano |
| MENOR (preexistente) | P5 | Cobro huérfano de un 504 que sí se ejecutó: su webhook terminal responde 404 y la pasarela lo reintenta hasta contarlo como entrega muerta (puede deshabilitar el endpoint si son consecutivas) | INFERENCIA (lectura de `delivery.worker.ts:176-178` y del receptor) |
| MENOR | P6 | Una intención con marca queda sin salida por API: DECLINE/fx-lock/splits y el camino viejo (flag apagado) responden 409 «ya tiene un cobro en la pasarela» aunque nunca se haya creado nada | CONFIRMADO ejecutando |
| MENOR | P7 | Doc/README desactualizados: «4xx del contrato», y «el pool se puede agotar» subestima P1 (es una espera circular con latencia cero) | Lectura |
| MENOR | P8 | La compuerta N3 falla cerrado para CUALQUIER `sourceRefType` que no sea `payment_debt` ni `EDUCATION_COURSE` (lista fija): un pago legítimo de otro origen recibe 422 | INFERENCIA (lectura) |
| MENOR | P9 | El reintento con marca vuelve a evaluar el riesgo: un `REVIEW` posterior al 504 impide recuperar un cobro que sí existe | INFERENCIA (lectura) |

Cerrados y verificados en esta ronda: **N1, N2, N3, N4, N5, N6, N7** (detalle abajo; N2/N4 con las salvedades P2/P4).

---

## P1 — BLOQUEANTE con `RLS_ENFORCE=true`: espera circular de conexiones

- **Dónde:** `src/modules/payments/services/payments-committed-transaction.ts:33` (`em.fork().transactional`), llamado desde `payments-transactions.service.ts:390` (compuerta+reserva), `payments-gateway-charge.service.ts:361` (`associate`) y `:412` (`releaseReservation`). La transacción envolvente es la de `src/common/tenant/tenant-context.interceptor.ts` (`this.em.transactional(...)` cuando `RLS_ENFORCE==='true'`).
- **Mecanismo:** cada petición de cobro ya tiene una conexión tomada por el interceptor ANTES de entrar al servicio, y el servicio pide otra. Es un "hold-and-wait" clásico: no depende de la lentitud de la pasarela.
- **CONFIRMADO ejecutando** (`rev3-charge.int-spec.ts`, rol `NOSUPERUSER NOBYPASSRLS` con la política real de `2026-08-05_tenant_rls.sql`, pasarela con latencia 0, `connectionTimeoutMillis` 6 s solo para poder acotar la prueba; `salida-run2-charge-y-existentes.txt`):

```text
POOL pool=4,  3 peticiones RLS simultaneas (K<pool):  {"ok":3} en 105ms
POOL pool=4,  4 peticiones RLS simultaneas (K=pool):  {"eError:timeout exceeded when trying to connect":4} en 6005ms
POOL pool=4,  8 peticiones RLS simultaneas (K>pool):  {"ok":1,"eError:timeout ...":7} en 6045ms
POOL pool=10 (DB_POOL_MAX por defecto), 9 peticiones RLS:  {"ok":9} en 214ms
POOL pool=10 (DB_POOL_MAX por defecto), 10 peticiones RLS: {"eError:timeout ...":10} en 6008ms
POOL control pool=4 superusuario SIN transaccion de peticion (RLS_ENFORCE=false), 8 simultaneas: {"ok":8} en 137ms
```
- **Agravante:** `src/orm/config/orm.config.ts:99,109` no fija `connectionTimeoutMillis` y `pg.Pool` espera sin límite por defecto (leído en `node_modules/@mikro-orm/postgresql/PostgreSqlConnection.js`: solo mapea `max` e `idleTimeoutMillis`). En producción no hay "timeout exceeded": hay una API colgada.
- **Con pasarela lenta es peor** (INFERENCIA razonada): cada cobro retiene su conexión "idle in transaction" hasta ~30–40 s y al volver necesita una segunda para `associate`. El umbral deja de ser "K = pool" y pasa a "cobros en vuelo + otro tráfico ≥ pool".
- **Por qué el implementador no lo vio:** sus pruebas `MODES` usan `pool: { max: 20 }` y 2–3 peticiones. La doc (`docs/modules/payments.md`, «Conexión durante la llamada») dice que «el pool se puede agotar con muchas llamadas lentas»; la realidad es que se agota con tantas llamadas como conexiones, sin importar la latencia.
- **Cómo se cierra:** (a) con RLS activo no abrir una segunda conexión: ejecutar compuerta/asociación/liberación en la transacción de la petición y confirmar la marca de otra forma (p. ej. el interceptor no debería envolver este handler: `@TenantAgnostic`-like con contexto explícito, o `runCommitted` que reutilice la conexión y haga `COMMIT` parcial no es posible: hay que sacar la llamada HTTP de la transacción del interceptor); o (b) mitigación mínima: `connectionTimeoutMillis` global + semáforo de concurrencia para `processViaGateway` con tope `< DB_POOL_MAX`.
- **No cubierto:** no levanté `AppModule` ni el interceptor real: lo simulé con `em.transactional` + los mismos `set_config` (igual que la re-revisión). La estructura "una transacción de petición + `fork()`" es la misma; confirmar con una prueba HTTP contra el `AppModule` real antes de cerrar.

## P2 — MENOR (dinero): la liberación borra la marca de otra petición de la misma intención

- **Dónde:** `payments-gateway-charge.service.ts:412-433` (`releaseReservation`: borra cualquier marca vigente de la fila, no la que escribió esta petición) y `:314` (la llamamos ante cualquier `PaymentsGatewayError` no ambiguo).
- **Escenario (CONFIRMADO ejecutando, `SAME-INTENT-RACE`):** la intención A recibe dos `POST …/transactions` casi simultáneos (doble clic). R1 y R2 pasan la compuerta (R2 sobreescribe la marca con una nueva). R1 recibe 429 agotado (503 al cliente) y libera; R2 sigue en vuelo. Con la marca en `NULL`, la intención B de la misma deuda pasa la compuerta y despacha. R2 termina bien.

```text
SAME-INTENT-RACE: ref de A durante la ventana=null; B=ok; A1/A2=e503,ok; cobros vivos=2; posts=5
```
- **Probabilidad:** baja (doble envío + resultados asimétricos de la pasarela para dos peticiones idénticas + una tercera intención sobre la deuda dentro de la latencia HTTP). **Consecuencia:** dos cobros vivos con QR entregado a dos personas.
- **Arreglo:** `reserveDispatch` devuelve/guarda la marca escrita y `releaseReservation` solo la borra si `row.gatewayIntentRef === esaMarca` (compare-and-clear). Añadir un test con dos peticiones de la misma intención.

## P3 — MENOR: todo 4xx libera la reserva

- **Dónde:** `gateway/payments-gateway.client.ts:240-246` (todo 4xx que no sea 429 ni 409-en-curso ⇒ `rejected`, `retryable=false`) + `payments-gateway-charge.service.ts:314`.
- **CONFIRMADO ejecutando** (`4xx` en `salida-run2-…`): con respuesta 404, 400, 408, 413 y 499 a la creación, la reserva queda en `NULL` (el 404 además se traduce a 503). `parseProblem` ni siquiera se consulta para decidir.
- **Por qué importa:** `CLAUDE.md` de la pasarela, regla 11: «un 404/502 sin el cuerpo de error exacto del contrato no prueba que no se ejecutó… Solo es definitivo lo que el contrato declara definitivo». Un 408/499/404 de un proxy intermedio no prueba nada, y liberar la marca reabre la ventana de N2/N4 justo en el caso ambiguo. La doc de la API (`docs/modules/payments.md`) afirma «`4xx` del contrato», que es más estricto que el código.
- **Arreglo:** liberar solo si `parseProblem(body)` produjo un `code` del contrato (400/401/403/422 con problema RFC 9457) y 429; cualquier otro 4xx, conservar.
- **Limitación de mi prueba:** el doble siempre devuelve un cuerpo `problem` (con `code` vacío); no modela un proxy sin cuerpo. El hallazgo se apoya en que el código no inspecciona el cuerpo.

## P4 — MENOR: expiración de la marca (evaluación pedida)

Ejecuté tres escenarios envejeciendo `updated_at` de la marca con SQL (la expiración se decide por esa columna):

- **EXP-a (CONFIRMADO):** A recibe 504 y el cobro SÍ existe en la pasarela; la marca de A vence; B despacha. Resultado: 2 cobros en la pasarela. El reintento legítimo de A (misma clave) responde `409 PAYMENT_GATEWAY_DEBT_HAS_OPEN_CHARGE`; la fila de A queda con la marca vencida (no se borra), la de B con su `pi_…`.
- **EXP-b (CONFIRMADO):** marca vencida y nadie más despacha: el reintento de A pasa la compuerta, re-reserva y recibe el MISMO cobro (`replayed`, 1 cobro creado).
- **EXP-c (CONFIRMADO, caso artificial):** la llamada de A sigue en vuelo cuando su marca vence y B despacha. `associate` (`:361-401`) no mira la edad de la marca: A se asocia igual ⇒ dos `pi_…` asociados, ambos con QR devuelto. Requiere que una llamada quede detenida > 15 min (el cliente corta cada intento a `timeoutMs` y `maxAttempts` = 3, ~40 s en total): solo un proceso congelado (SIGSTOP, pausa de VM) lo produce.

**Evaluación del riesgo de doble cobro real:** en el caso normal (EXP-a) la expiración es **segura para el pagador**: el QR/redirección de un cobro solo viaja en la respuesta de la creación; tras un 504 nadie lo tiene, y el reintento que lo expondría queda bloqueado por B. El costo es un **cobro huérfano** en la pasarela que expira solo y un reintento de A inútil (P5). No es seguro (dos QR en circulación) solo en EXP-c. La expiración es razonable **si** hay alerta sobre el log `Ignoring expired dispatch reservations…` (`payments-transactions.service.ts` ~`:575`) y un procedimiento para el huérfano; hoy no hay consumidor.

## P5 — MENOR (preexistente, ahora más visible): huérfano ⇒ webhook terminal 404

- Un cobro creado en un 504 que nunca se asocia (A bloqueada por B, o A abandonada) termina en `expired`/`canceled` en la pasarela. El receptor responde `404` a un terminal de un `pi_…` que ninguna fila tiene (`payments-gateway-webhook.service.ts:~326-336`; la marca no se puede resolver por diseño: el webhook trae el `pi_…`, no el id local). La pasarela reintenta y, agotados los reintentos, cuenta una entrega muerta (`pay-webhooks/src/engine/delivery.worker.ts:176-178`); `too_many_failures` deshabilita el endpoint tras N consecutivas (un éxito entre medio reinicia el contador, línea `:173`). INFERENCIA. Es el mismo m3 del primer informe; la reserva no lo empeora pero tampoco lo resuelve.

## P6 — MENOR: marca sin salida por API

- **CONFIRMADO ejecutando** (`MARK…`): tras un 504 sin ejecución real (`drop_before`), la intención con marca responde `409 PAYMENT_INTENT_VIA_GATEWAY` a `assessRisk DECLINE` y a `processTransaction` con el flag APAGADO («ya tiene un cobro en la pasarela»), y no hay endpoint para liberarla. Con el flag encendido la salida es reintentar; si se apaga el flag (rollback), esas intenciones quedan inprocesables por el camino viejo hasta una corrección de datos (prohibida a mano, regla 97.1.5). No es regresión con el flag apagado desde cero, pero sí una trampa de rollback. Documentar en el runbook o permitir que `assertNotDispatched` y la guarda del camino viejo distingan marca de `pi_…` (`payments-intents.service.ts:422`, `payments-transactions.service.ts:146`).

## P7 — MENOR: documentación

`docs/modules/payments.md` y `src/modules/payments/README.md`: «(`4xx` del contrato, `429` agotado) la libera» (ver P3), y «con muchas llamadas lentas simultáneas el pool se puede agotar» (ver P1: basta K = pool, sin lentitud).

## P8 — MENOR: lista fija de orígenes ajenos a deudas

`payments.source-refs.ts:187` (`NON_DEBT_SOURCE_REF_TYPES = ['EDUCATION_COURSE']`): cualquier otro `sourceRefType` (p. ej. una factura o una cita) sin sesión de checkout recibe `422 PAYMENT_GATEWAY_DEBT_UNRESOLVED` con el flag encendido. Es fail-closed a propósito, pero es un cambio de contrato para quien cobra otros orígenes; el front actual no envía `sourceRefType` de pagos (grep sin resultados en `mantra-core-health/src`), así que hay que acordar el catálogo antes de encender. INFERENCIA.

## P9 — MENOR: el reintento con marca re-evalúa el riesgo

`payments-transactions.service.ts:432` (`assertRiskCleared(tx, intentId, true)`) corre en el reintento con marca (solo un `pi_…` real sale antes de las compuertas). Si tras el 504 se registra un `REVIEW`, el reintento responde 422 aunque el cobro exista. `DECLINE` queda bloqueado por `assertNotDispatched`, pero `REVIEW` no. INFERENCIA.

---

## Lo que intenté romper y resistió

### (1) La marca nunca es un `pi_…`

| Camino | Resultado |
|---|---|
| `consult` / `GET /payment_intents/{id}` | Solo se llama con `gatewayIntentRef && !isDispatchMark(...)` (`payments-transactions.service.ts:445`). Con marca ⇒ `dispatch`. Ejecutado: tras el 504, el reintento hace `POST` (nunca `GET`) con la MISMA `Idempotency-Key` (ambos modos) y queda un solo cobro. Además `getPaymentIntent` valida `^pi_…` y rechazaría una marca |
| `associate` | Reemplaza la marca por el `pi_…` y sigue negándose a pisar un `pi_…` distinto (`:384-386`); sin comprobación de edad (ver P4/EXP-c) |
| Guarda `if (found.gatewayIntentRef)` | Corregida con `!isDispatchMark` (`:416`) |
| Receptor de webhooks | `paymentIntentId()` exige `^pi_[a-z0-9]{10,40}$` (`webhook.service.ts:~64`): una marca no puede ser el parámetro de la consulta SQL parametrizada, así que `limit 2` y las referencias hostiles no tienen cómo coincidir con ella. Las 18 pruebas de `rev3-b1-rls` (referencias hostiles, ambigüedad, fuga de `app.system_context`) siguen en verde sobre HEAD |
| `assertNotDispatched` (m5) y 409 `PAYMENT_INTENT_VIA_GATEWAY` | Tratan la marca como "despachada" (conservador): CONFIRMADO, ver P6 |
| Camino viejo con flag apagado | Una intención con marca ⇒ 409; ver P6 |
| Respuestas/DTOs/reportes | `toIntentResponse` no incluye la referencia; no hay GET de intenciones; `processViaGateway` devuelve `charged.gatewayIntentRef`, que siempre es el `pi_…` de la pasarela. La marca sí aparece en `audit.payment_intents_history.data_snapshot` (interno, sin PHI). Sin hallazgo |
| Longitud/columna | `gateway_intent_ref varchar` sin límite ni CHECK (`database/SQL/42_payments/02_tables.sql:79`) |

### (2) Regla 11 con la marca

- **504 ⇒ misma clave:** CONFIRMADO en ambos modos (RLS off, y RLS on con rol `NOBYPASSRLS`): `execute_then_drop` ×3 ⇒ 504, la fila queda con `dispatching:…`, el reintento devuelve el MISMO `pi_…`, `createdCount=1`, todas las claves de idempotencia iguales.
- **Fallo no-pasarela tras reservar** (un `TypeError` del cliente, equivalente a un crash entre el commit de la marca y la llamada): la marca se conserva (no es `PaymentsGatewayError`) y el reintento recupera con la misma clave. CONFIRMADO.
- **Marca vieja:** ver P4.

### (3) Concurrencia

- **3 despachos simultáneos sobre la misma deuda, 20 rondas, pasarela con 120 ms:** en ambos modos `{"ok":20, 409:40}`; nunca más de un cobro en la pasarela; en la base exactamente un `pi_…` y ninguna marca colgada por ronda. CONFIRMADO.
- **Misma intención ×5 simultáneos, 6 rondas por modo:** 5/5 `ok`, un solo cobro. CONFIRMADO.
- **Estrés de interbloqueos de la compuerta (rol `NOBYPASSRLS`, 40 rondas × 6 despachos, 2 deudas × 3 intenciones, 240 peticiones):** `{"ok":80, 409:160}`, cero `40P01`, cero errores distintos de 409. CONFIRMADO. (La carrera con la misma intención y rechazo asimétrico es P2.)
- **N5 — el bloqueo no se sostiene durante la HTTP:** con `RLS_ENFORCE=true` (rol restringido), durante la llamada `select … for update nowait` sobre la deuda y sobre la intención desde otra conexión SÍ obtiene el bloqueo («libre»); solo queda 1 conexión «idle in transaction» (la del interceptor, documentada). CONFIRMADO. El costo es P1.
- **N6 — webhooks, interbloqueo:** `REV-11` (A `failed` ‖ B `succeeded`, 40 rondas, rol `NOBYPASSRLS`, dos sesiones abiertas): `errores: {}` (la re-revisión medía 20–30 `40P01`); `REV3-12` (A `succeeded` ‖ B `failed` y `failed` ‖ `failed`, 40 rondas cada una): `errores: {}` y estados finales correctos (`SETTLED o=0` con sesiones `COMPLETED+EXPIRED`; `PENDING o=150` con `EXPIRED+EXPIRED`). CONFIRMADO. Orden de bloqueo revisado por lectura: intención → sesiones de la intención → deuda en todas las rutas (compuerta, webhook, checkout); la lectura sin `FOR UPDATE` de `findOpenCheckoutSessionsByDebt` es correcta bajo READ COMMITTED porque se lee después de obtener el bloqueo de la deuda.

### (4) N1, N7, N3

- **N1:** `isGatewayWebhookPath` (`gateway/payments-gateway-raw-body.ts`) ejecutada de verdad: 100 000 barras ⇒ 0,35 ms; ruta legítima + 100 000 barras finales ⇒ 0,50 ms; 100 000 barras + query ⇒ 0,34 ms; 1 000 000 de barras, ~0,01 ms (todas < 5 ms). Legítimas siguen funcionando: exacta, barra final, `/PAYMENTS/Gateway-Webhooks/`, mayúsculas+query ⇒ `true`; `//` en medio, forma absoluta (`http://h/…`), `%2D`, `;x=1` y `#x` ⇒ `false` (igual que antes; la forma absoluta de petición solo la envía un proxy). CONFIRMADO (`n1.mts`).
- **N7:** `findByIdAndTenantForUpdate` pone el tenant en el `WHERE` (`payment-intents.repository.ts:141-155`); el int-spec existente `(13) N7` (fila de la víctima bloqueada, petición de otro tenant responde al instante e idéntica a un UUID inexistente) pasa en mi corrida (105/105). Lectura: Postgres solo bloquea las filas que cumplen el `WHERE`, la ajena no se espera. Sin hallazgo.
- **N3:** `(12) N3` del int-spec existente pasa (mayúsculas, texto distinto y sin `sourceRefType` ⇒ `422 PAYMENT_GATEWAY_DEBT_UNRESOLVED`, cero llamadas, sin reserva; `EDUCATION_COURSE` sigue cobrando). Ver P8 para el costo de contrato.

### (5) Higiene

- **Restos de mutaciones:** `LockMode.PESSIMISTIC_WRITE` presente en `findByIdForUpdate`, `findByIdAndTenantForUpdate`, `findByGatewayIntentRefForUpdate`, `findCheckoutSessionsByIntentForUpdate`, `findDebtByIdForUpdate`; la única lectura sin bloqueo (`findOpenCheckoutSessionsByDebt`) es deliberada y está justificada (N6). Guardas con el sentido esperado (`blocksOtherCharges`, `assertDebtAllowsCharge`, `mayChargeADebt`, `assertResourceInTenant`).
- **Literales de clave:** `grep -E "sk_(live|test)_[A-Za-z0-9]{8,}"` en `src`, `test`, `.env.example`: ninguno. Los `whsec_`/`whpk_` solo están en `standard-webhook-signature.parity.spec.ts` (vectores sintéticos conocidos).
- **PHI en logs:** los logs nuevos (`payments.gateway.debt-gate`, `payments.gateway.create`) llevan solo `operation`, ids (`intentId`, `paymentDebtId`, `expiredReservationIntentIds`), `reason` (nombre de la clase de error) y códigos. Sin `console.*` ni `TODO`/`FIXME`/`.only` añadidos en el diff `4e64353a..HEAD`.
- **Specs previos:** `git diff --name-status 4e64353a HEAD`: ningún `*.spec.ts` ni `test/` preexistente figura como `M`/`D`. Entre `08a0e0688` y `97eaa006c` se modificaron specs del propio carril: se eliminaron 4 aserciones (`gatewayIntentRef toBeUndefined/toBeNull` tras un 504 y tras una reserva rechazada en `payments-intents.gateway.spec.ts` y `payments-gateway-charge.int-spec.ts`, y una constante en `payments-intents.authz.http.spec.ts`), reemplazadas por la aserción del nuevo contrato (`/^dispatching:/` o `isDispatchMark`). Es un cambio de semántica declarado, no un debilitamiento; lo señalo para que quede explícito.
- Los int-specs son opt-in (`describe.skip` sin `PAYMENTS_*_IT=local-throwaway-db`): hay que recordar que corren a mano (el CI propio está caído).

## Evidencia ejecutada (resumen)

```text
jest rev3-charge rev3-b1-rls payments-gateway-charge  (flock /tmp/pay-heavy.lock, PAYMENTS_*_IT=local-throwaway-db)
Test Suites: 3 passed, 3 total
Tests:       105 passed, 105 total
jest rev3-b1-rls (con REV-11 y REV3-12 imprimiendo errores)
R3> REV-11 errores en 40 rondas: {}
R3> REV3-12 errores: {}
Tests:       18 passed, 18 total
node n1.mts   (isGatewayWebhookPath con 100 000 y 1 000 000 de barras)  < 1 ms todas
```

## No cubierto

- No levanté `AppModule` ni el `TenantContextInterceptor` real: `RLS_ENFORCE=true` se simuló con la misma secuencia (`em.transactional` + `set_config`); el servicio corrió con el rol `NOSUPERUSER NOBYPASSRLS` y la política real. El historial (`HistoryMirrorSubscriber`) no estuvo registrado.
- Todo contra el doble HTTP de la pasarela, no contra `pay-edge`; el doble no reproduce un proxy sin cuerpo (P3) ni la política de rate limiting real (P2 usa 429 programados).
- La expiración se probó envejeciendo `updated_at` por SQL; no probé un proceso realmente congelado.
- P1 con pasarela lenta y tráfico mixto, y los efectos sobre otros módulos (todo acceso a la base se cuelga), son inferencia razonada a partir de la prueba con latencia 0.
- Esquema reducido (6–7 tablas, FKs a tablas ausentes omitidas). No revisé `billing`, reembolsos ni `wallet`. Sin multi-réplica (la expiración compara el reloj de la aplicación con `updated_at` escrito por la aplicación; una deriva de reloj entre réplicas de minutos no es realista, pero no la probé).
- No ejecuté el spec HTTP de autorización más allá de lo que incluye el int-spec y la suite que ya corrió el implementador.

## Decisiones y ambigüedades

- Supuse que producción usará `RLS_ENFORCE=true` (es la capa de aislamiento a nivel de base descrita en el interceptor); si el despliegue decide `false`, P1 no aplica pero P2/P3 sí. A confirmar con quien opere el despliegue.
- La severidad de P2 es MENOR por su baja probabilidad, aunque su consecuencia sea dinero; quien decida el riesgo aceptable puede subirla.
