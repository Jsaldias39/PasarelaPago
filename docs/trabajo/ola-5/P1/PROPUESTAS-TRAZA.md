# Propuestas · P1.H2.M3 · propagación de la traza (`traceparent`, `request_id`)

> **Ningún servicio ni contrato fue modificado** (`services/` y `contracts/` no se tocaron). Esto reproduce lo que falta, lo clasifica con evidencia y propone el arreglo a quien
> es dueño del código. La prueba que lo respalda es `e2e/pending/traza-jaeger-arbol.e2e.ts` (4 pruebas en rojo a propósito); lo que SÍ funciona está afirmado en
> `e2e/flows/traza-jaeger.e2e.ts` (6 pruebas en verde, 2 corridas).

## Veredicto del DoD de la fila («La traza en Jaeger cruza borde → servicio»)

**PARCIAL.** Medido contra el Jaeger real del Compose (`pay-jaeger-1`), con los 11 servicios exportando OTLP/HTTP:

| Pregunta | Resultado | Evidencia |
|---|---|---|
| ¿Un `traceparent` válido del cliente se continúa en el borde? | **Sí**: el span servidor de `pay-edge` tiene como padre el span del cliente. | `evidencia/traza-jaeger-consulta-api.txt` (A) |
| ¿`pay-payments` cae en la MISMA traza (mismo traceId) cuando el cliente manda `traceparent`? | **Sí**. | ídem (A) |
| ¿El span de `pay-payments` CUELGA de un span del borde? | **No**: su padre es un span-id que ningún servicio exportó (padre ausente). Jaeger lo dibuja como una segunda raíz dentro de la traza. | ídem (A): `PADRE AUSENTE` |
| ¿Sin `traceparent` entrante (lo normal) el borde y `pay-payments` comparten traza? | **No**: dos trazas distintas, una por servicio, para la misma petición. | ídem (B), `evidencia/traza-jaeger-pending.txt` (prueba 2) |
| ¿La traza llega a `pay-risk` / `pay-connectors` / `pay-qr`? | **No**: cada uno abre su propia traza raíz; ninguna contiene a `pay-edge`. | `evidencia/traza-jaeger-flujo-corrida-2.txt` («MEDIDO aguas abajo»), prueba 3 del pendiente |
| ¿El `x-request-id` del cliente llega a los logs del borde y de `pay-payments`? | **Sí** (en ambos, con el id del cliente o el que abre el borde). | flujo, `logsCarry` |
| ¿Y a los servicios aguas abajo? | **No**: `pay-payments` pone un UUID nuevo en cada llamada. | prueba 4 del pendiente; `services/pay-payments/src/clients/http.ts:137` |
| ¿Un `traceparent` malformado, de versión futura o ausente rompe algo? | **No**: 201 siempre, traza nueva, nunca 5xx (7 formas malformadas + versión futura + ausente + `x-request-id` inválido). | flujo |
| ¿Algún span lleva la clave de API, el cuerpo de la petición o un PAN? | **No** (≈ 5.800 trazas / 8.500 spans / 13 MB escaneados en cada corrida; ruta y query con PAN salen `url.path=/v1/payment_intents/:x`, `url.query=[redacted]`). | flujo, prueba SEGURIDAD |

## Clasificación (regla 80.4)

`PRODUCT_BUG` (falta de propagación en el código de los servicios), no `TEST_BUG`, `ENVIRONMENT` ni `DATA`: la prueba reproduce lo mismo en 3 corridas distintas del stack,
con el Jaeger sano y accesible, y los servicios que SÍ reciben un `traceparent` válido lo continúan (`pay-payments` en el caso A). Ninguna causa está en el arnés.

## Causas (con archivo y línea)

1. **El borde inventa el `traceparent` que reenvía** — `services/pay-edge/src/proxy/edge.pipeline.ts:187-192`. `traceparent()` toma del cliente solo el traceId (y solo si el cliente
   manda uno con la forma exacta `00-…`); el span-id lo saca de `randomBytes(8)` y, sin `traceparent` entrante, el traceId también. Nada de eso corresponde a un span real:
   - el span-id inventado no existe en la traza ⇒ el span de `pay-payments` queda con padre ausente (caso A);
   - sin `traceparent` entrante el traceId inventado ≠ el traceId de la propia traza del borde (la abre la instrumentación http) ⇒ **dos trazas por petición** (caso B);
   - con un `traceparent` de versión futura (`01-…`) el SDK lo acepta y el borde no: el borde continúa la traza del cliente pero reenvía otro traceId (se midió: «el borde CONTINÚA la traza del cliente»).
   - Además, la llamada aguas arriba usa el `fetch` global (`upstream.client.ts:109`), que `HttpInstrumentation` no instrumenta, así que no hay un span cliente que pueda ser el padre.
