# Verificación del delta 3 `b881a4f15..3a2b56836` — carril INT, `mantra-core-health-api` (última ronda)

- Revisora: la misma 3.ª revisora ([VERIFICACION-DELTA-2-API-INT.md](./VERIFICACION-DELTA-2-API-INT.md) → D8 a D13). SOLO LECTURA sobre `/home/user/mantra-core-health-api`; todo lo ejecutable corrió en un `git worktree` aparte (borrado, `git worktree prune` hecho) bajo `flock /tmp/pay-heavy.lock`, de a uno. Bases y roles `mantra_it_rev5*`: 0 y 0 al terminar. Ningún comando superó los 10 min.
- Evidencia: [`VERIFICACION-DELTA-3-API-INT.evidencia/`](./VERIFICACION-DELTA-3-API-INT.evidencia/) (`rev5-charge.int-spec.ts`, `rev5-b1-rls.int-spec.ts`, `rev5-dto.spec.ts` y las salidas `salida-f1…f6`). Nota: `salida-f1` incluye 3 fallos que son defectos de MI arnés (un escenario de dos marcas obtenido jugando el despacho, que la compuerta impide; y una columna inexistente en una consulta mía); se corrigieron y repitieron en `f3`/`f4`/`f5`/`f6`.
- Cada hallazgo dice si lo **CONFIRMÉ ejecutando** o es **INFERENCIA**.

## Conclusión única

**D8 y D9 están cerrados. No encontré ningún MAYOR nuevo.** Encontré un MENOR nuevo (D14: un `40P01` en dos cierres simultáneos sobre una misma deuda, una superposición que la API no deja crear) y varios MENOR de uso. **INT.M3 se puede marcar HECHO** con `RLS_ENFORCE=true` y con `false` **con las limitaciones declaradas** de abajo (la principal: D10, el DECLINE registrado durante el vuelo no detiene el cobro en curso; y el cobro huérfano tras un cierre queda solo en la cola de conciliación y en un contador, sin alerta conectada).

### Limitaciones que hay que declarar al marcar HECHO
1. **D10 (límite abierto, documentado):** un DECLINE registrado mientras el primer envío está en vuelo responde 201 pero el cobro en curso se asocia y sigue pagable. Se mitiga con la cola de conciliación; no se elimina. (Y el test de carrera D1 se relajó a "ningún POST con un DECLINE registrado ANTES de reservar": cambio coherente con D10, no un descuido.)
2. **Cobro huérfano tras `close` o tras un cierre cruzado:** su `pi_` queda sin QR entregado (nadie puede pagarlo), expira solo en la pasarela y, si se paga igual, cae en `processed=false` (cola de conciliación); un `pi_` sin intención da 404 en el receptor. Existen contadores (`payments_gateway_webhook_unknown_terminal_total`, `…reconciliation_required_total{reason}`), pero **no verifiqué que haya exportador/alerta de métricas conectados**: sin eso nadie se entera.
3. **Capacidad con `RLS_ENFORCE=true`:** tope de despachos y cierres simultáneos por proceso `ceil(DB_POOL_MAX/2)-1` (4 con el pool por defecto); el resto recibe 503 `PAYMENT_GATEWAY_BUSY` reintentable.
4. Todo se probó contra el doble de la pasarela y con RLS simulado (sin `AppModule`); no se probó contra `pay-edge` ni con HTTP real extremo a extremo.

## Resumen por severidad

