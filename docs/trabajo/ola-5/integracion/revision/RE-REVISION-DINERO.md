# Re-revisión adversarial (dinero) — correcciones de REVISION-DINERO F1…F8

- Revisor: agente independiente, distinto de quien escribió `REVISION-DINERO.md` y de quienes corrigieron. SOLO LECTURA sobre el árbol principal (no se editó ni se commiteó nada del código). Las sondas se corrieron en un `git worktree` aparte (ya borrado); sus fuentes quedaron en [`RE-REVISION-DINERO.evidencia/`](./RE-REVISION-DINERO.evidencia/).
- Rama `claude/adoring-allen-ly7r6f`, árbol limpio al revisar (HEAD `6f2b029`/`87cec6d`). Reglas de referencia: CLAUDE.md 4 a 11 (en especial la 11).
- Etiquetas: **CONFIRMADO** = lo ejecuté y vi el resultado. **INFERENCIA** = sale de leer código/documentación, no se ejecutó.
- Stack usado: Postgres 16 y svix-server 1.104.0 reales (ya levantados), Temporal en proceso del arnés de pruebas. NATS no estaba levantado: **nada del consumidor NATS se ejecutó**.

## Conclusión (léase primero)

| Pregunta | Respuesta |
|---|---|
| ¿Seguro desplegar con `RISK_ALLOW_BELOW_THRESHOLD=false` (defecto)? | **Sí, en lo que toca a pay-payments/riesgo**: no encontré ningún camino que conceda `allow` ni pase a cobro sin una decisión `allow` con `screened:true` (ver A-ok). Con el flag apagado todo error cierra `failed/risk_unavailable` (en ~13,5 s con 5xx, ~17 s con timeouts, medido). **Con dos reservas ajenas al flag**: R-1 (el reconciliador de Svix puede borrar endpoints legítimos tras una restauración de base, F-B1) y R-2 (los consumidores NATS dejan de entregar un evento a las 20 entregas, F-B2). Ninguna mueve dinero; ambas pueden hacer que un comercio no reciba sus webhooks. |
| ¿Con `RISK_ALLOW_BELOW_THRESHOLD=true` (y umbral > 0)? | **No.** Dos hallazgos propios de la franquicia: **F-A1 (BLOQUEANTE para encenderla)**: con el breaker abierto un pagador sancionado pasa sin evaluación (CONFIRMADO) y **no queda ninguna constancia** de que se renunció al cribado (F-A2, MAYOR). El flag solo hace algo si además `RISK_FAIL_CLOSED_THRESHOLD_MINOR > 0` (con el defecto 0 es inerte: `amount >= 0` siempre cierra). |
| ¿Qué falta? | 1) Que la franquicia no se active por `circuit_open` (o que exija una sonda propia), y que deje constancia/métrica cuando concede (F-A1, F-A2). 2) Que el reconciliador de Svix **deshabilite** en vez de borrar, o que no borre en `live` sin confirmación (F-B1). 3) `max_deliver` y un manejo de `MAX_DELIVERIES` en los consumidores NATS (F-B2). 4) Un chequeo de arranque/readiness que verifique que los guardianes `*_immutable` existen en la base desplegada y un procedimiento para aplicarlos en bases ya creadas (F-D1). El resto son MENORES. |

## Resumen por severidad

