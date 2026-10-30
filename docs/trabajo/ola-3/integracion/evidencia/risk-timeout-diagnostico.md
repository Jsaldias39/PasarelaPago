# Diagnóstico de causa raíz — `risk-timeout.e2e.ts` falla ~50 % (ya no pasa 100 %)

> **VEREDICTO: PRODUCT_BUG en `pay-payments` (breaker del cliente de riesgo), disparado por un cambio de ENTORNO que erosionó un margen de 40 ms. No es Watchman lento, no es la política de reintentos agotándose por sí sola y no es un defecto de `pay-risk`.** Peldaño de evidencia: causa `VERIFIED` en runtime (reproducida y aislada: con la causa quitada 6/6 verdes, con ella ~50 % rojo); parche propuesto `TESTED` en una copia fuera del árbol y `VERIFIED` contra el reproductor real con el `dist` parcheado de forma temporal (6/6). **No se commiteó, no se tocó ningún `.ts` del árbol; el parche NO está aplicado.**

- Fecha: 2026-10-28 · Rama: `claude/adoring-allen-ly7r6f` · Máquina: 4 vCPU, una corrida a la vez.
- Archivos de apoyo (scripts y parche) en [`risk-timeout-propuesta/`](./risk-timeout-propuesta/).
- Todo dato es sintético (comercio «COMERCIO RIESGO-TIMEOUT (SINTÉTICO)», montos de 10 000 centavos BOB).

## 0. Resumen en ocho líneas

1. Watchman y la evaluación de `pay-risk` están sanos: Watchman p50 19 ms / p90 27 ms secuencial; una evaluación completa 26–50 ms en caliente, 89 ms la primera, 42–125 ms con 4 simultáneas. Nada cerca del tope de cribado (250 ms, `e2e/lib/services.ts:137`).
2. Cuando el cliente aborta, `pay-risk` **sigue evaluando y guarda el resultado bajo la clave**: el reintento recibe `409 en curso` y luego `200 replay`. No hay aborto de la evaluación. Los 4 `allow` quedaron escritos en la base 0,6 s después de empezar, aun en la corrida que terminó en rojo.
3. El rojo sale de otro sitio: el **circuit breaker de `pay-payments`** (`services/pay-payments/src/clients/http.ts:30-67`, umbral 5, reset 10 s, `retries:1` por llamada). Con `RISK_TIMEOUT_MS=40` las 4 primeras llamadas vencen sí o sí (la evaluación tarda 60–135 ms con 4 simultáneas): son 4 fallas consecutivas. Basta **una quinta** —el reintento interno (a ~90 ms) que reciba su `409`/`200` pasados los 40 ms— para abrir el breaker.
4. Con el breaker abierto, los intentos 2 a 5 de la actividad `assessRisk` fallan en 2–3 ms con `circuit_open`: **no llega ninguna petición a `pay-risk`** (el log de `pay-risk` muestra 5 peticiones en total, no 24) y se gastan los reintentos de Temporal (0,5→1→2→4→5 s ≈ 12,9 s) dentro de la ventana de 10 s del breaker.
5. El intento 6 y último cae con el breaker en `half_open`, que deja pasar **UNA** llamada de prueba (`probing`, `http.ts:50-51`): pasa 1 de los 4 cobros (`succeeded`) y los otros 3 reciben `circuit_open` en su último intento ⇒ `failed/risk_unavailable` (`activities.ts:211-218`). Es exactamente lo visto: «3 `failed` + 1 `succeeded`», o 4 `failed` si la propia prueba vence (tras >10 s ocioso el pool de `pg` de `pay-risk` reabre conexión: +15–25 ms).
6. Las corridas verdes tardan 14–19 s (los reintentos internos llegan a tiempo, el breaker no se abre, convergen en ~3 s); las rojas 43 s (12,9 s de reintentos + el resto del arnés). Coincide con `risk_requests_seen`: 12 peticiones en las verdes, 5–6 en las rojas.
7. Qué cambió: el margen. La 5.ª falla depende de si el camino «409 en curso»/replay de `pay-risk` responde en <40 ms: medido, 20–50 ms con `pay-risk` recién arrancado (5 de 6 arranques en frío tuvieron al menos un reintento vencido) y 28–34 ms en caliente con 4 simultáneas; 6–11 ms el replay. Reinicio de Docker, Postgres y cachés fríos y `warmUp:false` empujaron esa distribución sobre el umbral de 40 ms. Lo que **no** se puede demostrar es la latencia de «hace una hora» (no hay medición previa de ese camino): ese punto queda como hipótesis (ver §6).
8. **Recomendación (una): parche en `services/pay-payments` (P3) — el cliente de riesgo no cuenta los `timeout` como fallas del breaker (`ignoreTimeouts`), con su test.** El reproductor no se toca y su requisito (`succeeded` ×4) queda intacto.

