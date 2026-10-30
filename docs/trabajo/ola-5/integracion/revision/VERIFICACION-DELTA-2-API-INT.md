# Verificación del delta 2 `06ec485eb..b881a4f15` — carril INT, `mantra-core-health-api`

- Revisora: la misma 3.ª revisora ([TERCERA-REVISION-API-INT.md](./TERCERA-REVISION-API-INT.md), [VERIFICACION-DELTA-API-INT.md](./VERIFICACION-DELTA-API-INT.md)). SOLO LECTURA sobre `/home/user/mantra-core-health-api`; todo lo ejecutable corrió en un `git worktree` aparte (borrado, `git worktree prune` hecho) bajo `flock /tmp/pay-heavy.lock`, de a uno. Bases y roles `mantra_it_rev4*`: 0 y 0 al terminar. Ningún comando superó los 10 min de ejecución.
- Evidencia: [`VERIFICACION-DELTA-2-API-INT.evidencia/`](./VERIFICACION-DELTA-2-API-INT.evidencia/) (`rev4-charge.int-spec.ts`, `rev4b-charge.int-spec.ts`, `rev4-dispatches.http.spec.ts`, `rev4-problem.spec.ts` y tres salidas).
- Cada hallazgo dice si lo **CONFIRMÉ ejecutando** o es **INFERENCIA**.

## Conclusión

| Pregunta | Respuesta |
|---|---|
| D1 (riesgo con reserva) | **Cerrado en lo pedido.** Con el envío "nunca llegó", un REVIEW o un DECLINE posterior frenan el reintento y la conciliación (0 POST nuevos); un APPROVE posterior destraba con un solo cobro. Queda un MENOR nuevo (D10: el DECLINE registrado durante la llamada HTTP no detiene el cobro en vuelo) |
| D2 (rutas administrativas) | **La autorización está cerrada** (matriz negativa completa). **La función NO está cerrada**: `close` tiene una carrera de dinero (D8, MAYOR) y no libera el checkout (D9, MAYOR) |
| D3 (`parseProblem` estricto) | **Cerrado.** Los 23 códigos del catálogo real de la pasarela, construidos con su `problem()` real, se reconocen; los JSON ajenos ya no |
| D4 (marcas sin fecha / futuras) | **Cerrado.** Listables (`canReconcile:false`) y cerrables |
| **D8 (hallazgo HIGH de seguridad: `close` vs reintento en vuelo)** | **Confirmado, explotable por un operador legítimo, MAYOR.** 100 % de las rondas en ambos modos: intención `CANCELED` con `pi_` asociado y QR entregado, deuda libre, y otra intención cobra: 2 cobros vivos |
| ¿INT.M3 HECHO? | **No, ni con `RLS_ENFORCE=true` ni con `false`.** D8 y D9 aplican a ambos modos. Con ambos cerrados quedaría en TESTED/VERIFIED sin bloqueantes |

### Qué sigue abierto para encender el flag

1. **[MAYOR] D8:** `close` no puede cancelar una intención cuyo reintento está en vuelo; y `associate` no puede entregar un QR sobre una intención ya no abierta (ver arreglo abajo).
2. **[MAYOR] D9:** `close` debe expirar las sesiones de checkout abiertas de la intención y devolver la deuda a `DEBT_PENDING` (con la lógica de `releaseDebt`); hoy el flujo por checkout queda atascado sin salida.
3. Menores D10 a D13 (abajo), alerta/consumidor de la métrica y runbook de huérfanos (ya pedidos en la verificación anterior).

## Resumen por severidad