| # | Sev. | Punto | Hallazgo | Estado |
|---|---|---|---|---|
| F-A1 | **BLOQUEANTE** (solo con el flag encendido) | a | La franquicia se activa por `circuit_open` aunque el breaker lo hayan abierto los 5xx de OTROS cobros y riesgo ya esté sano: un pagador sancionado pasa sin evaluación durante la ventana abierta (10 s por defecto), y cualquier pico de 5xx de pay-risk la abre | CONFIRMADO (sonda A) |
| F-A2 | MAYOR (solo con el flag encendido) | a | La franquicia concede `proceed:true` sin dejar constancia, evento, métrica ni log: no hay rastro de qué cobros se aprobaron sin cribado, así que no se pueden re-cribar después | CONFIRMADO (sonda A: `constancias: []`) + lectura de `activities.ts:264-271` |
| F-B1 | MAYOR | b | Tras restaurar la base de pay-webhooks, el reconciliador borra (irreversible, el secreto se pierde) los endpoints propios creados después del punto de restauración si son ≤ tope (5 por defecto) | CONFIRMADO (sonda B: 3 de 3 borrados) |
| F-B2 | MAYOR (operativo, no mueve dinero) | b | `max_deliver: 20` + `nak` de 2 s / 60 s: una caída de Svix de ~1 a 7 min, un 401/403 sostenido ~10 a 20 min o una deriva (`EngineDriftError`, ~1 min) deja los eventos sin entregar para siempre (sin reentrega automática). La descripción de F8 («redelivery sin fin») no era cierta | INFERENCIA (semántica documentada de JetStream; NATS no se ejecutó) |
| F-D1 | MAYOR (despliegue) | d | Los guardianes solo existen en bases creadas con el DDL nuevo: `sandbox-migrate` «si ya tiene tablas no toca nada» y ningún servicio verifica al arrancar que `*_immutable` existen. Una base ya desplegada queda sin guardián y nada lo detecta | CONFIRMADO por lectura (`sandbox-migrate.mjs:36-40`); grep de `pg_trigger` en `src/`: vacío |
| F-A3 | MENOR | a | Errores que no son `UpstreamError` (cuerpo cortado tras los headers, `201` con cuerpo vacío) nunca cierran el intento: reintento de Temporal, escalada y bucle cada 30 s con el intento en `processing`; fail-closed pero inconsistente con el resto (que cierra a los ~13 s) | CONFIRMADO (sonda C: sigue `processing`, 12 llamadas, constancia `risk_unknown`, sin cargo) |
| F-A4 | MENOR | a | `connectionNeverEstablished` acepta `EHOSTUNREACH`/`ENETUNREACH` sin comprobar `cause.syscall === 'connect'`; un ICMP en una conexión ya establecida podría reportarse así. Acotado por el timeout de 300 ms (vence mucho antes que el TCP) | INFERENCIA |
| F-A5 | MENOR (disponibilidad) | a | Con el flag apagado, una conexión rechazada o un `circuit_open` en el 1.er intento cierra el cobro AL INSTANTE sin reintentar; igual cualquier 4xx con `code` (p. ej. 429 `rate_limited`, 401). Un parpadeo de 10 s de riesgo mata todos los cobros concurrentes. Es fail-closed (seguro), pero el 429 es un «no se evaluó» que se podría reintentar | INFERENCIA |
| F-B3 | MENOR | b | `SQLSTATE = /^[0-9A-Z]{5}$/` también acepta `EPIPE`, `EBADF`, `ELOOP` (códigos de Node); además un `FATAL 57P01` (terminación administrativa) puede llegar después de un COMMIT aplicado. La relectura de la fila antes de borrar lo contiene | CONFIRMADO (la regex, `node -e`); el resto INFERENCIA |
| F-B4 | MENOR | b | El reconciliador solo recorre comercios con ≥ 1 endpoint local (`byMerchant`): los huérfanos de un comercio sin ninguno no se miran (seguro, pero deja endpoints vivos que siguen recibiendo eventos) | CONFIRMADO (sonda B: `merchants:0`, endpoint sigue vivo) |
| F-B5 | MENOR | b | Dos despliegues con el MISMO `WEBHOOKS_SVIX_NAMESPACE` sobre un Svix compartido (p. ej. una copia de producción en staging que conserva el valor) no se distinguen; solo se impide `live == sandbox` | INFERENCIA (documentado como no cubierto) |
| F-C1 | MENOR (informativo) | c | El 409 por `refund_id` no puede provocar doble reembolso desde pay-payments, pero sí un cierre `failed` con retención anulada si OTRA clave hubiera movido el dinero del mismo `re_X`; pay-payments nunca usa dos claves para un mismo `re_X` | INFERENCIA |
| F-C2 | MENOR (latente) | c | Filas `failed/connector_unavailable` CON referencia que existan de antes de F6 (sandbox) se reabren y reenvían en el siguiente envío | INFERENCIA |
| F-C3 | MENOR (cosmético) | c | En pay-payments `refundFailureCode` no conoce `rejected_by_provider`: el evento público `refund.failed` lo publica como `internal_error` | INFERENCIA (lectura de `emit.ts:10,24`) |