## 1. Latencia hoy de una evaluación completa (máquina quieta) — pregunta 1

Watchman directo (`GET :54084/v2/search?type=business&minMatch=0.8&limit=5`, script `wm.mjs` fuera del producto):

```text
secuencial n=30 min=12 p50=19 p90=27 max=67 ms   status [ 200 ]
concurrente 2 n=2 min=40 p50=43 p90=43 max=43 ms
concurrente 4 n=4 min=59 p50=66 p90=69 max=69 ms
concurrente 8 n=8 min=60 p50=140 p90=159 max=159 ms
```

Watchman atiende casi en serie (4 simultáneas ≈ 4 × 17 ms). Es **más rápido** que lo documentado cuando se hizo el calentamiento (`e2e/lib/warmup.ts`: p50 30 ms / p90 65 ms).

`pay-risk` completo por HTTP (`POST /assessments` con `merchant_name`, arrancado solo con `startStack({only:['pay-risk'], warmUp:false})`, script `probe.mjs`):

```text
E1  primera evaluación en frío (sin abortar)      201 allow screened=true  89 ms
E1b 10 secuenciales en caliente (ms)              50,38,33,40,42,28,30,26,31,26
E1c 4 concurrentes en caliente                    42, 125, 93, 125 ms  (todas 201 allow screened=true)
E3  4 concurrentes: 2.ª llamada @15 ms            409 409 409 409  en 26, 32, 28, 34 ms
    (primeras terminan)                           201 allow en 74, 93, 94, 76 ms
    3.ª llamada = replay                          200 allow  Idempotency-Replayed=true  en 11, 11, 10, 9 ms
```

En el rojo capturado (`e2e/.run/e2emvsd42ocwac`, sondeo de la base de `pay-risk` cada 0,4 s):

```text
17:02:48.709 idem|pi_13a0…:risk|started|started||t        ← 2 de las 4 claves ya reclamadas
17:02:49.295 idem|pi_13a0…:risk|completed|completed|201|f ← las 4 completadas
17:02:49.295 ra |pi_bebaa…:risk|allow|no_limits_configured|t|135   (duration_ms)
17:02:49.295 ra |pi_13a03…:risk|allow|no_limits_configured|t|120
17:02:49.295 ra |pi_28d15…:risk|allow|no_limits_configured|t|133
17:02:49.295 ra |pi_aa99d…:risk|allow|no_limits_configured|t|130
```

Las 4 evaluaciones terminaron `allow`, `screened=true`, en 120–135 ms. No hubo `screening_unavailable` ni rastros `~sin-cribar~`. Ese mismo cobro, 0,4 s después, ya tenía su respuesta guardada; sin embargo el workflow terminó `failed`.

## 2. ¿`pay-risk` sigue evaluando cuando el cliente aborta? — pregunta 2

**Sí, sigue y guarda.** Prueba (`aborto-del-cliente.mjs.txt`, E2b): el cliente aborta a los 5 ms y repite con el MISMO `pi` y la MISMA `Idempotency-Key`:

```text
intento 1 (5ms): {"s":"TimeoutError","ms":10}
reintento 1 {"s":409,"d":"idempotency_request_in_progress","ms":80}
reintento 2 {"s":409,"d":"idempotency_request_in_progress","ms":32}
reintento 3 {"s":200,"d":"allow","screened":true,"ms":9,"replay":"true"}
filas risk_assessments con esa clave: 1|allow/no_limits_configured/screened=true/102ms
idempotency: completed|201
trazas ~sin-cribar~: 0
```