| Sev. | # | Hallazgo | Prueba |
|---|---|---|---|
| **MAYOR** | D8 | `close` decide "vencida" con la fecha ORIGINAL de la marca (`payments-transactions.service.ts:417`); el reintento del dueño (cuyo gate ya confirmó y cuya llamada HTTP sigue en vuelo) no cuenta como actividad: `close` cancela la intención (`:426`) y libera la deuda mientras el cobro se crea y `associate` (`payments-gateway-charge.service.ts:487`) lo asocia a una intención `CANCELED`, entregando el QR | CONFIRMADO ejecutando (RLS off y on) |
| **MAYOR** | D9 | `close` solo cambia el estado de la intención: su sesión de checkout sigue `OPEN` y la deuda `IN_CHECKOUT`; el checkout nuevo responde 412 y un fallo de otra intención no libera la deuda (queda una sesión abierta) | CONFIRMADO ejecutando (estado en la base); consecuencias por lectura |
| MENOR | D10 | Un DECLINE registrado mientras el primer envío está en vuelo (solo reserva) responde 201 pero NO detiene el cobro, que se asocia y queda pagable con el DECLINE vigente; antes el analista recibía 409 | CONFIRMADO ejecutando (27 de 30 rondas) |
| MENOR | D11 | El motivo de `close` acepta cualquier cosa de 10–300 caracteres tras la conversión implícita (`12345678901234`, `{"a":"…"}` ⇒ `"[object Object]"`; 10 espacios pasan `MinLength`) y solo llega al log estructurado: no queda en la auditoría persistente | CONFIRMADO ejecutando (número y objeto ⇒ 201); espacios INFERENCIA |
| MENOR | D12 | `close` es repetible (el segundo cierra de nuevo, 201) y no libera cupo ni usa el cupo de despachos: en RLS toma una 2.ª conexión (`runCommitted`) sin límite | Repetible CONFIRMADO; cupo INFERENCIA |
| MENOR | D13 | El cobro huérfano tras un `close` sigue sin alerta: su webhook terminal no encuentra intención (0 filas con ese `pi_`) y responde 404 en bucle | CONFIRMADO ejecutando (0 filas) + lectura del receptor |

---

## D8 — MAYOR: `close` concurrente con el reintento en vuelo (hallazgo HIGH de la revisión automática)

- **Código:** `closeGatewayDispatch` (`payments-transactions.service.ts:391-441`): bloquea la intención `FOR UPDATE` en una transacción corta, llama `classifyInFlight(found, Date.now(), leaseMs)` (`:417`) con la fecha escrita en la marca y pone `PI_CANCELED` (`:426`). `reserveDispatch` conserva a propósito la fecha original en cada reintento (para el límite de 23 h), de modo que **un reintento recién confirmado y con su llamada HTTP en curso se ve como "vencido"**. El bloqueo de fila no ayuda: el reintento ya confirmó su compuerta (la llamada HTTP corre sin bloqueos, N5) antes de que `close` pida la fila.
- **Reproducción (CONFIRMADO ejecutando, `rev4-charge.int-spec.ts`, pasarela con 400 ms de latencia, `close` a los 120 ms del reintento; rol `NOBYPASSRLS` + política real en el modo RLS):**

```text
RLS_ENFORCE=false / el cobro SI existia (replay):              {"retry=ok | close=ok | A=CANCELED/pi_ | B=ok | cobros vivos=2":6}  -> 6/6
RLS_ENFORCE=false / el primer envio nunca llego (crea):        {... "A=CANCELED/pi_ | B=ok | cobros vivos=2":6}                    -> 6/6
RLS_ENFORCE=false / close y reintento arrancando a la vez:     {... A=CANCELED/pi_ ... vivos=2: 12}  CANCELED con pi_=12/12
RLS_ENFORCE=true  / replay:  6/6;  nunca llegó: 6/6;  a la vez: 12/12
```
  Es decir, sin una sola ronda de escape: el reintento responde `ok` (entrega el QR al cajero), `close` responde 201, la intención A queda `CANCELED` **con** el `pi_` asociado, la deuda queda libre y la intención B se despacha: dos cobros vivos con sus dos QR entregados.
