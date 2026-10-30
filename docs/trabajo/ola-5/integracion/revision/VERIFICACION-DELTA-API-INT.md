# Verificación del delta `97eaa006c..06ec485eb` — carril INT, `mantra-core-health-api`

- Revisora: la misma 3.ª revisora de [TERCERA-REVISION-API-INT.md](./TERCERA-REVISION-API-INT.md) (P1…P9). SOLO LECTURA sobre `/home/user/mantra-core-health-api`; todo lo ejecutable corrió en un `git worktree` aparte (borrado, `git worktree prune` hecho) con `flock /tmp/pay-heavy.lock`, de a uno. Bases y roles `mantra_it_rev3*`: 0 y 0 al terminar. Nada se colgó: ningún comando superó los 10 min de ejecución (la cola del lock sí fue larga).
- Evidencia: [`VERIFICACION-DELTA-API-INT.evidencia/`](./VERIFICACION-DELTA-API-INT.evidencia/) (`rev3d-charge.int-spec.ts`, `salida-d1-int-delta.txt`, `salida-d2-unitarios-payments-orm.txt`).
- Cada hallazgo dice si lo **CONFIRMÉ ejecutando** o es **INFERENCIA** (lectura).

## Conclusión

| Pregunta | Respuesta |
|---|---|
| P1 (espera circular) | **Cerrado.** Con K = pool y K > pool no hay espera circular ni cuelgue: el excedente recibe 503 `PAYMENT_GATEWAY_BUSY` al instante; con tráfico ajeno que consume el pool los errores quedan acotados al timeout finito (6 s en mi arnés) y el pool se recupera |
| P2 (borrar solo la marca propia) | **Cerrado** (doble clic con 429 + éxito: un solo cobro, B 409) |
| P3 (4xx sin cuerpo del contrato) | **Cerrado en lo pedido**; queda un MENOR: "problema del contrato" = cualquier JSON con `code` string (no hay catálogo ni `content-type`) |
| Marca vencida | **Cerrada como permiso para cobrar** (sigue bloqueando, 0 POST, 409 `reconciliationRequired`); **pero abre un MAYOR operativo**: la conciliación no está expuesta por ninguna ruta ni la invoca nadie, y pasadas ~23 h no hay salida soportada |
| **Riesgo con marca (P9, hallazgo de seguridad MEDIUM)** | **Confirmado como defecto real: MAYOR.** Hipótesis del coordinador parcialmente cierta: m5 SÍ impide registrar un DECLINE tras la marca, pero REVIEW sí se registra y el reintento lo ignora y **crea un cobro NUEVO** bajo REVIEW; y como el DECLINE tampoco puede registrarse, tras una marca no existe ninguna palanca de riesgo que frene el reintento |
| ¿INT.M3 HECHO? | **No todavía, ni con `RLS_ENFORCE=false` ni con `true`**, por el MAYOR de riesgo (aplica a ambos modos) y el MAYOR operativo de la conciliación. Con `RLS_ENFORCE=true` el bloqueante de la pasarela de conexiones (P1) ya no existe |

### Qué sigue abierto para encender el flag

1. **[MAYOR] Riesgo con marca (ver D1):** restaurar la evaluación de riesgo en el reintento con marca (o permitir solo replay). Es el único cambio funcional que falta para el camino de cobro.
2. **[MAYOR] Salida operativa de la marca (ver D2):** exponer `listDispatchesRequiringReconciliation` y `reconcileGatewayDispatch` con guard de rol y tenant (o un job), y definir qué se hace a las 23 h; hoy una deuda bloqueada por una marca vieja no tiene salida por API.
3. Alerta/consumidor de la métrica `payments_gateway_dispatch_reconciliation_required_total` y del log `debt-gate` (hoy no hay quien los lea), y runbook de marcas colgadas y de cobros huérfanos (webhook terminal 404, P5 anterior).
4. MENORES: D3 a D7 (abajo).

Recomendación de marca: con esto cerrado, `RLS_ENFORCE=true` y `false` quedan en TESTED/VERIFIED sin bloqueantes; hasta entonces, M3 permanece `A MEDIAS`.

