# Carril P3 — Núcleo de pagos (`pay-payments`)

> **Estado:** `EN CURSO` (ola 1 cerrada contra dobles) · **AVANCE: 12 / 18 — 66,7 %** · **Peldaño:** `TESTED` en lo marcado HECHO (Postgres, NATS y Temporal reales; riesgo, conectores y ledger son dobles declarados); `UNKNOWN` en el resto
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
| P3.H1.M1 | **Spike** Temporal: workflow con señal, *timer* y compensación, reiniciando el worker a la mitad | El workflow termina tras `docker kill` del worker | `evidencia/spike-temporal.md` → [spike](../../spikes/temporal.md): **SÍ con condiciones** (`TESTED`) | HECHO |
| P3.H1.M2 | Esquema `pay_payments` en el modelo (partiendo de `payment_intents`, `refunds`, `payment_disputes`, `payment_cancellation_requests`) | Sin deriva | Verificador de deriva | A MEDIAS · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H1.M2.txt) · ver «Estado de la ola 1» |
| P3.H1.M3 | Máquina de estados del intento, reciclando `payment-callback-machine.ts` y su spec | Los specs reciclados pasan + REQ-P3-2 y 3 | `yarn test` pegado | A MEDIAS · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H1.M3.txt) · ver «Estado de la ola 1» |
| P3.H1.M4 | `POST/GET /payment_intents` + `cancel` con `@pay/idempotency` | REQ-P3-1 con 50 concurrentes | Test de integración | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H1.M4.txt) |
| P3.H1.M5 | Réplicas del tarifario y del estado del comercio (inbox) + cotización | REQ-P3-5 (test de propiedades) y REQ-P3-8 | Test pegado | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H1.M5.txt) |
| P3.H1.M6 | Autorización por objeto (BOLA): todo acceso filtra por `merchant_id` del token | Leer el intento de otro comercio → `404` | Matriz negativa | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H1.M6.txt) |

## H2 — Sagas en Temporal (olas 1 y 2)

**CA:** Dado un cobro, reembolso o anulación, cuando falla cualquier paso o cae el servicio, entonces la saga termina en un estado terminal con sus compensaciones aplicadas una vez.
**DoD:** REQ-P3-4, 6 y 7 + flujos E2 y E3 en verde.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P3.H2.M1 | `PaymentWorkflow`: riesgo → conector → espera de señal o vencimiento → ledger → evento | Camino feliz de punta a punta contra dobles | Test de workflow (*test env* de Temporal) | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M1.txt) |
| P3.H2.M2 | Política de llamadas síncronas: *timeouts*, reintentos solo ante errores reintentables, *circuit breaker*; riesgo *fail-closed* sobre el umbral | Riesgo caído + monto alto → `failed` con `risk_unavailable` | Test pegado | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M2.txt) |
| P3.H2.M3 | Ids idempotentes para cada llamada al ledger y al conector: `business_ref` estable por operación y `attempt` que sube solo tras un rechazo (H-TB1); toda actividad con efecto externo es idempotente (H-TM1) | REQ-P3-4 con `docker kill` | Salida del experimento | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M3.txt) |
| P3.H2.M4 | Vencimiento + consulta de estado + anulación del QR | REQ-P3-7 | Test pegado | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M4.txt) |
| P3.H2.M5 | `RefundWorkflow` con retención en dos fases | REQ-P3-6 | E3 en verde | A MEDIAS · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M5.txt) · ver «Estado de la ola 1» |
| P3.H2.M6 | Disputas: apertura, evidencia y resultado, con su asiento (débito al comercio si se pierde) | Una disputa perdida deja el asiento correcto | Test pegado | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M6.txt) |
| P3.H2.M7 | Eventos `payment_intent.*`, `refund.*`, `dispute.*` por outbox | Sin commit no hay evento; con commit, uno o más (al menos una vez) | Test pegado | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M7.txt) |
| P3.H2.M8 | Inyección de fallos: duplicar y reordenar señales, matar el worker en cada actividad | Un solo estado terminal en todos los casos | `evidencia/fallos-p3.md` | A MEDIAS · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H2.M8.txt) · ver «Estado de la ola 1» |

## H3 — Medios de pago y bóveda (olas 1 a 3)

**CA:** Dado un intento, cuando el pagador elige QR, tarjeta, transferencia o saldo AloVida, entonces el intento sigue la misma máquina de estados, y ningún número de tarjeta queda fuera de `pay-vault`.
**DoD:** un intento por medio, de punta a punta, contra el simulador + prueba de que no hay PAN fuera de la bóveda.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P3.H3.M1 | **Spike** `hyperswitch-card-vault`: despliegue, API, gestión de claves con OpenBao, licencia en su `LICENSE` | Responde sí o no con criterio | `evidencia/spike-vault.md` | A MEDIAS |
| P3.H3.M2 | `pay-vault` desplegado en la red aislada (P1.H4.M3), con tokens por comercio | Un token de otro comercio no se puede usar | Test pegado | A MEDIAS · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H3.M2.txt) · ver «Estado de la ola 1» |
| P3.H3.M3 | Medio **tarjeta**: por defecto con los campos alojados del PSP (token del PSP); con `pay-vault` cuando el comercio guarda la tarjeta | grep de PAN de prueba en logs, eventos y bases fuera de la bóveda → 0 | Salida del grep pegada | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H3.M3.txt) |
| P3.H3.M4 | Medios **saldo AloVida** (ledger, P2.H1.M8) y **transferencia** (`requires_action` con instrucciones, confirmada por el conector de P4) | Los dos terminan en `succeeded` contra dobles; el saldo AloVida solo se debita con `wallet_authorization` válida (un solo uso, atada a comercio, importe y moneda): sin token, token reutilizado o de otro comercio ⇒ `forbidden` y el saldo no cambia | Tests pegados | HECHO · [evidencia](../../trabajo/ola-1/P3/evidencia/P3.H3.M4.txt) |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| P5 riesgo | `internal/risk/v1` | `allow` | Respuesta en 299 ms (borde del *timeout*) | `503` o *timeout* → política *fail-closed* |
| P4 conectores | `internal/connectors/v1` | Cobro creado + callback `captured` | Callback duplicado y reordenado; callback que nunca llega | `422` del PSP → `failed` con motivo mapeado |
| P2 ledger | `internal/ledger/v1` | Asiento aceptado | El mismo id dos veces → mismo resultado | `insufficient_funds` en el reembolso → reembolso `failed` |