Sin hallazgo (con lo que intenté): F1/F3/F7 salvo lo anterior, F4/F6 en su pregunta central, triggers append-only salvo F-D1. Detalle abajo.

---

## (a) F1 / F3 / F7 — pay-payments

### A-ok. Qué intenté para romper «ninguna ambigüedad concede `allow`» y no pude

Camino único a `proceed:true`: `activities.ts:238` (`decision==='allow'` con `screened:true`) y la franquicia (`:264-271`). Recorrido de cada resultado ambiguo del enunciado, con flag encendido y monto bajo el umbral:

| Resultado | Cómo llega a `assessRisk` | Resultado | Estado |
|---|---|---|---|
| Timeout puro | `UpstreamError(timeout)`, `provenNotReached=false` (`http.ts:40`) | `isRiskInFlight` ⇒ reintento misma clave; agotado ⇒ cierra `risk_unavailable` con constancia | Correcto. Tests `ola5.risk-franchise.spec.ts` F1-A (66/66 verdes en mi corrida) |
| Timeout y, en el MISMO `request()`, 503 / `circuit_open` / conexión rechazada | `request()` marca `withEarlierAttempt()` (`http.ts:190-192`); la marca se arrastra en 3 pasadas | ambiguo | Correcto (lectura + `risk-ambiguity.http.spec.ts`) |
| 5xx, `unexpected_response` (4xx sin cuerpo del contrato, 2xx ilegible) | `provenNotReached=false` | en vuelo | Correcto |
| Corte de socket tras aceptar (`UND_ERR_SOCKET`/`ECONNRESET`) | `network` sin `notReached` | en vuelo | Correcto. Verifiqué la forma real del error en Node 22.22: `cause.code === 'UND_ERR_SOCKET'` (no está en el conjunto) |
| Cuerpo cortado tras los headers 201 | error crudo (no `UpstreamError`) sale de `response.text()` | `throw error` (`activities.ts:272`) ⇒ Temporal reintenta; nunca franquicia | Seguro pero ver F-A3 |
| `409 idempotency_request_in_progress` | `UpstreamRejection` | en vuelo | Correcto |
| `review/screened:false` no definitivo; `allow/screened:false` | `RiskScreeningUnavailable` | en vuelo (F7 cerrado) | Correcto. `pay-risk/src/rules/engine.ts:61-67` confirma que el real nunca emite `allow` sin cribar |
| Breaker abierto TRAS un intento previo de la misma actividad | `attempt > 1 && isUpstreamError` (`:252`) | en vuelo | Correcto |
| Breaker abierto TRAS un intento previo de otra RONDA / otra ejecución del workflow | marca `ambiguous:risk_unknown` en `intent_contradictions` (`earlierRoundMayHaveSent`, `:126`) | en vuelo | Correcto salvo el límite que ya declara el código (ver abajo) |
| Reinicio de worker a mitad de la actividad | Temporal reintenta por `StartToClose` ⇒ `attempt` sube | en vuelo | Correcto (por diseño de Temporal; no lo forcé) |

Intentos de ruptura que no dieron resultado: (1) reordenar timeout/503/refused dentro de un `request()`; (2) errores crudos en el 1.er intento seguidos de `ECONNREFUSED` en el 2.º (`attempt>1` ⇒ en vuelo); (3) `attempt` vs `maxAttempts` distintos entre worker que arma el plan y worker que ejecuta (siempre cierra o reintenta, nunca concede); (4) workflow reiniciado por `ALLOW_DUPLICATE_FAILED_ONLY`: el workflow solo falla con errores no reintentables, que `assessRisk` no produce, así que no hay reinicio con una evaluación viva.

Límite residual (ya declarado en `activities.ts:124`, lo confirmo): un `terminate`/`reset` manual del workflow entre el envío y la escalada deja un intento nuevo con `attempt=1` y sin marca ⇒ si en ese momento riesgo da `ECONNREFUSED`, concede. Requiere acción de un operador. Se debe documentar como «no resetear un PaymentWorkflow en `processing` sin mirar `intent_contradictions`».

### F-A1 — BLOQUEANTE solo para encender la franquicia — CONFIRMADO