- **¿Es explotable?** Por un `PAYMENTS_ADMIN` (el único rol que llega a `close`) que cierra una reserva vencida mientras el dueño (`PAYMENTS_ADMIN`/`CASHIER`) la reintenta; no es explotable por un tercero ni sin rol. Es un fallo de coordinación natural (el administrador cierra "la que está colgada" justo cuando el cajero vuelve a intentar), no un ataque, y la ventana es toda la llamada HTTP del reintento (hasta ~40 s). Dentro de ella el resultado es determinista (100 %).
- **Daño:** (a) un cobro vivo y pagable sobre una intención cancelada (si lo paga, su webhook `succeeded` encuentra la intención `CANCELED` ⇒ contradicción ⇒ cola de conciliación `processed=false`, sin asentar la deuda: el dinero entra y no se imputa); (b) la deuda libre ⇒ otra intención cobra ⇒ el pagador puede pagar dos veces (los dos QR se entregaron). Es la consecuencia de dinero que la reserva existe para evitar.
- **Sobre las sugerencias de la revisión automática:** *CAS sobre la marca exacta en `close`* **no alcanza** por sí solo: `close` lee la fila bajo `FOR UPDATE` después del `COMMIT` de la compuerta del reintento, así que ya ve el valor NUEVO de la marca (cada petición escribe un valor único) y el CAS pasa; `FOR UPDATE` durante `close` tampoco, porque el reintento no retiene ningún bloqueo durante su HTTP.
- **Arreglo mínimo recomendado (dos piezas, la segunda es la que da seguridad):**
  1. **Que `close` mida la actividad reciente, no solo la antigüedad de la marca:** exigir además `updated_at` (que `reserveDispatch` refresca con `touch`) más viejo que el plazo (`dispatchLeaseMs`), o un sello propio por intento (columna/valor de la marca que cambie en cada intento y se compare con el plazo). Estrecha la ventana a "dos intentos casi simultáneos" y es compatible con el límite de 23 h, que sigue contando desde la fecha original.
  2. **`associate` no debe entregar un QR sobre una intención que ya no está abierta:** si al asociar la fila no está en `PI_PENDING`/`PI_PROCESSING` (o el último riesgo ya no es APPROVE, ver D10), persistir igualmente el `pi_` (para que su webhook se resuelva a una intención y caiga en conciliación en vez de dar 404) pero **responder 409 al cliente sin `nextAction`** y registrar el caso para devolución/anulación. Así, aunque `close` y el reintento se crucen, ningún QR llega a una persona y no hay segundo cobro pagable. Esta pieza cubre también D10.
  3. Test de regresión: `Promise.all([reintento con latencia, close])` en ambos modos con la aserción "no existe una intención `CANCELED` con QR entregado".

## D9 — MAYOR: `close` no libera el checkout

- **CONFIRMADO ejecutando** (`rev4b-charge.int-spec.ts`): una intención ligada a la deuda por SESIÓN de checkout (sin `sourceRef` de deuda), con su sesión `OPEN` y la deuda `IN_CHECKOUT`; tras un 504, marca vencida y `close` (201): `sesion de A tras close=OPEN; deuda tras close=IN_CHECKOUT`. La intención B pasa la compuerta de la pasarela (porque A está `CANCELED`), pero:
  - `PaymentsCheckoutService` rechaza abrir un checkout nuevo sobre una deuda `IN_CHECKOUT` (`PAYMENT_DEBT_CHECKOUT_ALREADY_OPEN`), y
  - si B termina `failed`, `releaseDebt` encuentra la sesión `OPEN` de A y deja la deuda en `IN_CHECKOUT` (`stillOpen > 0`); nada expira la sesión de A (solo `releaseDebt` de un webhook de A, que nunca llega).
  Resultado: la deuda queda atascada en el flujo de checkout, sin salida soportada (solo `UPDATE`, prohibido por la regla 97.1.5). La doc del endpoint dice «cancela la intención y libera la deuda»; solo es cierto para la compuerta de la pasarela. El front actual no envía `sourceRefType` de pagos (sin resultados en `mantra-core-health/src`), así que el flujo por checkout puede ser el principal.