## Resumen por severidad

| Sev. | # | Hallazgo | Prueba |
|---|---|---|---|
| **MAYOR** | D1 | El reintento con marca no re-evalúa el riesgo (`payments-transactions.service.ts:581`): un `REVIEW` registrado después de la marca se ignora y, si el primer envío nunca llegó, el reintento crea un cobro NUEVO con su QR; un `DECLINE` ni siquiera se puede registrar (409 m5) y el reintento también cobra | CONFIRMADO ejecutando |
| **MAYOR** | D2 | `reconcileGatewayDispatch` y `listDispatchesRequiringReconciliation` no están expuestos (cero controladores, cero llamadores): la "conciliación" real es el reintento del dueño por `/transactions`; a las ~23 h no reenvía y no existe ninguna vía soportada para liberar ni asociar: la deuda queda bloqueada | CONFIRMADO ejecutando (409, 0 POST) + lectura (sin rutas) |
| MENOR | D3 | "Problema del contrato" = cualquier JSON con `code` string: un 404 de un proxy con `{"code":"upstream_blocked"}` cuenta como rechazo definitivo y libera la reserva | CONFIRMADO ejecutando |
| MENOR | D4 | Compatibilidad: una marca del formato anterior (`dispatching:<uuid>`) queda sin fecha: bloquea para siempre y el reintento propio responde 409 `RECONCILIATION_REQUIRED`; una marca con fecha futura nunca se lista para conciliar | CONFIRMADO ejecutando |
| MENOR | D5 | El tope `ceil(DB_POOL_MAX/2)-1` limita a 4 cobros simultáneos por proceso con el pool por defecto (6 de 10 simultáneos reciben 503); con `DB_POOL_MAX` ≤ 2 el tope mínimo es 1 y con 1 un despacho necesita 2 conexiones | Límite CONFIRMADO ejecutando; `DB_POOL_MAX=1` INFERENCIA |
| MENOR | D6 | Specs: se eliminó/invirtió el test unitario "el reintento con la marca vuelve a pasar TODAS las compuertas: un DECLINE posterior lo frena sin llamar"; el reemplazo (P9) solo cubre "el cobro SÍ se ejecutó" (replay), no "el envío nunca llegó" (creación nueva) | Lectura del diff + D1 ejecutado |
| MENOR | D7 | Un timeout de adquisición en `associate` (tras crearse el cobro) sale como 500 genérico y deja la marca; recuperable con el reintento. No lo ejercité en esa etapa | INFERENCIA |

---

## D1 — MAYOR: P9 / hallazgo de seguridad MEDIUM sobre `assertRiskCleared`

**Código (`payments-transactions.service.ts:581`)**
```ts
if (!isDispatchMark(found.gatewayIntentRef)) {
  await this.assertRiskCleared(tx, intentId, true);
}
```

**Falsación de la hipótesis del coordinador** («m5 rechaza un DECLINE tras la marca, así que no puede registrarse»):

- (a) **Todas las rutas que escriben `risk_assessments`:** hay una sola, `PaymentsIntentsService.assessRisk` (`payments-intents.service.ts:251`; único llamador de `createRiskAssessment`), expuesta como `POST /payments/intents/:id/risk-assessment` (`@Roles('PAYMENTS_ADMIN')`). No hay otra operación ni controlador que lo escriba. `gateway_intent_ref` no se puede fijar por ninguna API (`PaymentIntentsRepository.create` copia campos explícitos y el DTO no tiene el campo; solo lo escribe la compuerta tras pasar el riesgo y `associate`).
  - **DECLINE tras la marca:** `assertNotDispatched` (`:275`) lo rechaza con `409 PAYMENT_INTENT_VIA_GATEWAY` porque la marca vive en la misma columna. CONFIRMADO ejecutando (marca por envío que nunca llegó): `registrar=e409:PAYMENT_INTENT_VIA_GATEWAY`.
  - **REVIEW tras la marca:** NO está protegido (`assertNotDispatched` solo corre para `DECLINE`). CONFIRMADO ejecutando: `registrar=ok`.
