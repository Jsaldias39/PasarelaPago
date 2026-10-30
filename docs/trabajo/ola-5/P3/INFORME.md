> **AVANCE: F1 (A, B, C), F3 y F7 de `REVISION-DINERO.md` corregidos con rojo→verde y mutación.** Peldaño: `TESTED` (suite completa ×2 + e2e dirigidos contra el stack real; riesgo es un doble declarado en las pruebas de `pay-payments`, el e2e usa `pay-risk` real). Sin commit (lo hace el integrador).

# P3 · ola 5 · cierre de F1, F3 y F7 (riesgo y dinero)

## Causa y arreglo

| Hallazgo | Causa | Arreglo (archivo) |
|---|---|---|
| F1-A | `HttpClient.request` lanzaba solo el ÚLTIMO error: un timeout (la evaluación llegó y sigue viva) seguido de un 503 dentro del mismo intento se veía como 5xx «puro» | `src/clients/http.ts`: `UpstreamError.provenNotReached` y `earlierAttemptMayHaveReached`; `request()` recuerda las llamadas anteriores ambiguas y las marca en el error final (incluido `circuit_open` y «conexión rechazada» posteriores) |
| F1-B | `assessRisk` trataba 5xx y `unexpected_response` como «no hay evaluación» | `src/temporal/activities.ts`: `isRiskInFlight` = todo `UpstreamError` que NO prueba «no llegó». «No llegó» solo si conexión rechazada / DNS / red inalcanzable (`connectionNeverEstablished`, lista cerrada de códigos; AggregateError solo si TODAS las direcciones) o breaker abierto. Un corte de socket (ECONNRESET, UND_ERR_SOCKET) es ambiguo |
| F1-C | `attempt` vuelve a 1 en una ronda nueva de la actividad | `earlierRoundMayHaveSent`: la constancia `ambiguous:risk_unknown` que deja el workflow al agotar una ronda sobrevive a reinicios; si existe, el primer intento se trata como «pudo haber un previo» |
| F3 | Con `ignoreTimeouts`, una sonda semiabierta vencida dejaba una sola sonda a la vez y el resto recibía `circuit_open` sin salir | `http.ts` `CircuitBreaker.probeInconclusive`: una sonda vencida no es concluyente y el semiabierto deja pasar las llamadas hasta la primera respuesta concluyente (éxito cierra, falla real reabre). Un timeout sigue sin contar ni abrir |
| F7 | `allow` con `screened:false` se concedía | `activities.ts` `isUnscreenedAllow` ⇒ `RiskScreeningUnavailable` (en vuelo, misma clave; agotado ⇒ `failed/risk_unavailable` con constancia) |

Con la franquicia apagada (defecto) todo sigue fail-closed; se prueba en los mismos casos (`ola5.risk-franchise.spec.ts`, bloque «APAGADA»).

## Evidencia (`evidencia/`)

- Rojo contra el comportamiento viejo: `ROJO-http-unit.txt` (21 de 26 fallan; muchos por la propiedad inexistente, los decisivos son «timeout y luego 503», «timeout y luego rechazada/breaker» y F3) y `ROJO-stack.txt` (11 de 16 fallan con `activities.ts` de HEAD: el cobro pasaba por la franquicia y quedaba en `requires_action`, o riesgo lo denegaba después).
- Verde: `VERDE-http-unit.txt`, `VERDE-dirigidos.txt` (6 suites, 123 pruebas).
- Mutaciones (`MUTACIONES.txt`): M1 olvidar llamadas previas (4 fallan), M2 toda red = «no llegó» (4), M6 F3 (1), M3 5xx = «no hay evaluación» (7), M4 sin detección de ronda previa (1), M5 allow sin cribar concedido (3). Restauradas: 0 marcas `MUT-`.
- Gates: `GATE-typecheck.txt`, `GATE-build.txt`, `GATE-test-1.txt` y `GATE-test-2.txt` (36 suites / 489 pruebas, exit 0 las dos), `GATE-eslint.txt` (`yarn eslint services/pay-payments`, exit 0).
- E2E aislados con el stack real: `E2E-risk-timeout-{1,2,3}.txt` (3/3), `E2E-traza-jaeger.txt` (6/6), `E2E-e1.txt` (2/2).

## Tests existentes que cambiaron (explicados, no debilitados)