Una sola fila, no una reevaluación desde cero. La lógica:

- `services/pay-risk/src/assessments/assessments.controller.ts:45-66`: el handler no recibe ninguna señal de desconexión del cliente; el log `request aborted` es solo informativo.
- `services/pay-risk/src/assessments/assessments.service.ts:107-138` (`runOnce`): todo corre dentro de `idempotency.execute`; el cribado (`Promise.all` de Watchman) y `ctx.atomic('evaluated', …)` se esperan sin mirar la conexión.
- `contracts/packages/idempotency/src/index.ts:127-143` y `:155-198` (`claim`): la clave queda `started` con `locked_at` y la 2.ª petición recibe `idempotency_request_in_progress` (409) mientras el bloqueo es reciente (`lockTimeoutMs` 30 s, `:187-189`); en `:236` `complete()` guarda la respuesta al terminar el handler.
- Fuera de eso, el cribado tiene su propio tope, no el del cliente: `watchman.screener.ts:45` (`AbortSignal.timeout(screeningTimeoutMs)`, 250 ms en el arnés, 200 por defecto).

Por tanto la hipótesis «si el timeout del cliente < tiempo de evaluación NUNCA converge» **es falsa para `pay-risk`**: con un `pay-payments` sin breaker converge siempre (ver §3, V1).

## 3. Por qué falla: la causa aislada — pregunta 3

### 3.1 Línea de tiempo del rojo (`e2emvsd42ocwac`, literal de los logs)

```text
pay-payments.log (actividad assessRisk, attempt:N, durationMs)
 17:02:48.842 attempt 1  RiskInFlight  152 ms     ← 4 llamadas vencen a los 40 ms
 17:02:49.689 attempt 2  RiskInFlight    3 ms     ← 3 ms ≠ red: es circuit_open
 17:02:50.708 attempt 3  RiskInFlight    3 ms
 17:02:52.724 attempt 4  RiskInFlight    2 ms
 17:02:56.738 attempt 5  RiskInFlight    2 ms
 (intento 6 ≈ 17:03:01.7: ya no es un fallo de actividad, es settle(failed/risk_unavailable))

pay-risk.log (/assessments)
 1793206968.752  aborted   6 ms     ┐
 1793206968.824  aborted  13 ms     │ 5 peticiones en TODA la corrida:
 1793206968.834  aborted  26 ms     │ 4 primeras llamadas + 1 reintento interno
 1793206968.874  aborted  44 ms     │ (después de la 5.ª falla seguida, el breaker se abre)
 1793206968.875  aborted  53 ms     ┘
 1793206981.781  200      22 ms     ← 12,9 s después: la ÚNICA llamada de prueba (half_open); replay OK

resultado: statuses = failed, failed, failed, succeeded     settle = 14,9 s   total = 43 s
```

Nada llegó a `pay-risk` entre `968.875` y `981.781`: 12,9 s de reintentos de Temporal contra un breaker local abierto.

### 3.2 Mecanismo en el código

- `services/pay-payments/src/deps.ts:25`: todo upstream (incluido `pay-risk`) usa `HttpClient` con `retries:1` y el MISMO breaker (`config.ts:146`: umbral 5, reset 10 000 ms).
- `http.ts:59-60`: toda `UpstreamError` (también `timeout`) suma una falla **consecutiva**; a las 5 `openedAt = now`.
- `http.ts:50-51`: `open` ⇒ `circuit_open` al instante; `half_open` deja pasar UNA llamada (`probing`) y rechaza a las demás con `circuit_open`.
- `activities.ts:209-218`: en `attempt > 1` cualquier `UpstreamError` (incluido `circuit_open`) cuenta como «en vuelo» y reintenta, pero en `attempt == maxAttempts` (6) cierra `failed/risk_unavailable`.
- Backoff de la actividad: `initial 500 ms ×2, tope 5 s` ⇒ intentos a ≈ 0, 0,85, 1,9, 3,9, 7,9 y 12,9 s. Breaker abierto a ≈ 0,1 s, `half_open` desde ≈ 10,1 s: **los intentos 2–5 caen en la ventana abierta y el 6.º coincide con el semiabierto de los 4 cobros a la vez**.