- (b) **Orden inverso (riesgo antes de la marca):** la marca solo se escribe tras `assertRiskCleared` dentro de la misma transacción que bloquea la fila de la intención `FOR UPDATE`, y `assessRisk` bloquea la misma fila: se serializan. CONFIRMADO ejecutando con 30 rondas de `dispatch ‖ DECLINE`: 25 × (dispatch ok / DECLINE 409) y 5 × (DECLINE ok / dispatch `422 PAYMENT_INTENT_RISK_DECLINED`); **nunca** ambos ok. Con `dispatch ‖ REVIEW` (30 rondas): 26 × ambos ok (el REVIEW llegó después de que el cobro ya salió: inherente) y 4 × dispatch `422 RISK_REVIEW_PENDING`. Sin evaluación / REVIEW / DECLINE previos: 422 y **ninguna marca** (marcas `[null,null,null]`). Tampoco hay forma de saltear la compuerta creando una marca sin pasar por ella: solo escribiéndola en la base (`RIESGO marca-SQL sin evaluacion: ok`, que demuestra que la guarda depende únicamente de la marca; requiere acceso directo a la base, no hay ruta de API).
- (c) **Vía de daño — existe, con REVIEW** (y, de hecho, con cualquier decisión pendiente tras la marca). CONFIRMADO ejecutando (`rev3d-charge.int-spec.ts`, "RIESGO-despues-de-marca"):

```text
RIESGO-despues-de-marca REVIEW:  registrar=ok;                          reintento=ok; POST nuevos=1; cobros creados=1
RIESGO-despues-de-marca DECLINE: registrar=e409:PAYMENT_INTENT_VIA_GATEWAY; reintento=ok; POST nuevos=1
```
  Escenario: APPROVE → primer envío no llega (corte antes de ejecutar) → marca → un analista registra `REVIEW` («revisión humana antes de cobrar») → el cajero repite `/transactions`: la compuerta salta el riesgo y el cliente crea el cobro por primera vez, entregando el QR bajo una revisión pendiente. Con el estado anterior (`97eaa006c`) ese reintento respondía `422 RISK_REVIEW_PENDING`.
  - **Daño:** cobro nuevo (no replay) con QR entregado bajo REVIEW; y, peor, el riesgo no tiene ninguna palanca tras la marca: DECLINE → 409 (mensaje «ya tiene un cobro en la pasarela», falso si el envío nunca llegó), REVIEW → ignorado.
  - **Alcance:** igual con `RLS_ENFORCE=true` y `false` (no depende de conexiones).
  - **Por qué el test del implementador no lo vio:** el unit nuevo (`payments-intents.gateway.spec.ts`, "P9: un riesgo %s posterior al 504 NO impide recuperar el cobro…") usa un 504 en el que el cobro SÍ se ejecutó (`ambiguous()` = `execute_then_drop`), así que el reintento es un replay; no cubre el caso "nunca llegó". Además `d.assess` escribe el riesgo directo, saltándose m5.
- **Arreglo mínimo recomendado** (ordenado por simplicidad):
  1. **Restaurar `assertRiskCleared(tx, intentId, true)` también con marca** (el comportamiento de `97eaa006c`). El costo es acotado: el QR de un cobro solo viaja en la respuesta de creación, así que bloquear el reintento bajo REVIEW/DECLINE nunca expone dinero; a lo sumo deja un cobro huérfano que expira solo y que se concilia/aprueba de nuevo (un `APPROVE` posterior destraba el reintento). Es coherente con lo ya aceptado para el huérfano de P4/P5.
  2. Si el negocio quiere conservar la recuperación bajo REVIEW: que el reintento con marca solo pueda **replayar**: si el riesgo vigente no es APPROVE y la pasarela responde "creado" (no `replayed`), no entregar el QR, asociar el `pi_…` para no perderlo y dejar la intención marcada para cancelación/conciliación. Es más trabajo (asociación sin respuesta al cliente, cancelación en la pasarela) y no evita que el cobro se cree.
  3. En cualquier caso, hacer que `assertNotDispatched` distinga marca de `pi_…` para el `DECLINE` (con solo marca, registrar el DECLINE y que el reintento lo respete), de modo que el riesgo conserve su palanca. Añadir el test "el envío nunca llegó + REVIEW/DECLINE posterior ⇒ el reintento NO crea cobro".