1. `ola3.risk-inflight.spec.ts`, «riesgo caído con un 5xx puro ⇒ el cobro PASA»: afirmaba el «comportamiento previo, documentado» que F1-B declara contrario a la regla 11. Ahora afirma lo contrario (más estricto): failed/risk_unavailable, sin cargo, con constancia y ≥ 4 llamadas con la misma clave. El caso positivo de la franquicia (conexión rechazada) está en `ola5.risk-franchise.spec.ts`.
2. `doubles/doubles.spec.ts` y `risk.double.ts`: con `requireScreening=false` el doble respondía `allow` con `screened:false`, que `internal-risk-v1` (líneas 27 y 215) y `pay-risk/src/rules/engine.ts:61-67` descartan. Ahora responde `allow` con `screened:true`. Sin este cambio `ola2.tanda2c` (que depende de ese `allow`) fallaría por F7.
3. El doble de riesgo ganó los modos `script`, `unexpected`, `allow_unscreened` y `unscreenedAllowFirst` (declarados en su doc).

## Decisiones y ambigüedades (a quién confirmarlas)

- **Un 5xx con la franquicia apagada ya no cierra al instante**: se reintenta con la misma clave hasta `ACTIVITY_MAX_ATTEMPTS` (backoff ≈ 12 s en producción) y cierra `failed/risk_unavailable` con constancia `risk_unresolved`. Es lo que pide la regla 11, pero cambia la latencia ante una caída de pay-risk. Confirmar con P3/producto.
- **F1-C se apoya en la constancia `ambiguous:risk_unknown`** (sin cambiar `workflows.ts` ni el esquema). Si el workflow cambia el `kind` de esa escalada, `ROUND_FAILED_MARKER` debe seguirlo (comentado en el código). Confirmar con el dueño del workflow.
- Docs de la ola 3 (`ola-3/P3/GATES.md` líneas 202 y 205, `ola-2/P3/NOTAS.md:138`) siguen describiendo «5xx puro pasa»; quedan superadas por este informe (fuera de alcance, no se tocaron).

## No cubierto

- F1-C solo se probó sembrando la constancia en la base, no con una ronda real que agote reintentos y luego se reinicie. Límite conocido: si la escalada falló o la ronda se cortó antes de escalar, la consulta no la ve.
- Los e2e no ejercitan franquicia encendida (el arnés la fija en `false`); la franquicia se probó solo con el doble de riesgo y un puerto cerrado.
- Sin prueba contra un DNS real que falle ni contra EHOSTUNREACH/ENETUNREACH reales (solo simulados con `fetch` falso).
- F3: durante la PRIMERA sonda las llamadas concurrentes siguen recibiendo `circuit_open` (es la semántica del semiabierto); se arregla solo lo posterior a una sonda vencida.
- Cambios de propagación de trazas (`inClientSpan`, `x-request-id`) intactos: `trace-propagation.spec.ts` y `traza-jaeger.e2e.ts` en verde.

---

# Re-revisión de dinero (`RE-REVISION-DINERO.md`): F-A1…F-A5 y F-C1…F-C3

Cierra los hallazgos de la franquicia «bajo el umbral pasa» (`RISK_ALLOW_BELOW_THRESHOLD`) y de `assessRisk` que dejó la re-revisión. F-D1 (guardianes en readiness) está en [`../P2/INFORME.md`](../P2/INFORME.md) §9. Sin commit (lo hace el integrador).

## Causa y arreglo