- Archivos: `http.ts:107-110` (`circuit_open` ⇒ `provenNotReached=true`), `activities.ts:253,264-271`.
- Escenario ejecutado (sonda A, `RE-REVISION-DINERO.evidencia/probe-A-franquicia-breaker.spec.ts.txt`): flag `true`, umbral 1.000.000, `CIRCUIT_FAILURE_THRESHOLD=5`. (1) riesgo en modo `down` (503): 3 cobros abren el breaker. (2) riesgo vuelve a `allow` (sano) con «persona sancionada» en la lista del doble. (3) Un cobro de 10.000 con `payerName = 'Persona Sancionada'` entra dentro de la ventana abierta. Salida literal:
  ```
  PROBE-A resultado B: requires_action llamadas a riesgo por B: 0 breaker: open charge: true constancias: []
  ```
  El cobro del sancionado avanzó a `requires_action` y creó cargo **sin que riesgo recibiera ninguna llamada**.
- Por qué es una ambigüedad convertida en concesión: el breaker se abre por 5xx/red de otros cobros, es decir por resultados que la regla 11 trata como ambiguos; «este request no salió» es cierto, pero lo que se concede es «riesgo no está disponible», cuando puede estar sano (aquí lo estaba). Además es explotable como amplificador: cualquier entrada que haga devolver 5xx a pay-risk durante ~3 peticiones (cribado con un nombre patológico, una carga) abre el breaker para TODOS los cobros bajo el umbral durante `CIRCUIT_RESET_MS` (10 s). Mismo efecto, menor, durante la ventana de la sonda semiabierta (los demás reciben `circuit_open` mientras la sonda vuela).
- Corrección sugerida: no tratar `circuit_open` como «probadamente inalcanzable» para la franquicia (solo conexión rechazada/DNS/red inalcanzable de ESTE request), o exigir que la franquicia haga su propia llamada de sonda con timeout corto; y limitar la franquicia por ventana de tiempo/volumen.

### F-A2 — MAYOR solo con el flag encendido — CONFIRMADO

`activities.ts:270` devuelve `{ proceed: true }` sin `contradictionsRepo.record`, sin log y sin contador. La sonda A lo muestra (`constancias: []`) y el test `ola5.risk-franchise.spec.ts:193` lo afirma como «sin constancia». Sin rastro no se pueden re-cribar a posteriori los cobros aprobados sin sanciones. Corrección: registrar una constancia `risk_waived` (o un evento) con motivo y monto, y exponer un contador; ideal: cribado posterior.
Observación adicional: `config.ts` no prohíbe el flag bajo `PAY_MODE=live` ni exige un reconocimiento explícito (`live-guard.ts` solo mira conectores). `.env.example`, `compose.mock.yml` y `e2e/lib/services.ts` lo fijan en `false`.

### F-A3 — MENOR — CONFIRMADO

Sonda C: RISK_URL apunta a un servidor que contesta `201` con `content-length: 500`, escribe 20 bytes y corta. Estado a los 12 s: `processing`, 12 llamadas a riesgo, constancia `['risk_unknown']`, sin cargo (`PROBE-C estado: processing hits: 12 cargo: false constancias: [ 'risk_unknown' ]`). Es fail-closed y escala, pero el intento no se cierra nunca mientras riesgo siga así (bucle de `untilResolved` cada 30 s), a diferencia de los `UpstreamError` que cierran a los ~13 s. Causa: `exchange()` (`http.ts:234`) lee `response.text()` fuera del `try` que envuelve en `UpstreamError`, así que un abort/corte durante el cuerpo sale como `TypeError`/`DOMException` crudos (además sin pasar por el breaker). Corrección: envolver la lectura del cuerpo y clasificarla como `network`/`timeout` ambiguos.

### F-A4 — MENOR — INFERENCIA

Verifiqué en Node 22.22 la forma real: `ECONNREFUSED` y `ENOTFOUND` traen `cause.syscall` = `connect`/`getaddrinfo`; el puerto 1 produce «bad port» sin `code` (ambiguo, conservador); `[::1]` sin IPv6 da `EAFNOSUPPORT` (fuera del conjunto: ambiguo, conservador); un corte tras aceptar da `UND_ERR_SOCKET`. Todo falla hacia lo seguro. El único hueco teórico es `EHOSTUNREACH`/`ENETUNREACH` reportado por una conexión ya establecida tras agotar retransmisiones (Linux usa el error blando del ICMP); el timeout del cliente (300 ms; 2 s en e2e) vence antes. Añadir `cause.syscall` ∈ {`connect`, `getaddrinfo`} lo elimina.