- **Arreglo:** en `close`, dentro de la misma transacción, expirar las sesiones de checkout `OPEN` de la intención y, si la deuda estaba `IN_CHECKOUT` y no queda otra sesión abierta, volverla a `DEBT_PENDING` (reutilizar la lógica de `releaseDebt` del receptor). Test: el de arriba con la aserción contraria.

## D1 — verificación (CONFIRMADO ejecutando; `salida-e1-…`)

```text
REVIEW tras el envío que nunca llegó:  registrar=ok; reintento=422 RISK_REVIEW_PENDING; reconcile=422 RISK_REVIEW_PENDING; POST nuevos=0; cobros=0
DECLINE tras el envío que nunca llegó: registrar=ok (ya NO 409); estado=PENDING ref=dispatching:…; reintento=422 RISK_DECLINED; reconcile=422 RISK_DECLINED
  deuda: B(reserva fresca)=409; close(fresca)=409 DISPATCH_IN_FLIGHT; B(vencida)=409 reconciliationRequired; listada=true; close(vencida)=201; B tras close=ok; A reintenta tras close=422 PAYMENT_INTENT_CANCELED; POSTs de A tras close = 3 (los 3 originales)
DECLINE/REVIEW -> APPROVE, envío nunca llegó:  bloqueado=422; luego pi_… ; B=409; cobros=1; claves=1   (x2)
DECLINE/REVIEW -> APPROVE, el cobro SÍ se ejecutó: bloqueado=422; luego el MISMO pi_ (replay); B=409; cobros=1; claves=1   (x2)
```
- **Estado coherente:** una intención con reserva + DECLINE queda `PI_PENDING` con la marca, bloquea la deuda (409 a otras), figura en el listado cuando vence y se puede cerrar; no hay forma de llegar a un estado incoherente por esta vía. La conciliación (`reconcile`) pasa por la misma compuerta y también responde 422 con DECLINE/REVIEW: el riesgo no se saltea por esa ruta.
- **Un APPROVE posterior destraba y no permite doble cobro:** el reintento usa la misma clave; 1 cobro y 1 clave en las 4 combinaciones, y B sigue bloqueada.
- **Carrera registrar DECLINE vs despachar (30 rondas, DECLINE escalonado, pasarela 80 ms):** nunca un reintento posterior que CREE un cobro tras un DECLINE (0/30). Pero ver D10.
- Nota de proceso: el implementador invirtió dos tests ("P9: …no impide recuperar…") por los contrarios; es el cambio de semántica pedido, no un debilitamiento.

## D10 — MENOR: DECLINE durante el vuelo

`assessRisk` con solo reserva registra el DECLINE sin pasar la intención a `failed` (`payments-intents.service.ts:280`). En 30 rondas con DECLINE escalonado mientras el primer envío estaba en vuelo: **27** terminaron `dispatch=ok | DECLINE=201 | final=PENDING/pi_…` (cobro asociado, QR entregado, DECLINE vigente) y **3** con `DECLINE=409` (cuando ya había `pi_`). El analista recibe 201 como si hubiera frenado el cobro; antes recibía 409 (señal de "ya despachado"). Es inherente a un despacho no atómico, pero ahora es silencioso, y un webhook `succeeded` posterior aplicaría el pago sobre una intención con DECLINE. **Arreglo:** el de D8 (2): `associate` consulta el último riesgo y, si no es APPROVE, no entrega el QR (409) y marca para anulación; y/o `assessRisk` devuelve en la respuesta que "había un despacho en vuelo y el cobro puede existir".

## D2 — autorización y entradas (CONFIRMADO ejecutando, `rev4-dispatches.http.spec.ts` + el spec del implementador, con la cadena REAL de guards e interceptor)