| Hallazgo | Causa | Arreglo (archivo:línea) |
|---|---|---|
| **F-A1** BLOQUEANTE | `circuit_open` valía «probadamente no llegó» y la franquicia se activaba con ello; el breaker lo abren los 5xx de OTROS cobros, así que un pagador sancionado avanzó a `requires_action` sin que riesgo recibiera ni una llamada (sonda A) | Dos pruebas distintas: `provenNotReached` (esta llamada no salió: sigue incluyendo `circuit_open`, y solo sirve para cerrar fail-closed sin esperar) y la NUEVA `provenUnreachable` (esta llamada intentó conectar y la conexión nunca se estableció: rechazada, DNS, red inalcanzable), `src/clients/http.ts` (`UpstreamError`, `request()` y `exchange()`). `assessRisk` concede SOLO con `provenUnreachable` (`src/temporal/activities.ts`, `riskProvenUnreachable` y la rama de la franquicia). Si en el mismo `request()` una pasada fue rechazada y la siguiente recibió `circuit_open`, la prueba de la primera se conserva (`withEarlierRefusal`); si hubo una pasada ambigua, no vale nada |
| **F-A2** MAYOR | La franquicia devolvía `proceed:true` sin constancia, log ni métrica | Antes de conceder: constancia durable `risk_franchise_granted` en `intent_contradictions` (mismo `contradictionsRepo.record` que `ambiguous:risk_unknown`: se publica `payment_intent.contradiction_detected` por outbox y `pay-settlement` abre una excepción de conciliación para re-cribar), motivo `risk_unreachable_below_threshold`, `source_event_id = waived:risk_franchise_granted`, `incoming_status = waived`. Log estructurado `risk_franchise_granted` (solo ids, monto, moneda, umbral; nunca nombres) y contador OTel `pay_payments_risk_franchise_granted_total{currency,method}`. **Si la constancia no se puede escribir, NO se concede**: la excepción sube, Temporal reintenta y el reintento (`attempt > 1`) cierra fail-closed. **Guarda de configuración**: `PAY_MODE=live` con `RISK_ALLOW_BELOW_THRESHOLD=true` ⇒ `loadConfig` lanza y el servicio no arranca (`src/config.ts`), también con el umbral 0. Documentado en `.env.example` y `README.md` del servicio: con `RISK_FAIL_CLOSED_THRESHOLD_MINOR=0` la franquicia no hace nada (`amount >= 0` siempre cierra) |
| **F-A3** MENOR | `response.text()` fuera del `try` de `exchange()`: un cuerpo cortado tras los headers 201 salía como `TypeError` crudo; `assessRisk` lo relanzaba (`throw error`) y Temporal lo reintentaba para siempre con el intento en `processing`. Igual un 2xx con cuerpo vacío (`assessment.decision` sobre `null`) | `http.ts`: la lectura del cuerpo se envuelve en `UpstreamError` (`network` o `timeout`, ambiguo, pasa por el breaker). `risk.client.ts`: un 200/201 sin `decision` legible es `UpstreamError('unexpected_response')`. Ambos entran en «en vuelo» y cierran por la política (≈ 13 s) con `risk_unavailable` + constancia `risk_unresolved` |
| **F-A4** MENOR | `EHOSTUNREACH`/`ENETUNREACH` valían «nunca se estableció» sin mirar el `syscall` (Linux también los da en una conexión ya establecida) | `connectionNeverEstablished` exige `cause.syscall === 'connect'` para esos dos códigos (también dentro de un `AggregateError`) |
| **F-A5** MENOR | Con la franquicia apagada, un 4xx con `code` (p. ej. 429) cerraba el cobro al instante | **Decidido** (ver abajo): el `429 rate_limited` se reintenta con la misma clave dentro de la política (en vuelo); conexión rechazada y `circuit_open` siguen cerrando al instante |
| **F-C3** MENOR | `refundFailureCode` publica `rejected_by_provider` como `internal_error` | **No se mapea**: el enum de `refund.failed` (`contracts/asyncapi/payments.yaml`) no tiene valor equivalente y cambiarlo es un cambio de contrato. Propuesta en [`../P4/PROPUESTAS.md`](../P4/PROPUESTAS.md) PR-3 |
| **F-C1 / F-C2** | Informativos | Solo documentación: [`../P4/PROPUESTAS.md`](../P4/PROPUESTAS.md), «Notas de la re-revisión» |

## Decisiones (a quién confirmarlas)

- **F-A1: elegí exigir prueba positiva de ESTA llamada, y no una sonda directa a riesgo fuera del breaker.** Es lo más simple y lo más seguro: no añade tráfico hacia un riesgo que puede estar sufriendo, no depende de que el breaker «recuerde» por qué se abrió, y no hay estado nuevo. Coste real: mientras el breaker esté abierto, un cobro bajo el umbral con la franquicia encendida cierra `failed/risk_unavailable` en vez de pasar (como con la franquicia apagada); en una caída sostenida de riesgo la franquicia solo cubre a los cobros cuya propia llamada recibe `ECONNREFUSED`/DNS/inalcanzable (los primeros hasta que el breaker se abre, y uno por ventana de reintento). Alternativas descartadas: (a) sonda propia fuera del breaker (omite la protección del breaker para todos los cobros pequeños); (b) que el breaker recuerde que lo abrieron solo rechazos de conexión (más estado, y un riesgo ya recuperado seguiría sin evaluar a un sancionado hasta `CIRCUIT_RESET_MS`). No se limitó la franquicia por ventana/volumen (sugerencia de la re-revisión): no hay un número del negocio (Q-08). Confirmar con producto/riesgo.
- **F-A2: cada concesión abre una excepción de conciliación en `pay-settlement`** (es lo que hace el consumidor de `contradiction_detected` con cualquier `kind`; no se tocó). Es el objetivo (que una persona re-cribe), pero en una caída larga de riesgo con la franquicia encendida el volumen de excepciones sería uno por cobro aprobado. Confirmar con P2 si prefieren un `kind` filtrado o una vista agregada.
- **F-A2: el contador solo se exporta si hay SDK de OpenTelemetry** (`OTEL_EXPORTER_OTLP_ENDPOINT`): `NodeSDK` (0.221) registra un lector OTLP de métricas por defecto; sin endpoint es un no-op. La fuente durable es la constancia (`SELECT count(*) FROM intent_contradictions WHERE kind = 'risk_franchise_granted'`) y el log. No se verificó contra un colector real.
- **F-A2: la guarda rechaza `live` + franquicia aunque el umbral sea 0** (inerte): un interruptor que no debe estar encendido en producción no se deja encender «de adorno». Si el negocio decide algún día admitirla en live, es una decisión registrada y un cambio de esa línea.
- **F-A5 (decidido con criterio, fail-closed intacto).** (1) `429 rate_limited`: pay-risk cortó antes de evaluar (no hay evaluación que contradecir) pero tampoco dijo «no»; se reintenta con la MISMA clave y, agotada la política, cierra `failed/risk_unavailable` con `risk_unresolved`. Ojo: el contrato `internal-risk-v1` no declara el 429 (lo emite el filtro de problemas de pay-risk, `problem.filter.ts:40`, y `common.yaml` lo define); la prueba usa un servidor HTTP a medida, no el doble contractual. (2) Conexión rechazada y `circuit_open` en el primer intento siguen cerrando AL INSTANTE: ahí no hay ninguna ambigüedad que proteger, reintentar retrasaría ~13 s cada cobro y, al agotar, abriría una excepción de conciliación por cada cobro durante una caída de riesgo. Dejado y documentado; si producto prefiere reintentar para absorber un reinicio de pay-risk de unos segundos, es un cambio acotado en `assessRisk` (reintentar mientras `attempt < maxAttempts` y cerrar sin constancia si todos los intentos fueron «no llegó»), pero exige guardar el historial de intentos.
- **F-C3** a P3 (dueño de `payments.yaml`) y a los consumidores de `refund.failed` (`pay-webhooks`, `pay-settlement`, `pay-schedules`): PR-3.