### F-A5 — MENOR (disponibilidad) — INFERENCIA

Con flag apagado, `activities.ts:264-269` cierra al instante ante `provenNotReached` en el 1.er intento (la ronda y el intento 1 no tienen «en vuelo» que proteger) y `:257-262` cierra ante cualquier `UpstreamRejection` (incluido `429 rate_limited`, `problem.filter.ts:40`). Seguro, pero un reinicio de pay-risk de unos segundos o una ráfaga de 429 falla definitivamente los cobros concurrentes. Reintentar con la misma clave cuando es `ECONNREFUSED`/`circuit_open`/429 y cerrar al agotar sería igual de seguro con el flag apagado.

### Pregunta: ¿cuánto tarda en fallar un pago con riesgo caído? — CONFIRMADO (política por defecto: 6 intentos, 500 ms→5 s, timeout de riesgo 300 ms)

```
PROBE-B down: failed 13548 ms llamadas: 12 [ 'risk_unresolved' ]
PROBE-B hang: failed 17031 ms llamadas: 12 [ 'risk_unresolved' ]
```
~13,5 s con 5xx y ~17 s con timeouts (el agente dijo ~12 s; el cálculo es 0,5+1+2+4+5=12,5 s de esperas + 6 × hasta 0,65 s). Es aceptable para un cobro sin dinero movido: el `POST` ya respondió (`CREATE_WAIT_MS` 8 s) y el cobro se cierra `failed/risk_unavailable` con constancia. Nota: ocupa 6 ranuras de actividad por cobro durante ese tiempo; sin tope de concurrencia contra un riesgo colgado (ya anotado en F3 original).

### Pregunta: breaker semiabierto — CONFIRMADO por lectura y tests (4 suites, 66/66 en mi corrida)

`http.ts:82-137`: una sonda vencida por timeout deja `probeInconclusive=true` (solo si `openedAt` no cambió durante la sonda) y el semiabierto deja pasar todas las llamadas; el primer éxito cierra; una falla real (red/5xx) reabre y limpia la marca. Intenté: sondas concurrentes con reapertura intermedia (la marca no se fija sobre un `openedAt` distinto), éxito tras reapertura, error crudo en la sonda (no toca el estado). No reintroduce el defecto original: los timeouts nunca cuentan ni abren (`ignoreTimeouts`), así que los propios reintentos no abren el breaker. Efecto secundario aceptado: semiabierto + riesgo colgado ⇒ ya no hay límite de concurrencia hacia riesgo (igual que en cerrado).

---

## (b) F2 / F5 / F8 — pay-webhooks

### F-B1 — MAYOR — CONFIRMADO

- Archivo: `svix-reconciler.ts:186-196,204-227`; defaults `config.ts:172-190` (gracia 10 min, margen 60 s, tope 5).
- Sonda B (`probe-B-restauracion-svix.spec.ts.txt`, Svix 1.104.0 y Postgres reales, `now` adelantado 11 min 5 s, namespace `live-prod`): 3 comercios, cada uno con un endpoint anterior al «respaldo» (con fila) y uno posterior (sin fila, con la marca propia). Salida:
  ```
  PROBE-RESTORE {"merchants":3,"endpoints":3,...,"orphansDeleted":3,"orphansWithheld":0,"notOwnedUnknown":0,...} postRestore aún vivos: 0
  ```
  Con 6 comercios, el tope frena: `orphansDeleted:0, orphansWithheld:6`.
- La marca distingue entornos, no «alta revertida» de «alta posterior al respaldo». Un Svix recién abierto a producción tiene pocos comercios: el tope de 5 no protege justo cuando importa. Borrar es irreversible (el secreto vive solo en Svix y en el comercio). Ya está declarado en `INFORME.md §9` y DT-42; lo confirmo y lo subo a MAYOR porque se ejecutó.
- Corrección sugerida: en vez de `deleteEndpoint`, `setEndpointDisabled(true)` + alerta (reversible; el borrado lo decide una persona), o default `MAX_ORPHAN_DELETES=0` en `live`.