```text
MASS-ASSIGNMENT: close+statusConceptId=400 close+gatewayIntentRef=400 close+tenantId=403 close+__proto__=201(la clave se descarta; no hay efecto)
                 reconcile+amount=400 reconcile+tenantId=403 reconcile+gatewayIntentRef=400
MOTIVO: 9=400 10=201 300=201 301=400 numero=201 array=400 null=400 objeto=201
ROLES: SA-sin-tenant-close=422 SA-con-tenant-close=201 SA-sin-tenant-reconcile=422 PATIENT-close=403 CASHIER-reconcile=403
       ADMIN-A-con-X-Tenant-B=403 query ?tenantId=403 id-no-uuid=400 SA-listado-sin-tenant=422 token-vencido=401 refresh-como-access=401
FORMA: listado [paymentIntentId, ageMs, canReconcile]; cierre [paymentIntentId, statusConceptId]; conciliar [id, paymentIntentId, amount, statusConceptId, gatewayTransactionRef, gateway]
```
Además, del spec del implementador (ejecutado, 24 suites unitarias en verde): sin token 401, token con otro secreto 401, PATIENT/CASHIER 403, admin acotado a otro tenant 403, y la intención del tenant B desde el tenant A ⇒ **404 idéntico a «no existe»** (mismo `reason` y `message`, sin `details`) en `reconcile` y `close`, sin tocar la intención. En el servicio real sobre PostgreSQL: `close` de otro tenant ⇒ 404 `PAYMENT_INTENT_NOT_FOUND`, igual que un UUID inexistente.
- **El único fallo de mi corrida** (`1 failed, 619 passed`) es una expectativa errónea de mi arnés: la clave `__proto__` del cuerpo se descarta en silencio y la petición, válida, cierra la intención; no encontré contaminación de prototipo.
- **`close` no contacta la pasarela:** 0 llamadas durante los cierres (incluidos los rechazados). **Solo cierra reservas que ya requieren conciliación:** fresca ⇒ 409 `PAYMENT_GATEWAY_DISPATCH_IN_FLIGHT`; sin reserva o con `pi_` ⇒ 409 `NOTHING_TO_RECONCILE`. Salvedad: D8.
- **Doble `close`:** el segundo también devuelve 201 (D12).
- **Inyección en logs y PHI:** el motivo va en un CAMPO del objeto de log (`reason`), con un mensaje fijo; los saltos de línea, secuencias ANSI y U+2028 no pueden forjar entradas (pino serializa el objeto). El valor registrado no coincidió con el enviado byte a byte (la tubería lo transforma); no profundicé. Riesgo residual: el motivo es texto libre del operador en un log `warn` y la DTO solo *pide* «sin datos personales», sin validarlo (regla 90.2.1) — y es lo único que registra el porqué: la auditoría `@Audited` sella acción, entidad, usuario y fecha pero no el cuerpo (D11).
- **Orphan tras `close` (CONFIRMADO ejecutando):** el cobro de A existe en la pasarela y **0** intenciones locales lo referencian ⇒ su webhook terminal responderá 404 (reintentos de la pasarela, entregas muertas) y **no puede reabrir la deuda**; no queda en ninguna cola ni alerta (D13).

## D3 — `parseProblem` estricto (CONFIRMADO ejecutando, `rev4-problem.spec.ts`)

```text
catalogo: 23 codigos; no reconocidos: []   (cada uno construido con problem() de contracts/packages/problem, serializado y parseado)
```
Con errores de campo (`validation_failed`) y sin campos opcionales (`idempotency_key_reused`) también se reconocen. NO se reconocen: JSON con solo `code`, sin `type`, `type` de otro dominio (`urn:sandbox:mockbank:…`), `status` fuera de 400–599 o string, `code` en mayúsculas, `title` vacío, arreglos. Límite (inherente): un cuerpo ajeno que imita la forma COMPLETA del contrato se reconocería; no hay autenticidad (la pasarela real firma con `content-type: application/problem+json`, que el cliente no exige). Verificación contra `contracts/schemas/problem.schema.json`: coinciden `required`, patrones y rango de `status`; el cliente no impone `additionalProperties:false`.

## D4 — marcas sin fecha / futuras (CONFIRMADO ejecutando)