| Sev. | # | Hallazgo | Prueba |
|---|---|---|---|
| (cerrado) | D8 | `close` ya no cancela un reintento en vuelo; `associate` no entrega QR a una intención no abierta | CONFIRMADO ejecutando (72 rondas de matriz + calado) |
| (cerrado) | D9 | `close` expira las sesiones de la intención y devuelve la deuda a PENDING; m6 respetado; el receptor no regresó | CONFIRMADO ejecutando |
| MENOR | D14 | Dos `close` simultáneos de intenciones distintas con sesión sobre la MISMA deuda: `40P01` en 19 de 20 rondas con `RLS_ENFORCE=false` (0 de 20 con `true`); la superposición no se puede crear por la API | CONFIRMADO ejecutando (sembrando las marcas por SQL); causa raíz no aislada |
| MENOR | D15 | El motivo (D11) rechaza texto legítimo en español: `#`, `—`, comillas tipográficas `“ ”`, `’`, `…`, `@`, `&`, `+`, `°`, `$`; y sigue siendo texto libre en un log `warn` (puede llevar un nombre) | CONFIRMADO ejecutando |
| MENOR | D16 | Un cierre fallido (409 `ALREADY_CLOSED`, `IN_FLIGHT`…) deja un sello de auditoría `success:false` (comportamiento del interceptor); no es un segundo cierre, pero hay que saberlo al leer la auditoría | Lectura de `audit-trail.interceptor.ts` |
| Informativo | D10 | Sigue abierto y documentado (ver arriba) | CONFIRMADO en la ronda anterior |

---

## D8 — cerrado (CONFIRMADO ejecutando; `rev5-charge.int-spec.ts`, rol `NOBYPASSRLS` con la política real para `RLS_ENFORCE=true`)

**Matriz:** latencias de la pasarela 150 / 400 / 1500 ms × `close` arrancando a 0 / 60 / 150 ms del reintento × {el cobro ya existía (replay), el primer envío nunca llegó (el reintento crea)} × 2 rondas = 36 rondas por modo, ambos modos, con `Promise.all([reintento, close])`:

```text
RLS_ENFORCE=false: 36 rondas; violaciones=0; {"retry=ok | close=409 PAYMENT_GATEWAY_DISPATCH_IN_FLIGHT | A=PENDING/pi_ | B=409 DEBT_HAS_OPEN_CHARGE | vivos=1": 36}
RLS_ENFORCE=true : 36 rondas; violaciones=0; {mismo resultado: 36}
```
Antes (b881a4f15): 100 % de las rondas dejaban `A=CANCELED/pi_` con el QR entregado y 2 cobros vivos. Ahora el reintento termina bien, `close` responde 409, la intención sigue abierta con su `pi_` y la deuda sigue bloqueada para B. "Violación" = intención CANCELED con el reintento entregado, o QR entregado más otro cobro de la deuda: 0 en 72 rondas.

**Borde de `updated_at` (CONFIRMADO):** marca vieja y `updated_at` fresco ⇒ 409 `IN_FLIGHT`; a 14 min ⇒ 409; a 16 min ⇒ 201 (el plazo es `dispatchLeaseMs` = 15 min).

**Reintento "calado"** (llamada HTTP en vuelo más larga que el plazo; lo simulé envejeciendo `updated_at` y cerrando desde dentro de la llamada), ambos modos:
```text
close=201; reintento (HTTP en vuelo)=409 RECONCILIATION_REQUIRED; A=CANCELED/pi_… (pi_ persistido=true); B=ok;
reintento posterior de A=422 PAYMENT_INTENT_CANCELED; reconcile de A=422 PAYMENT_INTENT_CANCELED; listada=false; cobros vivos=2
```
`associate` guarda el `pi_` siempre (para que su webhook se resuelva a una intención) pero devuelve `open:false` y `dispatch` lanza 409 sin `nextAction`: el cobro de A existe y **nadie recibe su QR**; B cobra el suyo; el reintento y la conciliación posteriores de A responden 422 (la intención está cancelada).

**Otras vías por las que podría salir el QR de una intención cancelada:** (a) la respuesta de creación: cerrada arriba; (b) el reintento propio con `pi_` asociado (`consult`): el estado de la intención se comprueba (`assertIntentOpen`) antes de llegar a `consult` ⇒ 422 (CONFIRMADO, "reintento posterior de A"); (c) la conciliación: misma compuerta ⇒ 422 (CONFIRMADO). No encontré una cuarta.