## D2 — MAYOR: la conciliación no es alcanzable

- **Exposición (la pregunta "¿se expone? ¿con qué guards?"):** NO se expone. `grep` sobre `src`: `reconcileGatewayDispatch` y `listDispatchesRequiringReconciliation` solo se definen y se mencionan en comentarios y specs; ningún controlador, job ni módulo los invoca; `git diff 97eaa006c 06ec485eb -- src/modules/payments/controllers` está vacío. Por tanto un usuario cualquiera **no puede** invocarlos (no hay ruta, ni de `PAYMENTS_ADMIN`). Los dos son métodos públicos de servicios `@Injectable` sin parámetro de actor ni comprobación de rol: si alguien los conecta mañana a una ruta, hay que ponerles `@Roles` y el tenant del contexto (el de `listDispatches…` recibe `tenantId` como argumento). Si se invocan, `reconcileGatewayDispatch` sí queda acotado al tenant del contexto: con otro tenant responde 404 (CONFIRMADO).
- **Qué ocurre en la práctica:** la única conciliación alcanzable es el reintento normal del dueño (`POST /payments/intents/:id/transactions`, roles `PAYMENTS_ADMIN`/`CASHIER`), que ya reenvía con la misma clave si la marca tiene < 23 h. CONFIRMADO ejecutando:
  - marca vencida (3 h, con `updated_at` fresco, o sea que la antigüedad ya no depende de `updated_at`): otra intención sigue en `409 PAYMENT_GATEWAY_DEBT_HAS_OPEN_CHARGE` con `reconciliationRequired: true`, 0 POST nuevos; `list…` la reporta (antes de envejecer no); 
  - conciliar con el `pi_` existente: replay, asociado el mismo `pi_`, 1 cobro, 1 clave; B sigue 409 (el cobro de A está en vuelo);
  - conciliar cuando el primer envío nunca llegó: crea UN cobro; una segunda conciliación no crea otro (`creados=1`, 1 clave);
  - marca de 24 h: reintento propio y `reconcile` responden `409 PAYMENT_GATEWAY_RECONCILIATION_REQUIRED`, 0 POST, y B sigue bloqueada;
  - otro medio de pago tras el 504 (`card` tras `qr`): `409 RECONCILIATION_REQUIRED` y la marca se conserva; sin marca: `409 NOTHING_TO_RECONCILE`.
- **El problema:** pasadas ~23 h (o si el dueño no vuelve) la deuda queda bloqueada para siempre y no hay endpoint para asociar el `pi_` a mano ni para liberar la marca; la única corrección sería un `UPDATE` directo, que la regla 97.1.5 prohíbe. Es el lado seguro (cero doble cobro) pero sin salida. La métrica `payments_gateway_dispatch_reconciliation_required_total` solo cuenta si hay un SDK de métricas conectado y nadie la consume.
- **Arreglo:** una ruta administrativa (`@Roles('PAYMENTS_ADMIN')`, tenant del contexto) para listar y para resolver manualmente (asociar un `pi_` informado por el operador tras consultarlo en la pasarela, o cancelar/liberar con constancia y actor), más el runbook.

## Verificación punto por punto

### (1) P1 — cupo de despachos y `connectionTimeoutMillis` (CONFIRMADO ejecutando; rol `NOBYPASSRLS`, política real, pasarela de 300 ms)