### 3.3 Aislamiento (variando UNA cosa, stack real, `variante-stack-real.mjs.txt`)

| Variante (sobre `RISK_TIMEOUT_MS=40`) | Resultado de 4 cobros | Peticiones vistas por `pay-risk` |
|---|---|---|
| Línea base, máquina quieta | `yarn e2e` rojo (3 failed + 1 succeeded, 43 s); 3 corridas: rojo, verde, verde | 6 en la roja / 12 en las verdes |
| Línea base, CPU saturada (4 bucles) | `succeeded,failed,failed,failed` | 5 (4 abortadas + la sonda) |
| **Breaker apagado** (`CIRCUIT_FAILURE_THRESHOLD=100000`), quieta | 4/4 corridas `succeeded ×4`, ~2,6–3,0 s de settle | 11–12 |
| **Breaker apagado, CPU saturada** | 2/2 corridas `succeeded ×4` (4,6 y 4,8 s) | 11 y 15 |
| `CIRCUIT_RESET_MS=2000` | 2/4 corridas verdes (las otras `succeeded,failed,failed,failed` y `succeeded,succeeded,failed,failed`) | 6–12 |
| `RISK_TIMEOUT_MS=300` (valor de producción) | no se corrió en el stack real (ver «No cubierto»); en el emulador del §3.4 el breaker no se abre | — |

Quitar **solo** el breaker convierte ~50 % rojo en 6/6 verde, incluso con CPU saturada, que antes daba rojo siempre. Con el timeout de 40 ms intacto, `pay-risk` intacto y Watchman intacto. Esa es la causa aislada.

### 3.4 Emulación exacta de la actividad con el cliente REAL (`HttpClient`+`RiskClient` de `dist/`, 6 intentos con el backoff de Temporal; `emulador-actividad.mjs.txt`)

Bajo 4 bucles de CPU, 5 rondas × 4 cobros, código original:

```text
original ronda 1: 1/4 convergen en 12.7 s | a1:timeout>a2:circuit_open>a3:circuit_open>a4:circuit_open>a5:circuit_open>a6:allow || …a6:circuit_open || …a6:circuit_open || …a6:circuit_open
original ronda 4: 1/4 convergen en 12.7 s | (igual)
original ronda 5: 0/4 convergen en 12.8 s | …a6:circuit_open ×4        ← la propia sonda venció
original ronda 2, 3: 4/4 convergen en 0.7 s | a1:timeout>a2:allow … (el breaker no se abrió)
original: 10/20 cobros convergen
```

Es la firma completa: `circuit_open` en los intentos 2–5, uno solo pasa el 6.º. Sin carga, pero con `pay-risk` recién arrancado (`latencia-reintento-en-frio.mjs.txt`), el reintento interno de cada cobro (≈ +90 ms):

```text
pay-risk en frío #1: T/44→T/43  T/43→T/41  T/43→T/44  T/43→T/43      <== REINTENTO VENCE
pay-risk en frío #2: T/41→409/33  T/41→T/50  T/41→T/50  T/42→T/50    <== REINTENTO VENCE
pay-risk en frío #3: T/41→409/20  T/41→409/22  T/41→T/43  T/41→T/43  <== REINTENTO VENCE
pay-risk en frío #4: T/41→409/30  T/41→409/30  T/40→409/39  T/40→T/41 <== REINTENTO VENCE
pay-risk en frío #5: T/41→409/24  T/41→409/20  T/41→409/17  T/41→409/21        (sin vencidos)
pay-risk en frío #6: T/42→409/23  T/45→409/28  T/47→T/40  T/47→T/40  <== REINTENTO VENCE
  caliente (20 rondas): 0 con reintento vencido (409 en 28–32 ms, replay 7–11 ms)
```