## Estado de la ola 0 (A MEDIAS, con las cuatro respuestas)

**P3.H3.M1 — Spike `hyperswitch-card-vault`.** *Qué anda:* se leyó el repo (README, API, gestión de claves) y la licencia es Apache-2.0 ([`card-vault.md`](../../spikes/card-vault.md), `DISCOVERED`). *Qué no anda:* **no se ejecutó**: la imagen de ghcr.io no se puede descargar desde el entorno y el sistema de permisos denegó clonar y compilar código de terceros. *Qué falta:* levantarlo (imagen o compilación) en un entorno con acceso y probar crear, consultar y borrar un token. *Dónde quedó:* solo documentos en `docs/spikes/`.

## Estado de la ola 1 (microtareas A MEDIAS, con las cuatro respuestas)

Evidencia en [`docs/trabajo/ola-1/P3/evidencia/`](../../trabajo/ola-1/P3/evidencia/). Todo lo HECHO corrió contra Postgres, NATS y Temporal reales y contra DOBLES de pay-risk, pay-connectors y pay-ledger que validan el contrato OpenAPI (regla 65); nada se verificó contra los servicios reales.

- **P3.H1.M2 — Esquema.** *Qué anda:* `services/pay-payments/sql/001_payments.sql` se aplica, el verificador de deriva (SQL ↔ base ↔ mapa del código, con sus mutaciones) da 0 y todo `INSERT` del código cubre las columnas obligatorias. *Qué no anda:* el esquema NO está en `mantra-core-health-model` (D-18); no hay entidades del ORM. *Qué falta:* llevar el `.sql` al pipeline `.puml → SQL/ → base → ORM` y repetir la deriva con las entidades. *Dónde quedó:* `sql/001_payments.sql`, `src/persistence/schema-map.ts`, `test/schema.drift.spec.ts`; compila.
- **P3.H1.M3 — Máquina de estados.** *Qué anda:* `decideCallback` portada (16 pruebas), REQ-P3-2 (autorizado tardío = obsoleto) y la contradicción registrada sin pisar el estado. *Qué no anda:* REQ-P3-3 pide además «se publica para conciliación»: no hay evento en el contrato (PROP-5); queda solo en `intent_contradictions`. *Qué falta:* aprobar PROP-5 y publicarlo. *Dónde quedó:* `src/domain/state.ts`, `src/events/handlers.ts`; compila, pruebas en verde.
- **P3.H2.M5 — Reembolso.** *Qué anda:* retención en dos fases, parcial, fallo definitivo (anula), ambiguo (conserva y escala), `pending` sin aviso. *Qué no anda:* el DoD pide E3 en verde y E3 es de punta a punta con los servicios reales. *Qué falta:* E3 en la ola 2; PROP-11 (consulta de estado de un reembolso). *Dónde quedó:* `src/temporal/activities-money.ts`, `workflows.ts`.
- **P3.H2.M8 — Inyección de fallos.** *Qué anda:* `evidencia/fallos-p3.md` con 15 escenarios (riesgo, conector, ledger, eventos, reembolso, disputa) y 5 SIGKILL del worker con el asiento en vuelo, más muerte mientras espera al pagador. *Qué no anda:* no se mató el worker «en cada actividad» (solo `recordLedger` en vuelo y la espera). *Qué falta:* matar en `createCharge`, `resolveExpiry`, `holdRefund` y `finishRefund` (los dobles necesitan latencia configurable); caída de Postgres y de NATS. *Dónde quedó:* `test/failures.matrix.spec.ts`, `test/payment.kill.spec.ts`.
- **P3.H3.M1 — Spike de la bóveda.** Sin cambios: A MEDIAS (no se ejecutó, ver arriba).
- **P3.H3.M2 — `pay-vault`.** *Qué anda:* sesiones de captura, tokens por comercio (el ajeno da 404 idéntico), `reveal` solo para `pay-connectors` con auditoría y `no-store`, sin PAN en tablas ni logs. *Qué no anda:* no está desplegado en la red aislada (P1.H4.M3) y el backend de custodia es `FakeVaultBackend`, un DOBLE en memoria (prohibido con `PAY_MODE=live`). *Qué falta:* P3.H3.M1 (backend real), despliegue segmentado, job que agenda `purgeSingleUse`. *Dónde quedó:* `services/pay-vault/`; compila y 58 pruebas pasan.

## Gates y entrega

Gates de §7 del maestro. PR contra `dev`, mergeable (regla 35). `REPORTE.md` con el avance arriba.
