# Carril P3 — Núcleo de pagos (`pay-payments`)

> **Estado:** `TODO` · **AVANCE: 0 / 18 — 0,0 %** · **Peldaño:** `UNKNOWN`
> **Predecesor:** P1.H1 (plataforma y plantilla). Riesgo, conectores y ledger se simulan.
> **Carpetas del monorepo:** `services/pay-payments/`, `services/pay-vault/` · esquema en `mantra-core-health-model`. **Lidera además el carril de integración** ([`INT-monolito-como-cliente.md`](./INT-monolito-como-cliente.md), ola 4).
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md)

**Skills:** `state-machines-workflows`, `concurrency-and-locking`, `async-messaging-events`, `nestjs-development`,
`mikroorm-patterns`, `error-handling-contract`, `api-openapi-docs`, `authz-access-control`, `integrity-testing`,
`api-testing`, `root-cause-debugging`, `evidence-and-verification`.

## Resultado observable

Un comercio crea una intención de pago, el cliente paga por QR y la intención termina en **un solo
estado terminal** (`succeeded`, `failed`, `canceled` o `expired`), pase lo que pase en el medio:
reintentos del comercio, callbacks duplicados o reordenados, o la caída del servicio a mitad del
proceso. Los reembolsos, anulaciones y disputas siguen la misma disciplina.

**Kill-test:** crear un intento, matar `pay-payments` (`docker kill`) justo después de que el
conector confirme el cobro, y levantarlo. Si el intento no termina en `succeeded` con **un**
asiento en el ledger, no está hecho. Repetir el mismo `POST` con la misma `Idempotency-Key` y otro
cuerpo: si no responde `422 idempotency_key_reused`, tampoco.

## Contratos

- **Expone:** la semántica de la API pública `payment_intents`, `refunds` y `disputes`;
  `internal/payments/v1/intents` (para mandatos de P5); eventos `payment_intent.*`, `refund.*` y
  `dispute.*`.
- **Consume:** `internal/risk/v1` (P5), `internal/connectors/v1` (P4), `internal/ledger/v1` (P2);
  eventos `fee_schedule.published` y `merchant.*` (P5, réplica local);
  `connector.transaction.status_changed` (P4).

## Criterios

- **REQ-P3-1** — Dado un POST con una `Idempotency-Key` ya usada y el mismo cuerpo, cuando llega, entonces devuelve la respuesta guardada sin ejecutar nada; con otro cuerpo devuelve `422`. — `MISSING`
- **REQ-P3-2** — Dado un intento `succeeded`, cuando llega un evento atrasado `authorized`, entonces se ignora como `obsoleto` sin retroceder (máquina reciclada de `payment-callback-machine.ts`). — `MISSING`
- **REQ-P3-3** — Dado un `failed` cuando ya está `succeeded`, cuando llega, entonces se marca `contradiccion`, no se sobrescribe y se publica para conciliación humana. — `MISSING`
- **REQ-P3-4** — Dado un cobro confirmado por el conector, cuando el servicio cae antes de registrarlo en el ledger, entonces al reiniciar el workflow lo registra una sola vez. — `MISSING`
- **REQ-P3-5** — Dado un intento con monto, tarifario y canal, cuando se cotiza, entonces comisión + neto = bruto exactamente, con la regla de redondeo única (A-3). — `MISSING`
- **REQ-P3-6** — Dado un reembolso parcial, cuando el conector falla, entonces la retención en el ledger se anula y el reembolso queda `failed` con su motivo. — `MISSING`
- **REQ-P3-7** — Dado un intento sin confirmar al vencer, cuando se consulta el estado al conector y sigue pendiente, entonces queda `expired` y el QR se anula. — `MISSING`
- **REQ-P3-8** — Dado un comercio `suspended` (réplica), cuando crea un intento, entonces recibe `403 merchant_suspended`. — `MISSING`

## H1 — Intención de pago e idempotencia (olas 0 y 1)

**CA:** Dado un comercio activo, cuando crea, lee o cancela intentos, entonces el estado es consistente y cada mutación es idempotente.
**DoD:** REQ-P3-1, 2, 3, 5 y 8 en verde contra Postgres real.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P3.H1.M1 | **Spike** Temporal: workflow con señal, *timer* y compensación, reiniciando el worker a la mitad | El workflow termina tras `docker kill` del worker | `evidencia/spike-temporal.md` | TODO |
| P3.H1.M2 | Esquema `pay_payments` en el modelo (partiendo de `payment_intents`, `refunds`, `payment_disputes`, `payment_cancellation_requests`) | Sin deriva | Verificador de deriva | TODO |
| P3.H1.M3 | Máquina de estados del intento, reciclando `payment-callback-machine.ts` y su spec | Los specs reciclados pasan + REQ-P3-2 y 3 | `yarn test` pegado | TODO |
| P3.H1.M4 | `POST/GET /payment_intents` + `cancel` con `@pay/idempotency` | REQ-P3-1 con 50 concurrentes | Test de integración | TODO |
| P3.H1.M5 | Réplicas del tarifario y del estado del comercio (inbox) + cotización | REQ-P3-5 (test de propiedades) y REQ-P3-8 | Test pegado | TODO |
| P3.H1.M6 | Autorización por objeto (BOLA): todo acceso filtra por `merchant_id` del token | Leer el intento de otro comercio → `404` | Matriz negativa | TODO |