### Respuestas a las preguntas de (b)

- **Endpoints sin marca**: nunca se borran (`:189`); queda el defecto contrario (se acumulan). Sonda B no lo cubre, el spec `svix-reconciler-guards.spec.ts` sí (INVÁLIDO: sin marca y de otro entorno no se tocan).
- **Dos despliegues con el mismo namespace**: F-B5, no detectado. Otro caso real: restaurar prod en staging y dejar el mismo `WEBHOOKS_SVIX_NAMESPACE` y el mismo Svix. Una marca por despliegue (id del clúster de base) lo cerraría.
- **Carrera con un alta en curso**: la edad exige `grace + margin` y se relee la fila (`:218`) antes de cada borrado. El arranque valida `grace ≥` peor caso del alta (`config.ts:172-178`), 8,9 < 10 min con defectos. Ventana restante: un alta que pasa más de ~11 min entre `createEndpoint` y su COMMIT (bloqueo de fila prolongado) sería borrada y la fila quedaría sin contraparte. No la reproduje; es muy improbable.
- **Reloj**: la edad usa `Date.parse(svix.createdAt)` vs reloj local más 60 s de margen; un Svix atrasado más de 60 s adelantaría la edad percibida. Un reloj adelantado la reduce (seguro). Aceptable.
- **F-B4**: comercios sin endpoints locales no se recorren (sonda B, tercer caso: `merchants:0`, el endpoint sigue vivo). Seguro; queda trabajo manual.
- **Borrado compensatorio** (`endpoint.service.ts:129-144`, `svix-engine.ts:132`): no puede borrar el endpoint de otra petición idempotente porque el `we_…` se genera DENTRO de cada ejecución (`randomBytes(10)` en `:108`) y solo se borra el propio `record.id`; una ejecución que perdió el bloqueo (`LOST_LOCK`) borra el suyo, no el de la que ganó. Tampoco puede estar «en uso»: `publish` consulta SU tabla (`enabledEndpointsFor`) y el comercio no tiene aún el secreto. Doble salvaguarda: se relee `SELECT 1 FROM webhook_endpoints WHERE id=$1` por el pool antes de borrar. Debilidad menor F-B3: la regex de SQLSTATE acepta `EPIPE`/`EBADF`/`ELOOP` (verificado: `EPIPE:true EBADF:true ELOOP:true 40001:true 57P01:true ECONNRESET:false`); en la práctica un `EPIPE` al escribir el COMMIT significa que no se entregó, y un `57P01` posterior a un COMMIT aplicado lo contiene la relectura. Mejor comprobar `error.name === 'error'`/`severity` de `pg`.
- **404 → recrear** (`svix-engine.ts:181-196`): correcto que no crea mensaje si faltan endpoints (deriva); el costo es F-B2.

### F-B2 — MAYOR (operativo) — INFERENCIA

- Archivos: `event-consumer.ts:80` (`max_deliver: 20`), `:117` (`nak(60_000)`), `:121` (`nak(2_000)`), `:88-95` (halt).
- Semántica de JetStream: `max_deliver` cuenta cada reenvío por `nak` o por falta de ack; al llegar a 20 el mensaje deja de entregarse a ese consumidor (queda en el stream; sale un aviso `MAX_DELIVERIES` que nadie escucha: grep sin coincidencias). Esto vale para TODA falla transitoria del motor, no solo 401/403:
  - Svix caído/lento: cada entrega cuesta ~2 s (nak) + hasta 4 intentos del cliente ⇒ ≈ 70 s con conexión rechazada y ≈ 7 min con timeouts de 5 s ⇒ los eventos de esa ventana quedan varados.
  - 401/403: nak 60 s + pausa 30 s ⇒ ≈ 20 ciclos ≈ 10–25 min; además, al hacer `halt` los hasta 49 mensajes ya leídos vuelven tras `ack_wait` (30 s por defecto) y cuentan una entrega más cada ciclo.
  - `EngineDriftError`: nak 2 s ⇒ ≈ 40–60 s, y la deriva exige una persona.