**El pago de ese huérfano, si ocurriera (`rev5-b1-rls.int-spec.ts` REV5-W1, rol `NOBYPASSRLS`):** un `succeeded` del `pi_` asociado a una intención `CANCELED` ⇒ `applied:false, decision:contradiccion, reconciliationRequired:true`, evento archivado con `processed=false`, deuda intacta (`IN_CHECKOUT`, `outstanding 150.000000`). Un terminal de un `pi_` sin intención ⇒ 404 `PAYMENT_INTENT_NOT_FOUND` (y ahora incrementa `payments_gateway_webhook_unknown_terminal_total`; no leí el contador).

## D9 — cerrado (CONFIRMADO ejecutando, ambos modos)

```text
sesión real:  close=201; deuda=PENDING sesiones=EXPIRED
m6:           close de A=201; deuda=IN_CHECKOUT sesiones=EXPIRED+OPEN        (la sesión abierta de otra intención mantiene el checkout)
dos close sobre la misma deuda, ambos con sesión: deuda=PENDING sesiones=EXPIRED+EXPIRED
```
`releaseCheckoutForIntent` (`payments-checkout-release.ts`) es la lógica del receptor extraída tal cual (misma lista de bloqueos: intención → sesiones de la intención → deuda; sin `FOR UPDATE` sobre las sesiones de otras intenciones). **El receptor no regresó:** `rev5-b1-rls` (las 18 pruebas heredadas, incluida REV-11 de 40 rondas y REV3-12 de 80, con `errores: {}`), `payments-gateway-webhook` y `payments-gateway-webhook-rls` del repo, y los unitarios del receptor, todos en verde.

### D14 — MENOR: `40P01` en dos cierres simultáneos sobre una misma deuda
- **CONFIRMADO ejecutando** (`rev5-charge.int-spec.ts`, 20 rondas de dos `close` simultáneos de intenciones distintas con sesión abierta sobre la misma deuda): con `RLS_ENFORCE=false`, 19 de 20 rondas dan un `40P01 deadlock detected` en uno de los dos (el otro 201); con `RLS_ENFORCE=true`, 0 de 20. El detalle de PostgreSQL: dos procesos esperándose mutuamente, el que cae "while locking tuple (0,3) in relation payment_debts". No aislé la causa raíz (la secuencia de sentencias es la prevista: intención → sesiones de la intención → deuda con `FOR UPDATE`, y luego los `UPDATE`); la diferencia entre modos sugiere dependencia de los tiempos.
- **Por qué es MENOR:** (a) el servidor revierte y el cierre se puede repetir (no hay pérdida ni dinero); (b) **la superposición no se puede crear por la API**: dos intenciones con reserva vencida sobre la misma deuda exigen que la compuerta haya dejado pasar a la segunda (la marca de la primera la bloquea mientras siga abierta) y el checkout rechaza una segunda sesión sobre una deuda `IN_CHECKOUT`; tuve que sembrar las marcas por SQL; (c) es una ruta administrativa de bajo volumen. El receptor, que comparte la misma función, no se ve afectado (REV-11 y REV3-12: 0 errores). Conviene aislarlo (p. ej. bloquear la deuda ANTES que las sesiones en `close`, o tomar un bloqueo consultivo por deuda) y capturar el `40P01` como 409 reintentable.

## D11 — motivo (CONFIRMADO ejecutando; `rev5-dto.spec.ts`, `plainToInstance` + `validate`)

Rechaza lo que debía: número, objeto, JSON como texto, solo dígitos, solo espacios, símbolos, 9 letras, 301 caracteres. Acepta: 10 letras, 300 letras, texto con tildes y ñ, `¿ ? ¡ !`, paréntesis, comillas rectas, saltos de línea y con espacios a los costados (se recorta). Coste de la expresión con 1 MB de entrada: 0,7 a 3,7 ms (sin riesgo de ReDoS).