## H2 — Sagas en Temporal (olas 1 y 2)

**CA:** Dado un cobro, reembolso o anulación, cuando falla cualquier paso o cae el servicio, entonces la saga termina en un estado terminal con sus compensaciones aplicadas una vez.
**DoD:** REQ-P3-4, 6 y 7 + flujos E2 y E3 en verde.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P3.H2.M1 | `PaymentWorkflow`: riesgo → conector → espera de señal o vencimiento → ledger → evento | Camino feliz de punta a punta contra dobles | Test de workflow (*test env* de Temporal) | TODO |
| P3.H2.M2 | Política de llamadas síncronas: *timeouts*, reintentos solo ante errores reintentables, *circuit breaker*; riesgo *fail-closed* sobre el umbral | Riesgo caído + monto alto → `failed` con `risk_unavailable` | Test pegado | TODO |
| P3.H2.M3 | Ids idempotentes derivados del intento para cada llamada al ledger y al conector | REQ-P3-4 con `docker kill` | Salida del experimento | TODO |
| P3.H2.M4 | Vencimiento + consulta de estado + anulación del QR | REQ-P3-7 | Test pegado | TODO |
| P3.H2.M5 | `RefundWorkflow` con retención en dos fases | REQ-P3-6 | E3 en verde | TODO |
| P3.H2.M6 | Disputas: apertura, evidencia y resultado, con su asiento (débito al comercio si se pierde) | Una disputa perdida deja el asiento correcto | Test pegado | TODO |
| P3.H2.M7 | Eventos `payment_intent.*`, `refund.*`, `dispute.*` por outbox | Sin commit no hay evento; con commit, uno o más (al menos una vez) | Test pegado | TODO |
| P3.H2.M8 | Inyección de fallos: duplicar y reordenar señales, matar el worker en cada actividad | Un solo estado terminal en todos los casos | `evidencia/fallos-p3.md` | TODO |

## H3 — Medios de pago y bóveda (olas 1 a 3)

**CA:** Dado un intento, cuando el pagador elige QR, tarjeta, transferencia o saldo AloVida, entonces el intento sigue la misma máquina de estados, y ningún número de tarjeta queda fuera de `pay-vault`.
**DoD:** un intento por medio, de punta a punta, contra el simulador + prueba de que no hay PAN fuera de la bóveda.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P3.H3.M1 | **Spike** `hyperswitch-card-vault`: despliegue, API, gestión de claves con OpenBao, licencia en su `LICENSE` | Responde sí o no con criterio | `evidencia/spike-vault.md` | TODO |
| P3.H3.M2 | `pay-vault` desplegado en la red aislada (P1.H4.M3), con tokens por comercio | Un token de otro comercio no se puede usar | Test pegado | TODO |
| P3.H3.M3 | Medio **tarjeta**: por defecto con los campos alojados del PSP (token del PSP); con `pay-vault` cuando el comercio guarda la tarjeta | grep de PAN de prueba en logs, eventos y bases fuera de la bóveda → 0 | Salida del grep pegada | TODO |
| P3.H3.M4 | Medios **saldo AloVida** (ledger, P2.H1.M8) y **transferencia** (`requires_action` con instrucciones, confirmada por el conector de P4) | Los dos terminan en `succeeded` contra dobles | Tests pegados | TODO |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| P5 riesgo | `internal/risk/v1` | `allow` | Respuesta en 299 ms (borde del *timeout*) | `503` o *timeout* → política *fail-closed* |
| P4 conectores | `internal/connectors/v1` | Cobro creado + callback `captured` | Callback duplicado y reordenado; callback que nunca llega | `422` del PSP → `failed` con motivo mapeado |
| P2 ledger | `internal/ledger/v1` | Asiento aceptado | El mismo id dos veces → mismo resultado | `insufficient_funds` en el reembolso → reembolso `failed` |

## Gates y entrega

Gates de §7 del maestro. PR contra `dev`, mergeable (regla 35). `REPORTE.md` con el avance arriba.