```text
pool=4  (limite 1): K=1  -> {"ok":1}                          861 ms
pool=4  (limite 1): K=4  -> {"ok":1,"e503:PAYMENT_GATEWAY_BUSY":3}  346 ms
pool=4  (limite 1): K=8  -> {"ok":1,"e503:...BUSY":7}               360 ms
pool=10 (limite 4): K=4  -> {"ok":4}                          423 ms
pool=10 (limite 4): K=10 -> {"ok":4,"e503:...BUSY":6}          435 ms   (antes: 10/10 colgados)
pool=10 (limite 4): K=25 -> {"ok":4,"e503:...BUSY":21}         403 ms
mixto-a: 6 ajenas retienen conexión 1,5 s + 4 despachos -> {"ok":4} en 1423 ms
mixto-b: 6 ajenas retienen conexión 9 s  (> timeout 6 s) + 4 despachos -> 4 x "timeout exceeded when trying to connect" en 6006 ms; marcas dejadas: ninguna; cobros creados: 0; tras liberar, el reintento de la primera: ok
mixto-c: 9 ajenas (1,5 s) + 4 despachos -> {"ok":4} en 1418 ms
sin RLS, pool=4, 8 simultáneas -> {"ok":8}  (el cupo no aplica sin transacción de petición)
```
- La espera circular **no reaparece**: con carga ajena el peor caso es un error acotado por el timeout, no un cuelgue, y el sistema se recupera. El cupo se libera en todas las salidas (404, 422 de compuerta ×3, rechazo de la pasarela, éxito: el éxito final pasó con límite 1).
- **`connectionTimeoutMillis` (`orm.config.ts:111`, `DB_CONNECTION_TIMEOUT_MS`, default 30 000, mínimo 1 000):** acota solo la ESPERA por una conexión (y su establecimiento); no limita consultas, transacciones largas, conexiones ociosas ni jobs que ya tienen su conexión. Lo que cambia: con el pool saturado una petición ajena falla con `timeout exceeded when trying to connect` (500) a los 30 s en lugar de esperar indefinidamente. No encontré otra ruta que dependa de esa espera ilimitada: el arranque (cerrojo de DDL) retiene una conexión pero no la espera; los 29 suites unitarios de `src/modules/payments` y `src/orm` pasan (616/616), y no hay otro `new Pool(...)` en `src` (solo `src/persistence/factory/postgres-connection.factory.ts` y la fábrica del ORM). INFERENCIA para jobs/migraciones largos: no los ejecuté.
- **Límite real (D5):** el cupo es por proceso (`readPoolMax()` lee `DB_POOL_MAX` al construir el servicio) y es el costo de la solución: 4 cobros simultáneos por réplica con el pool por defecto. Con `DB_POOL_MAX` ≤ 2 el tope es 1; con 1, un despacho necesita 2 conexiones (INFERENCIA; el esquema Joi exige `DB_POOL_MIN ≤ DB_POOL_MAX` y el mínimo por defecto es 2, así que es difícil de alcanzar). La garantía "siempre queda una libre" vale mientras el resto del tráfico no haga a su vez hold-and-wait; no revisé si otras rutas bajo RLS abren una segunda conexión.

### (2) P2 — cerrado (CONFIRMADO ejecutando)
Doble clic con 3 × 429 en la primera y éxito en la segunda en vuelo: `marca de A durante la ventana=dispatching:…` (ya no `NULL`), `B=409 DEBT_HAS_OPEN_CHARGE`, `A1/A2 = 503, ok`, cobros vivos = 1, marca final de A = `pi_…`. Cada petición escribe un valor propio de marca (`reserveDispatch` conserva la fecha, no el valor) y `releaseReservation(intent, ownMark)` compara `row.gatewayIntentRef === ownMark` antes de borrar (`payments-gateway-charge.service.ts` ~`:509`).

### (3) P3 y (6) F1-A — cerrados (CONFIRMADO ejecutando)

| Respuesta a la creación | Resultado |
|---|---|
| 404 / 400 / 408 / 413 / 499 SIN cuerpo | 504 ambiguo, marca RETENIDA, otra intención 409 |
| 422 `validation_failed`, 400, 409 `invalid_state_transition` con problema | 422 `GATEWAY_REJECTED`, marca LIBERADA, otra intención ok |
| 401 / 403 / 404 `resource_not_found` con problema | 503, marca LIBERADA |
| 429 ×3 (explícito, agotado) | 503, marca LIBERADA |
| 422 `idempotency_key_reused` | 409 `RECONCILIATION_REQUIRED`, marca RETENIDA |
| F1-A: ambiguo (ejecutó) → 422 final | 504, RETENIDA, `creados=1`, otra intención 409 |
| F1-A: ambiguo (no llegó) → 422 final | 504, RETENIDA |
| F1-A: 503 → 400 final | 504, RETENIDA |