- Lo corregido por F8 sí evita el reintento a ciegas contra un 4xx definitivo, pero la premisa «redelivery sin fin» era falsa: el límite real es 20. El propio informe lo lista como no cubierto (§9, «No cubierto», `max_deliver`).
- El mismo patrón `max_deliver: 20` está en los consumidores de pay-payments, pay-settlement, pay-edge y pay-schedules (grep). En pay-payments el sondeo `inquireCharge` es la red de seguridad; en el resto no lo verifiqué.
- No lo ejecuté (NATS no estaba levantado). Corrección sugerida: `max_deliver: -1` con `backoff` creciente para errores de motor (los venenosos ya se `term`), o publicar una alerta/reproceso al recibir `MAX_DELIVERIES`; ojo: `consumers.add` no actualiza un durable ya existente.

---

## (c) F4 / F6 — pay-connectors, y qué hace pay-payments

Ejecutado: `services/pay-connectors/test/refunds-hallazgos.spec.ts` → 15/15 verdes.

### ¿El 409 por choque de `refund_id` es seguro para pay-payments? — Sí en la práctica

- pay-payments envía SIEMPRE `Idempotency-Key = ${refundId}:refund` y `refund_id = refundId` (`activities-money.ts:61`): una sola clave por `re_X`. El choque F4 exige DOS claves con el mismo `re_X`, que pay-payments no produce.
- Si de todos modos llegara el 409: `ConnectorsClient.createRefund` lo devuelve como `{ok:false,status:409,code}` (`connectors.client.ts:111`) ⇒ `refundAtConnector` retorna `failed` ⇒ `RefundWorkflow` ejecuta `failRefund(…, voidHold=true)` (`workflows.ts` cierre «Rechazo DEFINITIVO»). **No reintenta con otra clave y no crea un segundo reembolso**; anula la retención y marca fallido. Es el mismo manejo que ya tenía el 409 del `INSERT` (`refunds.service.ts:62-65`), así que F4 no añade comportamiento nuevo.
- F-C1 (informativo): el único daño posible es el inverso, que otra clave haya movido el dinero de ese `re_X` y pay-payments lo cierre fallido con la retención anulada. No es alcanzable desde pay-payments; sí lo sería desde un segundo llamador con el mismo `refund_id` (el índice es por `(pay_mode, refund_id)`, la idempotencia por `(caller|mode, key)`).
- Mecánica verificada: el `23505` ocurre dentro de `ctx.atomic`; se lanza `ProblemError` 409, `atomic` hace `ROLLBACK`, la fila sigue `failed` sin reclamo, y la clave guarda el 409 (4xx) y lo repite. Nada sale al banco (`provenUnsent`).

### ¿`rejected_by_provider` puede dejar una retención sin anular o romper eventos? — No encontré camino

- Retención: `workflows.ts` anula la retención para CUALQUIER `result.status==='failed'` independientemente del código (`failureCode ?? 'connector_unavailable'`); `rejected_by_provider` solo cambia el código.
- Contratos: `internal-connectors-v1.yaml:446` lo declara; el evento `connector.transaction.status_changed` lo mapea con `eventFailureCode()` a `validation_failed` (`status-map.ts:19-23`), válido en el enum (`connectors.yaml:466-474`), y NUNCA a `connector_unavailable` (que era el engaño de F6).
- F-C3: `refundFailureCode` (`pay-payments/src/events/emit.ts:24`) lo publica como `internal_error` en `refund.failed` (ya pasaba con `validation_failed`). Cosmético.
- F-C2: filas anteriores a F6 con código del proveedor `connector_unavailable` y referencia se reabren en el siguiente envío (`refunds.service.ts:123` solo reconoce como resueltas las que NO llevan el literal). Solo bases de sandbox ya existentes.

---

## (d) Guardianes append-only

### Camino legítimo con UPDATE/DELETE/TRUNCATE sobre las 9 tablas — no encontré ninguno