(`T/44` = vencido a los 44 ms; `409/33` = respondió el 409 en 33 ms). Un 409 que llega a tiempo cuenta como éxito para el breaker y **reinicia** la cuenta; por eso el resultado depende de la carrera ⇒ ~50 %.

Dato adicional (`probe4`): tras >10 s ocioso, el replay de `pay-risk` tarda 22–32 ms (el `Pool` de `pg` descarta conexiones a los 10 s) frente a 6–11 ms. La llamada de prueba del breaker llega por definición ≥10 s después de la última falla, justo cuando eso ocurre; con un timeout de 40 ms queda a ≤18 ms de vencer. Es coherente con las rondas 0/4 (la sonda venció), pero no se midió la sonda individual en esa corrida: hipótesis, no hecho.

## 4. Clasificación (regla 80.4) — pregunta 4

| Clase | ¿Es? | Evidencia |
|---|---|---|
| **`PRODUCT_BUG`** | **Sí (causa)** | El breaker cuenta como falla del servicio un `timeout` del cliente sobre una evaluación idempotente que sigue viva y sana en `pay-risk`; el cobro termina `failed/risk_unavailable` con riesgo disponible y la decisión `allow` ya guardada. Reproducido y aislado (§3.3: breaker apagado ⇒ 6/6; emulador 10/20). Va contra el espíritu de la regla 11 (un timeout no prueba que no se ejecutó). |
| `ENVIRONMENT` | Sí (disparador, no causa) | El margen entre el tiempo de respuesta del camino 409/replay (20–50 ms en frío) y el timeout de 40 ms se agotó tras el reinicio de Docker (Postgres/Watchman/`pay-risk` en frío, caché de páginas vacía). No es Watchman (p50 19 ms, más rápido que el documentado), ni Temporal (los 7854 workflows huérfanos ya no están y la cola es por corrida). |
| `TEST_BUG` | No | El requisito del reproductor es válido y no se debe debilitar: `succeeded` ×4. El `RISK_TIMEOUT_MS=40` y `warmUp:false` son la intención declarada del reproductor (forzar la ventana y medir el arranque en frío). |
| `DATA` | No | Datos sintéticos limpios; las 4 evaluaciones `allow/no_limits_configured`. |

Se descartaron con evidencia: (a) «Watchman lento» (§1); (b) «`pay-risk` aborta la evaluación» (§2); (c) «política de reintentos agotada» como causa independiente: con el breaker apagado la misma política (6 intentos, ~12,9 s) converge en 3 s.

## 5. Recomendación única y parche (NO aplicado)

**Qué cambiar y dónde:** `services/pay-payments` (P3). El cliente de riesgo se construye con un breaker que **no cuenta los `timeout`** como fallas (la red y los 5xx siguen contando). El reproductor queda como está.

Parche completo en [`risk-timeout-propuesta/parche-ignore-timeouts.diff`](./risk-timeout-propuesta/parche-ignore-timeouts.diff) (`git apply --check -p1` limpio sobre el árbol actual; 2 archivos de producción, ~14 líneas con comentarios):

```diff
--- a/services/pay-payments/src/clients/http.ts
+++ b/services/pay-payments/src/clients/http.ts
@@ export interface BreakerOptions {
   readonly failureThreshold: number;
   readonly resetAfterMs: number;
+  /**
+   * `true`: un `timeout` NO cuenta como falla de la dependencia. Para llamadas idempotentes cuya operación sigue viva en el servidor cuando el cliente
+   * se va (riesgo: …el reintento con la misma clave recibe el 409 «en curso» y luego la respuesta guardada). Un timeout ahí es un
+   * resultado AMBIGUO, no un fallo (CLAUDE.md regla 11); contarlo abre el breaker con los propios reintentos y corta el paso hacia un servicio sano.
+   * La red y los 5xx siguen contando.
+   */
+  readonly ignoreTimeouts?: boolean;
   readonly now?: () => number;
@@ CircuitBreaker.exec
-      if (error instanceof UpstreamError) {
+      if (error instanceof UpstreamError && !(this.options.ignoreTimeouts && error.kind === 'timeout')) {
         this.failures += 1;
--- a/services/pay-payments/src/deps.ts
+++ b/services/pay-payments/src/deps.ts
-  const http = (name: string, upstream: { baseUrl: string; timeoutMs: number }) => new HttpClient({ …, retries: 1, breaker });
+  const http = (name: string, upstream: { baseUrl: string; timeoutMs: number }, options: { ignoreTimeouts?: boolean } = {}) =>
+    new HttpClient({ …, retries: 1, breaker: { ...breaker, ...options } });
-      risk: new RiskClient(http('pay-risk', config.upstream.risk)),
+      risk: new RiskClient(http('pay-risk', config.upstream.risk, { ignoreTimeouts: true })),
```