Residual **D3 (MENOR, CONFIRMADO ejecutando):** un servidor que responde `404` con `{"code":"upstream_blocked"}` (JSON ajeno) → `isAmbiguous=false`, `ambiguity=rejected` (libera). `parseProblem` solo comprueba `typeof code === 'string'` (`gateway/payments-gateway.errors.ts`); falta exigir `content-type: application/problem+json` o un `code` del catálogo del contrato.

### (4) Marca vencida — ver D2. Además (CONFIRMADO ejecutando)
- Formato antiguo `dispatching:<uuid>`: sin fecha legible ⇒ el reintento propio responde `409 RECONCILIATION_REQUIRED` y B sigue bloqueada (conservador). Si el flag llegó a encenderse con `97eaa006c` en algún entorno, esas filas quedan sin salida (D4). Fecha futura: `dispatchMarkAgeMs` hace `Math.max(0, now - stamp)` (`dispatch-mark.ts:87`), o sea edad 0: bloquea, pero nunca se lista para conciliar (el comentario dice que una fecha futura lejana es "ilegible", el código no lo implementa).
- `listDispatchesRequiringReconciliation(TENANT)` filtra por tenant; solo devuelve las que cumplen `reconciliation_required`.

### (5) Riesgo — ver D1.

### (7) Higiene del delta (CONFIRMADO por búsqueda y ejecución)
- Sin literales `sk_live_`/`sk_test_`/`whsec_` nuevos; sin `console.*`, `TODO`, `FIXME`, `.only`, `.skip`, `xit` añadidos en `src`/`test`.
- Sin restos de mutaciones: `releaseReservation` compara la marca propia; la compuerta usa `classifyInFlight(...) !== 'none'` (bloquea siempre); el cupo se libera en `finally`.
- PHI en logs: los logs/métricas nuevos llevan solo `operation`, ids, `limit`, `reason`/`outcome` (etiquetas cerradas, sin ids como etiqueta de métrica). Sin hallazgo.
- Specs: ningún spec preexistente de antes de `4e64353a` modificado. Entre `97eaa006c` y `06ec485eb` se reescribieron tests del propio carril porque cambia el contrato (marca vencida ya no desbloquea; `blocksOtherCharges` → `classifyInFlight`). Señalo uno que sí es una pérdida de cobertura de riesgo (D6): se invirtió el test "el reintento con la marca vuelve a pasar TODAS las compuertas: un DECLINE posterior lo frena sin llamar" por uno que afirma lo contrario, solo para el caso "ejecutó".
- Verificado en verde: `jest rev3d-charge payments-gateway-charge` (int, opt-in) 123/123 en 2 suites; `jest src/modules/payments src/orm` 616/616 en 29 suites.

## No cubierto

- No levanté `AppModule` ni el `TenantContextInterceptor` real (RLS simulado con la misma secuencia `em.transactional` + `set_config`). El cupo se activa con `em.isInTransaction()`; en producción debe confirmarse con una prueba HTTP que esa condición es verdadera dentro del interceptor.
- Todo contra el doble HTTP de la pasarela, no contra `pay-edge`.
- No ejercité un `timeout` de conexión en `associate` (D7) ni jobs/migraciones largos con el nuevo `connectionTimeoutMillis`.
- No revisé otras rutas bajo RLS que abran una segunda conexión.
- Métricas OTel: solo verifiqué que `@opentelemetry/api` es dependencia directa; no que haya un SDK/exportador que las publique.

## Decisiones y ambigüedades

- Severidad de D1: MAYOR (no BLOQUEANTE) porque requiere un envío que no llegó + un REVIEW registrado entre medio + el reintento del cajero; pero la consecuencia es crear y entregar un cobro saltando la revisión humana, y el cierre es de una línea. Si el negocio considera que "REVIEW" es meramente informativo después del despacho, debe decirlo por escrito (a confirmar con quien defina la política antifraude) y retirar entonces la exigencia del test.