- grep multilínea sobre todo el árbol (sin `node_modules`/`dist`/`docs`) de `UPDATE|DELETE FROM|TRUNCATE` sobre las 9 tablas: la única coincidencia es un comentario en `pay-ledger/sql/ddl.sql:291`. Sentencias dinámicas (`UPDATE ${…}`): ninguna en `src/`. `DO UPDATE` en `src/`: solo sobre tablas réplica/estado (pay-edge, pay-payments, pay-schedules, pay-settlement `merchant`/`watermark`), ninguna de las nueve. FKs con `ON DELETE/UPDATE CASCADE|SET NULL` en `services/*/sql`: ninguna (una cascada dispararía el trigger por fila).
- Reconciliación, reversos, limpieza: los reversos son `INSERT` de asientos inversos; la única limpieza con `DELETE` en `src/` es `idempotency_keys` (`contracts/packages/idempotency/src/index.ts:156,167`), sin guardián. Seeds: `sandbox-migrate.mjs` solo aplica DDL en bases vacías; nunca borra ni trunca.
- Mockbank hace `TRUNCATE mb_*` (`bank.service.ts:82`): tablas propias, no las nueve.

### `deleteFromImmutable` desde `src/` — No

Vive en `test/helpers/immutable.ts`, `test/support/immutable.ts` y `test/immutable.ts`. Cada servicio compila con `tsconfig.build.json` (`rootDir: "src"`, `include: ["src"]`): importar `../test/...` desde `src/` falla con TS6059 y `dist/` no lo contiene. Matiz: el rol de la aplicación es DUEÑO de sus tablas (`sandbox-migrate.mjs` aplica DDL con ese rol), así que `ALTER TABLE … DISABLE TRIGGER` le está permitido: el guardián frena SQL accidental, no a código que decida apagarlo (lo declara `P2/INFORME.md §8`).

### ¿Sobreviven a `pg_dump`/restauración? — Sí — CONFIRMADO

Con el DDL de pay-ledger en un esquema descartable: `pg_dump -n … -Fc`, renombrado del esquema original y `pg_restore` en la misma base ⇒ `4 *_immutable` y `4 *_no_truncate` presentes, habilitados (`tgenabled=O`) y `forbid_mutation()` restaurada. No probé `--data-only`/`--disable-triggers` (requiere superusuario; con él se apagan los triggers de usuario durante la carga y se rearman) ni réplica lógica (los triggers de fila no se disparan en el suscriptor por defecto).

### F-D1 — MAYOR (despliegue) — CONFIRMADO por lectura

- `platform/scripts/sandbox-migrate.mjs:36-40`: «ya tiene N tablas, no se toca». Ninguna base creada antes de ola 5 recibe los triggers, y no existe ningún mecanismo de migración (los servicios no aplican DDL al arrancar). En `services/*/src` no hay ninguna consulta a `pg_trigger`/`information_schema.triggers`, ni en `/health/ready`. Resultado: las pruebas pasan (cada suite crea su esquema con el DDL nuevo) y la base desplegada puede no tener el guardián sin que nada lo avise.
- Como el bloque de triggers del DDL es idempotente (`DROP TRIGGER IF EXISTS` + `CREATE`), se puede reaplicar a mano a una base viva. Falta: el procedimiento escrito, y una verificación de arranque/readiness ("las 9 tablas tienen `_immutable` y `_no_truncate` habilitados"). Relacionado con el punto 97.2 de las reglas de la casa (verificación de deriva).
- Otros "no cubierto" que confirmo sin añadir nada: sin procedimiento para correcciones de un DBA, y sin vía de retención (`settlement_audit`, `reveal_audit`, `connector_api_attempts`), decisión abierta.

---

## Qué no cubrí

- Consumidor NATS real (F-B2 es inferencia por semántica de JetStream). Temporal real (solo el arnés en proceso). `e2e/`. Rol real de la aplicación vs. superusuario en los triggers. DNS rebinding contra Svix. Un reinicio real de worker a mitad de actividad. `pg_restore --data-only --disable-triggers`.
- No ejecuté las suites completas, solo: pay-payments `risk-ambiguity.http`, `risk-breaker.timeouts`, `ola5.risk-franchise`, `ola3.risk-inflight` (66/66), pay-connectors `refunds-hallazgos` (15/15) y mis tres sondas (A, B/restauración y C/cuerpo cortado; la C no se archivó como fuente).

## Limpieza

Worktree de sondas borrado (`git worktree remove --force` + `prune`); no se tocó el árbol principal ni los contenedores; las bases de prueba de las sondas se descartaron con el propio arnés; el esquema de la prueba de `pg_dump` se eliminó (`DROP SCHEMA … CASCADE`).