**D15 (MENOR):** también rechaza texto razonable en español: `#4521`, el guion largo `—`, las comillas tipográficas `“ ”` y `’` (las que insertan los teclados móviles y los procesadores de texto), `…`, `@` (un correo), `&`, `+`, `°` (N°), `$`. El mensaje de error lo explica, pero va a frustrar a quien pega texto. Si se quiere mantener la defensa contra JSON, basta rechazar `{ } [ ] < > \` y `\\` y aceptar el resto. Además el motivo sigue siendo texto libre en un log `warn` junto al `actorUserId`: nada impide escribir un nombre de paciente (regla 90.2.1); el DTO solo lo *pide* (y la validación de letras no lo detecta).

## D12 — segundo cierre y cupo (CONFIRMADO ejecutando)
```text
doble close:   201 / 409 PAYMENT_GATEWAY_DISPATCH_ALREADY_CLOSED
4 close simultáneos, RLS, pool=4 (límite 1): ["503 BUSY","503 BUSY","503 BUSY","201"]
```
El segundo cierre ya no vuelve a cancelar ni a cerrar nada. En cuanto a la auditoría: el interceptor sella un intento fallido como `success:false` (`audit-trail.interceptor.ts`, rama `catch`), así que el 409 deja su propio sello de fallo, no un segundo sello de éxito (D16). El cierre pasa por el cupo de despachos (con transacción de petición).

## D13 — contadores (lectura)
`payments_gateway_webhook_unknown_terminal_total` (sin etiquetas) en el receptor, antes de lanzar el 404; y la razón `charge_on_closed_intent` en `…reconciliation_required_total`; `…reconciled_total{outcome="closed_manually"}`. Verifiqué el punto de incremento, no que el SDK de OpenTelemetry tenga exportador.

## Higiene del delta
- Sin literales `sk_live_`/`sk_test_`/`whsec_` nuevos; sin `console.*`, `TODO`, `FIXME`, `.only`, `.skip`. Sin restos de mutaciones: la guarda `idleMs >= leaseMs` y `open` en `associate` tienen el sentido correcto (comprobado por el comportamiento de arriba).
- Specs: ningún spec anterior a `4e64353a` figura como modificado. Del delta se eliminaron: (a) en el int-spec de cobro, la descripción y el criterio del test de carrera D1 ("ningún POST con un DECLINE ya registrado" → "…registrado ANTES de reservar"), que **es una relajación de aserción** coherente con aceptar D10 (declarada en el commit, pero cuenta para `NO_TEST_WEAKENING` y debe quedar escrita en la decisión de D10); (b) un `UPDATE` de la marca por una función auxiliar (`ageReservation`) y el `resetIntent` del spec HTTP, reescritos para el nuevo criterio de actividad.
- PHI: los logs/contadores nuevos llevan ids, `actorUserId`, `reason` (texto libre, ver D15) y etiquetas cerradas; sin datos de pacientes en las respuestas.
- Verde: `jest src/modules/payments` 24 suites / 620 tests (incluye `rev5-dto`); int-specs `payments-gateway-charge`, `payments-gateway-webhook` y `payments-gateway-webhook-rls` del repo, y mi `rev5-b1-rls`, en verde.

## No cubierto
- No levanté `AppModule` ni el interceptor real (RLS simulado con la misma secuencia). Tampoco ejercité una transacción de petición real con pool pequeño para `close` salvo el caso de 4 simultáneos.
- Todo contra el doble HTTP de la pasarela; no contra `pay-edge`.
- No aislé la causa raíz del `40P01` de D14 ni probé `close` ‖ webhook de otra intención sobre la misma deuda (es una superposición que la API tampoco permite crear).
- No verifiqué el exportador/alerta de métricas ni la lectura de los contadores.
- No probé la reconciliación manual contra una pasarela real tras un `close` (no existe una API de anulación de la pasarela en este carril).

## Decisiones y ambigüedades
- "HECHO" se propone con las limitaciones de arriba; si quien aprueba exige alerta operativa conectada como parte de HECHO (la regla 11 habla de escalar a una persona), esa parte queda pendiente y debería ir a un issue del repo de la API, no a este informe.
- La severidad de D14 es MENOR porque la superposición solo se logra sembrando datos; si el negocio planea habilitar varios checkouts por deuda, se vuelve MAYOR.