**Test** (separado, sin tocar los existentes): [`risk-timeout-propuesta/risk-breaker.timeouts.spec.ts.txt`](./risk-timeout-propuesta/risk-breaker.timeouts.spec.ts.txt) → `services/pay-payments/test/risk-breaker.timeouts.spec.ts`. Tres niveles (regla 65):

- correcto: 50 timeouts seguidos no abren el breaker;
- límite: 4 fallas reales + 100 timeouts no abren, la 5.ª falla real abre (los timeouts no inflan ni reinician la cuenta);
- inválido/control: red y 5xx siguen abriendo (riesgo caído de verdad), y sin la opción un timeout cuenta como siempre (comportamiento de los demás upstreams);
- integración con el cliente real contra un servidor local lento (evaluación 150 ms, `409` de 60 ms, timeout 40 ms, 4 cobros): con la opción el breaker queda `closed` y la 2.ª vuelta recibe `allow` ×4; sin ella el breaker queda `open` y la 2.ª vuelta da `circuit_open` ×4 (control negativo del defecto).

Resultados (copia de `services/pay-payments` fuera del repo, `node_modules`/`contracts`/`sql` enlazados):

```text
SIN el parche (rojo):  Tests: 3 failed, 1 passed, 4 total      (kind "circuit_open" ≠ "timeout"; state "open" ≠ "closed")
CON el parche (verde): test/risk-breaker.timeouts.spec.ts  Tests: 4 passed
CON el parche, existentes: test/doubles/doubles.spec.ts (incl. 4 de «circuit breaker y política de reintentos»)  + nuevo: Tests: 36 passed, 2 suites passed
CON el parche: test/ola3.risk-inflight.spec.ts (integración real: Postgres + Temporal, incluye el test del breaker abierto por timeouts): Tests: 20 passed (42 s)
CON el parche: tsc -p tsconfig.json --noEmit en la copia: sin errores
```

Contra el producto real, el reproductor sin tocarlo, con los dos `.js` compilados del parche cambiados temporalmente en `services/pay-payments/dist/` (carpeta ignorada por git; respaldados y restaurados, `sha256` idéntico):

```text
yarn e2e e2e/flows/risk-timeout.e2e.ts  (máquina quieta)         ×4:  Tests: 1 passed  (30.6 s, 18.5 s, 18.1 s, 17.4 s)
yarn e2e e2e/flows/risk-timeout.e2e.ts  (4 bucles de CPU)        ×2:  Tests: 1 passed  (28.0 s, 33.7 s)
dist RESTAURADO idéntico
```

Alternativas evaluadas y descartadas, con la prueba:

| Alternativa | Por qué no |
|---|---|
| Bajar `CIRCUIT_RESET_MS` (config, sin código) | `CIRCUIT_RESET_MS=2000`: 2 de 4 corridas rojas. Reduce la ventana pero el semiabierto sigue admitiendo una sola llamada. |
| Que el semiabierto espere a la llamada de prueba en vez de rechazar a las demás | Emulador bajo carga: 20/24 (la ronda en que la propia sonda vence sigue dando 0/4) y rompe el contrato probado en `doubles.spec.ts` («solo deja pasar UNA llamada de prueba a la vez»). |
| No cerrar `failed` en el último intento si fue `circuit_open` (escalar y reintentar despacio) | Contradice la política documentada de P3 («NUNCA queda en `processing`»); es una decisión de producto, y converge en 12,9 s + 30 s de `slowRetryMs`, fuera de los 30 s del reproductor. |
| Subir `RISK_TIMEOUT_MS` o `warmUp:true` en el reproductor | Haría pasar el reproductor ocultando el defecto: es justo el escenario que debe cubrir. Prohibido (regla 80.5.2). |
| Tocar `pay-risk` | No hay defecto: evalúa, guarda y repite correctamente. |