## Tests existentes que cambiaron (explicados, no debilitados)

1. `ola5.risk-franchise.spec.ts`, «correcto (no regresión) · conexión rechazada…»: afirmaba `escalations == []` («sin constancia»), que era precisamente F-A2. Ahora afirma `['risk_franchise_granted']` (más estricto); el resto del caso (requires_action, un cargo, riesgo no alcanzado) no cambió.
2. `risk-ambiguity.http.spec.ts`, `EHOSTUNREACH`/`ENETUNREACH` ⇒ `provenNotReached`: los errores simulados no traían `syscall`; los reales de Node sí (`connect`). Ahora los simulados traen `syscall: 'connect'` y hay casos nuevos que exigen que sin él (o con `read`/`write`) sean ambiguos (F-A4). Se añadió `provenUnreachable` a las expectativas existentes (`true` solo ante rechazo de conexión; `false` en `circuit_open`, `timeout`, etc.).

## Evidencia (`evidencia/`)

- Rojo contra el código de HEAD con las pruebas nuevas: [`ROJO-fa-franquicia-http.txt`](./evidencia/ROJO-fa-franquicia-http.txt) (28 de 63 fallan: la sonda A —el sancionado queda en `requires_action`—, la constancia/log/contador/guarda de F-A2, el cuerpo cortado y el 2xx vacío, el 429 y los casos de `syscall`/`provenUnreachable`).
- Mutaciones (`MUTACIONES-fa.txt`, en un `git worktree` aparte, restauradas): MA1…MA12 (circuit_open = inalcanzable, franquicia sin exigir la prueba, sin conservar la prueba entre pasadas, sin `syscall`, sin constancia, constancia tragada, sin contador, sin log, sin guarda live, `response.text()` sin envolver, 2xx sin decisión, 429 no transitorio). Las 12 dejan al menos una prueba en rojo.
- Verde: `yarn test` de pay-payments 515/515 dos veces (typecheck y build exit 0). pay-ledger 342/342 (2.ª corrida; la 1.ª falló 1 por `deployment.spec.ts` contra la base de desarrollo vieja, ver F-D1 en P2 §9 y abajo). Gates restantes (settlement, vault, connectors, eslint, e2e) EN CURSO al escribir esto: no se afirman.
- Cambio de pruebas por F-D1 (explicado): `pay-ledger/test/deployment.spec.ts` y `pay-settlement/test/deployment.spec.ts` afirmaban `live ⇒ /health/ready 200` contra las bases de desarrollo compartidas, creadas antes de ola 5 y SIN guardianes (el chequeo nuevo las marca: ENVIRONMENT). Ahora corren contra un esquema descartable con el DDL actual (PGOPTIONS, patrón de `pay-connectors/test/startup.spec.ts`) y afirman además `checks`. No se tocaron las bases compartidas (la acción fue denegada); para aplicar el bloque del runbook a ellas hace falta que lo haga una persona.

## No cubierto
- Gates sin terminar al escribir esto (ver el mensaje de entrega). `e2e/flows/live-guard.e2e.ts` (casos nuevos de la guarda) no se ejecutó. Contador OTel no verificado contra un colector real. Sin límite por ventana/volumen de la franquicia. Los 5xx/timeouts no activan la franquicia (intencional).

