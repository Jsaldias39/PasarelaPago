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