2. **El cliente HTTP interno de `pay-payments` no manda `traceparent` y cambia el `x-request-id`** — `services/pay-payments/src/clients/http.ts:134-142`: `serviceHeaders(...)` sin `traceparent`
   y, a continuación, `'x-request-id': randomUUID()` pisa cualquier id. También usa `fetch` global (sin span cliente).
3. **El cobro llama a riesgo y al conector desde actividades de Temporal, sin contexto** — `services/pay-payments/src/temporal/activities.ts:188` (`clients.risk.assess`) y `:239`
   (`clients.connectors.createCharge`). Aun arreglando 1 y 2, el contexto de OpenTelemetry no cruza al worker de Temporal: las actividades corren fuera de la petición HTTP y no
   heredan nada. Es la causa principal de que la traza no llegue a `pay-risk` / `pay-connectors` / `pay-qr`.
4. **Los demás clientes internos tampoco** — `grep -rn traceparent services/*/src` solo encuentra `pay-edge`: `pay-connectors → pay-qr`, `pay-settlement → pay-ledger/pay-connectors` y
   `pay-schedules → pay-ledger` no propagan.

## Propuestas

| # | Propuesta | Toca | Dueño / aprueba | Prueba que la cierra |
|---|---|---|---|---|
| T1 | En el borde, reenviar el contexto ACTIVO (`propagation.inject(context.active(), headers)` de `@opentelemetry/api`) en vez de fabricar `traceparent`, y abrir un span cliente alrededor de `upstream.forward` (a mano con `tracer.startActiveSpan`, sin dependencia nueva) para que el hijo tenga un padre real. Descarta el caso de versión futura. | `pay-edge` (`edge.pipeline.ts`, `upstream.client.ts`) | P1 | pendiente prueba 1 y 2 (sin `traceparent`, una sola traza) |
| T2 | En todo cliente HTTP interno: inyectar el contexto activo con la misma función y **conservar el `x-request-id` de la petición de origen** en vez de `randomUUID()`. Si se quiere distinguir los reintentos, mandar el id del intento en otra cabecera (`x-attempt-id`). Candidato natural: `serviceHeaders` de `@pay/service-auth` (ya recibe `traceparent` y `x-request-id` por `extra`) o un helper de 10 líneas en `@pay/service-auth`. | `pay-payments/clients/http.ts`, `pay-connectors`, `pay-settlement`, `pay-schedules`, `contracts/packages/service-auth` | P3 (payments) + cada dueño | pendiente prueba 4 |
| T3 | Cruzar Temporal: o bien (a) `@temporalio/interceptors-opentelemetry` (dependencia nueva: justificar según regla 90.4 y **verificar su API contra `@temporalio/*` 1.11 instalado**; yo no la pude verificar acá), o bien (b) llevar `traceparent` y `request_id` como campos del input del workflow y que las actividades los pongan en sus llamadas (sin dependencia, pero cambia el input de workflows en vuelo: exige versionado de workflow). | `pay-payments/src/temporal/` | P3 | pendiente prueba 3 |
| T4 | Cuando T1–T3 estén, mover `e2e/pending/traza-jaeger-arbol.e2e.ts` a `flows/` y capturar la traza completa en Jaeger (el DoD pide la captura): borde → `pay-payments` → `pay-risk`/`pay-connectors`/`pay-qr`. | `e2e/` | P1 | el flujo en verde |

**Ambigüedad (a confirmar con P3):** ¿`http.ts:137` pone un UUID nuevo en cada llamada a propósito o por descuido? Si es para distinguir reintentos del mismo cobro, T2 lo conserva con otra cabecera;
si no, basta con no pisar el id.

## Lo que NO se verificó

- Los eventos de NATS (CloudEvents con extensión `traceparent`, `contracts/packages/outbox/src/cloudevent.ts`) no se miraron: la traza de un efecto asíncrono (webhook, liquidación) es otro DoD.
- Muestreo: un `traceparent` entrante con flags `00` (no muestreado) hace que el SDK no exporte el span del borde. No se probó (probar una ausencia exige esperar a ciegas).
- La captura con `pay-mockbank` (`mockbank: true`) ni el modo `live`.