```text
listado: formato-antiguo={"ageMs":null,"canReconcile":false}; fecha-futura-lejana={"ageMs":null,"canReconcile":false}; futura<5min=no listada
close:   formato-antiguo=201; futura-lejana=201; futura<5min=409 DISPATCH_IN_FLIGHT; reconcile del antiguo (ya cancelada)=422 PAYMENT_INTENT_CANCELED
```
Coherente: lo ilegible se lista y se cierra a mano; una deriva de hasta 5 min se trata como reciente.

## D11–D13 (MENOR)
- **D11:** el motivo obligatorio se satisface con basura (`12345678901234`, `{"a":…}` ⇒ `"[object Object]"`, probablemente 10 espacios): exigir `@Matches(/\S{3,}/)` y desactivar la conversión implícita para este campo; guardarlo además en la auditoría o en una columna/historial de la intención (hoy solo en el log).
- **D12:** `close` repetido y sin cupo de despachos. `PaymentsTransactionsService.closeGatewayDispatch` usa `runCommitted` (2.ª conexión con RLS) sin pasar por `acquireDispatchSlot`; es una ruta de administración de bajo volumen, pero conviene acotarla o hacerla idempotente (responder 200/409 si ya está `CANCELED`).
- **D13:** ver arriba; alerta/consumidor de los terminales 404 y de la métrica `payments_gateway_dispatch_reconciled_total{outcome="closed_manually"}`.

## Higiene del delta
- Sin `sk_live_`/`sk_test_`/`whsec_` nuevos; sin `console.*`, `TODO`, `FIXME`, `.only`, `.skip`. Sin restos de mutaciones (la guarda `reservedOnly`, `classifyInFlight` y `assertRiskCleared` están con el sentido esperado).
- Specs: ningún spec anterior a `4e64353a` figura como modificado. Líneas eliminadas del delta: los dos tests P9 "no impide recuperar…" (invertidos por D1, con su control), un `createRiskAssessment` de un doble (reemplazado), y una aserción de `dispatchMarkAgeMs` con fecha +1 h (`toBe(0)`) que cambia por el rango de deriva de 5 min (D4): cambios de contrato declarados, no debilitamientos.
- PHI en logs: los logs/métricas nuevos llevan ids, `actorUserId`, `reason` (texto libre del operador, ver D11) y etiquetas cerradas. Sin datos de pacientes ni de pagadores en las respuestas (formas exactas arriba).
- Cobertura: `payments-gateway-dispatches.authz.http.spec.ts` y los tests nuevos pasan; `jest src/modules/payments` 24 suites en verde salvo mi test mal planteado; el int-spec del carril y el mío 101/101.

## No cubierto
- No levanté `AppModule`: la cadena de guards es real (spec HTTP con `JwtAuthGuard`, `TenantScopeGuard`, `RolesGuard`, `TenantContextInterceptor`) pero los repositorios son en memoria; los casos de dinero (D1, D8, D9) usaron PostgreSQL real, con RLS simulado como antes.
- No ejecuté el receptor de webhooks tras el `close` (D13 se apoya en que no hay fila con ese `pi_` y en la lectura del receptor).
- Todo contra el doble de la pasarela, no contra `pay-edge`; el cuerpo de problema real se verificó contra el catálogo y el esquema, no contra una respuesta viva.
- No probé D11 con 10 espacios ni la tubería exacta que transforma el motivo.
- No revisé el consumo de la métrica ni si hay SDK/exportador OTel conectado.

## Decisiones y ambigüedades
- Severidad de D8: MAYOR (no BLOQUEANTE) porque requiere un administrador cerrando justo durante un reintento, pero es 100 % determinista dentro de la ventana, es dinero, y el arreglo es acotado. Si se prefiere BLOQUEANTE para encender el flag con `close` habilitado, también es defendible; la alternativa de mitigación operativa es no desplegar la ruta `close` hasta cerrar D8/D9.
- Severidad de D9 supone que el flujo por sesión de checkout es el principal; si el front solo usa `sourceRef = payment_debt` baja a MENOR (a confirmar con quien defina el flujo de cobro del front).