Riesgo residual del parche (declarado): si `pay-risk` se cuelga (todas las llamadas vencen), el breaker ya no corta por timeouts; el acotado lo da la política de la actividad (6 intentos × ≤2 llamadas de `RISK_TIMEOUT_MS`) y el cierre `failed/risk_unavailable` se mantiene; red y 5xx siguen abriendo el breaker. Otros upstreams con la misma forma (p. ej. `createCharge` de `pay-connectors`) NO se tocan: quedan fuera de alcance.

## 6. No cubierto y supuestos

- **«Por qué pasaba hace una hora» no está medido directamente.** No hay registro previo de la latencia del camino 409/replay; la explicación (margen de 40 ms erosionado por arranque en frío) es consistente con 5/6 arranques en frío con un reintento vencido y 0/20 en caliente, pero es una hipótesis sobre el pasado. La causa del rojo de hoy sí está demostrada. Cuando pasaba (`P3/evidencia/3e-e2e-risk-timeout.txt`: 1 passed en 17,986 s) el breaker no llegó a abrirse.
- `RISK_TIMEOUT_MS=300` (producción) no se corrió en el stack real. En producción abrir el breaker exige 5 fallas seguidas de red/5xx/timeout; con el parche solo las dos primeras cuentan.
- No se corrió la suite completa de `pay-payments` ni `yarn lint` sobre el test propuesto; sí `tsc` en la copia y las dos suites de arriba.
- La prueba de integración del test usa un servidor HTTP local, no el doble `RiskDouble`; si se prefiere, se puede portar a `test/doubles/`.
- Observación fuera de alcance (no se tocó): el `Pool` de `pg` de `pay-risk` (`database.module.ts:44`) reconecta tras 10 s ocioso y suma 15–25 ms al primer replay; relevante para sondas de breaker con timeouts muy cortos.
- Estado al cerrar: sin procesos propios corriendo (bucles de CPU y stacks terminados, `stopStack` limpió bases y streams); `services/pay-payments/dist/` restaurado byte a byte; ningún archivo del producto modificado; sin commit. Se agregaron solo `docs/trabajo/ola-3/integracion/evidencia/risk-timeout-diagnostico.md` y `risk-timeout-propuesta/` (6 archivos).

## 7. Cómo reproducir

```bash
# Rojo con la causa (≈50 %): el reproductor tal cual
yarn e2e e2e/flows/risk-timeout.e2e.ts
# Causa aislada: solo el breaker apagado (6/6 verde)
node --no-warnings variante-stack-real.mjs breaker_off '{"RISK_TIMEOUT_MS":"40","CIRCUIT_FAILURE_THRESHOLD":"100000"}'
# Firma exacta de la actividad con el cliente real (original vs parche)
node --no-warnings emulador-actividad.mjs original 5      # (cwd dentro del repo; NODE_PATH=…/node_modules para «patched»)
```

## Cierre (integrador, distinto de quien diagnosticó y de quien implementó)
Parche aplicado tal cual (`services/pay-payments/src/clients/http.ts`, `src/deps.ts`) y test `services/pay-payments/test/risk-breaker.timeouts.spec.ts` incorporado.
- eslint 0; typecheck 0; build 0; pay-payments: 32 suites / 399 tests verdes.
- `risk-timeout.e2e.ts` aislado: 5/5 verdes en máquina quieta; 1/1 verde con 4 bucles de CPU saturando (antes: rojo siempre en esa condición).
- Suite e2e completa (e2e-corrida-8-completa.txt): 30 suites / 218 tests, 0 fallos.
No cubierto: `RISK_TIMEOUT_MS=300` (valor por defecto) en el stack real; un `pay-risk` colgado del todo ya no corta el breaker por timeouts (lo acota la política de 6 intentos y el cierre `failed/risk_unavailable`).
