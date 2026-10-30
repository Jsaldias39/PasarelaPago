# Flujo E5 — pago mensual del médico con saldo AloVida (sin fondos → reintento → éxito)

> **AVANCE (tanda 3e): EJECUTADO CONTRA EL STACK REAL, 6 / 6 EN VERDE, 3 corridas (6, 7 y 8).** El flujo vive en `e2e/flows/e5.e2e.ts` (+ `e2e/lib/p5-schedules.ts`). Peldaño: `VERIFIED` para el flujo E5 (UI no aplica; consola/red de los servicios sin errores inesperados en los logs de `e2e/.run/`). Lo que sigue sin cubrir está en «Corridas reales» al final.

Proceso 7.7 («el médico programa sus pagos mensuales») con el medio «saldo AloVida», §6 de `docs/plan/PLAN-MAESTRO.md` (E5, carriles P5 · P2 · P3). Estilo y herramientas: `e2e/flows/e6.e2e.ts`, `docs/trabajo/ola-2/P1/ARNES.md`, `stack.call`/`callAs` y `e2e/lib` (`seed`, `receiver`, `events`, `wait`).

## Qué prueba, en una frase

Un médico programa Bs 1.000,00 mensuales a un proveedor; el día del vencimiento solo tiene Bs 500,00, así que el primer intento **espera fondos y avisa sin mover dinero**; cuando llegan los otros Bs 500,00 el pago se **ejecuta una sola vez** (aunque haya cinco ejecutores en carrera), con un asiento `tx_…` del ledger, y **no hay doble débito** aunque se repita cualquiera de las operaciones.

## Qué asume (y cómo se declara cada doble)

| Supuesto | Qué es en el flujo | Doble / real |
|---|---|---|
| Stack real | Los 11 servicios de `startStack`, `PAY_MODE=sandbox`, TigerBeetle privado, NATS y Postgres reales. `pay-schedules` arranca con `RETRY_DELAYS_SECONDS=8,8,8,8`, `RUN_INTERVAL_SECONDS=1`, `HOLD_EXPIRES_SECONDS=3600` por `envOverrides` (la política real es de horas y la fija el negocio: **no tiene valor por defecto**; los 8 s son del arnés). | Real |
| Dos comercios | El médico (pagador) y el proveedor (beneficiario) salen de `seedMerchant`: siembra de sandbox declarada como doble del alta (no hay credencial de operador usable en el arnés, hallazgo 1 de ARNES.md). Publican `merchant.activated` por el outbox real y la réplica de `pay-schedules` los aprende por NATS; el flujo espera esa réplica (`waitForReplica`). | Doble (alta) + real (eventos) |
| Mandato | `POST /v1/mandates` por `pay-edge` con la `sk_test_` del médico (`kind: pay_obligation`, `amount_minor: 100000`, mensual, `day_of_month = min(hoy, 28)`, `start_date = hoy` de La Paz). El modo `test` lo fija el borde por la clave (D-28): nunca viaja en el cuerpo. | Real |
| Reloj | El del servicio es el **real**. Si hoy es 29, 30 o 31 el día del mes no puede ser el de hoy (el contrato admite 1–28) y el vencimiento caería el mes siguiente: `makeMandateDueToday` adelanta `next_run_on` a hoy en la base de `pay-schedules`. Cualquier otro día no toca nada. | Doble del reloj, solo esos días |
| **Saldo de billetera** | **Asiento de apertura sintético** en `pay-ledger` REAL: `connector:mock:clearing → merchant:{médico}:available`, código `adjustment`, `business_ref` `e5-opening:{médico}:1` (Bs 500,00) y `:2` (los otros Bs 500,00, «llegan los fondos»). Sale de la cuenta deudora y sin tope del simulador, con la identidad de `pay-payments` (una de las tres que el ledger deja tocar `available`: `pay-payments`, `pay-settlement` y `pay-schedules`). **No existe todavía una entrada real de dinero a la billetera**: es un doble declarado y no se presenta como un depósito. | Doble |
| `X-Pay-Mode` | Todas las llamadas internas llevan `x-pay-mode: test` (`callAs` por defecto) y las públicas lo heredan de la clave `sk_test_`. El ledger y `pay-schedules` filtran por modo (D-28). | Real |
| «Operador sintético» | No hay acción de operador en E5: el pago no pasa por back-office. Lo único de operador es la siembra (arriba), que escribe lo mismo que haría `MerchantsService` con una credencial de operador. | Doble (siembra) |
| Cinco ejecutores | El `pay-schedules` del stack + **4 procesos reales más** (`startExtraExecutors`) con el mismo entorno, la misma base y el mismo ledger, cada uno con su puerto y su log. Compiten por los pagos con arriendos `SKIP LOCKED` y `UNIQUE (mandate_id, period)`. Los apaga `afterAll` y comprueba que no queden vivos. | Real |
| Webhook del médico | Un endpoint propio del médico (`/hook-e5`, receptor HTTPS local) suscrito a `scheduled_payment.insufficient_funds|executed|failed`: es el «avisa» que ve el médico. | Real |

## Paso a paso y cómo se mide

| # | Paso | Se mide así | Evidencia que deja |
|---|---|---|---|
| 0 | Siembra: médico con Bs 500,00 (apertura sintética) y proveedor con 0; endpoint de webhook | `tx_…` devuelto; repetir la apertura devuelve el MISMO `tx_` y el saldo sigue en 500,00 (idempotencia del ledger); `GET /balances` | saldo del médico = 50.000 |
| 1 | El médico crea el mandato por la API pública | 201 `object: mandate`, `status: active`; el mismo POST con la misma `Idempotency-Key` devuelve el mismo `md_…` y `GET /v1/mandates` lista uno solo | id del mandato |
| 2 | **Primer intento con Bs 500,00 de Bs 1.000,00** | Espera por condición (no por tiempo) a que la fila de `scheduled_payments` pase a `waiting_funds`: **una** fila para (mandato, periodo), `attempts = 1`, `last_failure_code = insufficient_funds`, sin `ledger_transaction_id`. En el bus (`PAY_SCHEDULES`, `scheduled_payment.insufficient_funds`): **exactamente un** aviso con `attempt = 1`, `required_minor = 100000`, `available_minor = 50000`, `mode = test` y `retry_at` (aunque haya cinco ejecutores). El webhook del médico lo recibe. `GET /v1/mandates` ⇒ `paused_insufficient_funds`. | evento + fila + webhook |
| 3 | **Sin movimiento de dinero** | Saldo del médico sigue en 50.000; reserva `schedule:{md}:reserve` = 0; proveedor = 0; el extracto del médico no tiene ningún débito | 4 saldos / 0 débitos |
| 4 | **Llegan los fondos** | Segundo asiento de apertura por Bs 500,00 ⇒ saldo del médico 100.000 | saldo |
| 5 | **Reintento ⇒ éxito** | Espera a `executed` (tope 90 s; el reintento está a 8 s): sigue **una** fila, `status = executed`, `phase = done`, `attempts = 2`, `needs_review = false`, `ledger_transaction_id` con forma `tx_…`. `GET /transactions/{sp}:release` en el ledger REAL devuelve ese mismo `id` en `posted`. | fila + asiento |
| 6 | **Saldos finales y partida doble** | Médico 0, reserva 0, proveedor 100.000. Extracto del médico: **un solo débito** de 100.000 con `business_ref = {sp}:reserve` (la retención) y créditos por 100.000 (las dos aperturas). Extracto del proveedor: **un solo crédito** de 100.000, `{sp}:release`, código `mandate`. El mandato vuelve a `active` con `next_run_on` en el mes siguiente. | extractos |
| 7 | **Sin doble débito ante reintento** | Se repite con la MISMA clave lo que mandó `pay-schedules`: la retención (`{sp}:reserve:{ledger_attempt}`, intento 2 porque el 1 fue el rechazo) ⇒ 200, `result: exists`, mismo `hd_…`, `posted`; la liberación (`{sp}:release`) ⇒ 200, `exists`, mismo `tx_…`. Saldos y extracto no cambian. | respuestas `exists` |
| 8 | **Un solo efecto con 5 ejecutores** | Leído al final (cuando ya pasaron muchas vueltas de los cinco, cada 1 s): **un** `scheduled_payment.executed` en el bus (con `ledger_transfer_id` = el `tx_…` de la fila) y **uno** en el webhook; cero `failed`; ningún aviso `attempt = 2`; una sola fila del mandato. | conteos |

La ausencia de una segunda ejecución no se puede probar «por condición»: se mide por estado (fila única por la restricción, un solo débito y un solo crédito en el ledger) y los conteos de eventos se leen al final, después de los pasos 6 y 7.

## La realidad actual (PR-18) y qué cambiaría con `POST /intents`

Hoy `pay-schedules` ejecuta **directo contra `pay-ledger`** (D5-32): retención (`/holds`) → confirmación → liberación (`/transactions`). No pasa por `pay-risk` ni por `pay-payments`, no crea un `payment_intent` y sus avisos son `scheduled_payment.*`. El flujo está escrito contra eso. Si se migra al contrato de `internal-payments-v1.yaml` (opción A de PR-18, decisión abierta del dueño), cambiaría:

| Paso | Hoy (directo al ledger) | Con `POST /intents` |
|---|---|---|
| Quién mueve el dinero | `pay-schedules` (identidad `pay-schedules`, cuentas `available`, `schedule:*:reserve`) | `pay-payments` (saga/Temporal); `pay-schedules` solo pide el intento y espera el resultado |
| Riesgo y sanciones | Ninguno | `pay-risk` evalúa el intento (D-29/D-30); un `review` se trata como `deny` y el pago programado fallaría con `risk_denied` salvo que el comercio sea limpio. **E5 necesitaría que el cribado del médico sea limpio** |
| Sin fondos (pasos 2–3) | Rechazo del `/holds` ⇒ `waiting_funds` + `scheduled_payment.insufficient_funds` | El intento termina `failed` (código de fondos insuficientes) + `payment_intent.failed`; `pay-schedules` debe traducirlo a su espera y su aviso. **Cambian el evento y la aserción de `available_minor`** |
| Reintento (paso 5) | Misma `business_ref` `{sp}:reserve`, `attempt` 2 | Un intento NUEVO con otra `Idempotency-Key` (`schedule:{md}:{periodo}:{intento}`); P3 tendría que soportar la reserva `schedule:{id}:reserve` o P5 prescindir de ella y de los holds |
| Asiento citado (paso 5) | `tx_…` de la liberación `{sp}:release` | `tx_…` del asiento de captura del intento; el extracto cambia de `business_ref` (`{pi}:capture`) y de código (`charge`/`fee`, hoy `mandate`) |
| Eventos (pasos 2, 8) | Solo `scheduled_payment.*` | Además `payment_intent.*` por cada intento (dos por cada reintento): las cuentas de eventos del paso 8 deben filtrar por tipo |
| Sin doble débito (paso 7) | Repetir hold/release con la misma clave devuelve `exists` | Repetir `POST /intents` con la misma `Idempotency-Key` devuelve el mismo intento |

Los pasos 0, 1, 4, 6 (saldos finales) y la prueba de los cinco ejecutores no cambian.

## Cómo correrlo (lo hace P1, un stack a la vez)

```bash
yarn e2e:pending                       # requiere la infra del Compose arriba y los dist/ construidos
node --no-warnings e2e/cli.ts down     # solo si quedó un stack registrado
```

Pasado a la suite por defecto con `git mv e2e/pending/e5.e2e.ts e2e/flows/e5.e2e.ts` tras la corrida 7. El ayudante `e2e/lib/p5-schedules.ts` es nuevo y no toca archivos de P1; **P1 queda avisado de que existe**.

## Supuestos sin verificar (los más probables de fallar en la primera corrida)

1. El nombre de los temas del bus: `pay-schedules.scheduled_payment.<tipo>` en el stream `PAY_SCHEDULES` (convención vista en `connectorEvents`; no se leyó el relé de `pay-schedules`).
2. Que `GET /statements` devuelva las líneas de la retención confirmada con el `business_ref` `{sp}:reserve` y dirección `debit` en la cuenta del pagador; y que `GET /transactions/{business_ref}` acepte `:` codificado.
3. Que repetir `POST /holds` con la misma clave y el MISMO cuerpo (incluido `expires_in_seconds: 3600`) devuelva 200 `exists` y no un conflicto de idempotencia.
4. Que `pay-webhooks` entregue los tres `scheduled_payment.*` al endpoint del médico (los consume de `PAY_SCHEDULES` según `config.ts`) y que `data` conserve el modo (`mode: test` en el sobre).
5. Que el borde reenvíe el replay de `POST /v1/mandates` con el mismo `id` (se afirma solo la igualdad del id).
6. Tiempos: reintento a 8 s y tope de espera de 90 s; el tope del test (`testTimeout` 180 s) cubre el flujo entero en una máquina tranquila.

## No cubierto

- **Corrida real** del flujo (arriba).
- Fallo del ledger a mitad de la ejecución (resultado ambiguo, regla 11) y la recuperación tras matar `pay-schedules`: cubiertos por las pruebas del servicio (`test/executor.spec.ts`), no por E5.
- El camino `live`, dinero real y el cribado de riesgo del pago programado (PR-18).
- Que la billetera se alimente de un depósito real: aquí es una apertura sintética.
- Mandatos de comisión (`pay_commission`, 7.8, requiere `PLATFORM_MERCHANT_ID`).

## Corridas reales (tanda 3e)

Evidencia en `docs/trabajo/ola-3/P5/evidencia/`. Un solo stack por vez; las corridas 1 y 2 chocaron con stacks ajenos y no cuentan.

| # | Resultado | Causa (demostrada) | Clase | Dueño | Arreglo |
|---|---|---|---|---|---|
| 1 `3e-e5-corrida-1.txt` | 0/6 | `waitForReplica` agotó el tiempo: `MerchantReplicaConsumer` fallaba cada 2 s. El NATS real devuelve `invalid durable name - durable name cannot contain '.'` para el durable por defecto `pay-schedules.merchant-replica` (`3e-e5-causa-durable-con-punto.txt`) | `PRODUCT_BUG` | P5 (`pay-schedules`) | Durable por defecto `pay-schedules-merchant-replica`; `MERCHANTS_DURABLE` se valida al arrancar; el warning incluye el mensaje del servidor NATS. Prueba roja→verde en `settings.spec.ts` y prueba contra NATS real en `nats-replica.spec.ts` |
| 2 `3e-e5-corrida-2-dist-viejo.txt` | 0/6 | Mismo síntoma: el stack arranca `services/*/dist` y yo no había reconstruido `pay-schedules` | `ENVIRONMENT` (mío) | P5 | `yarn build` de `pay-schedules` (`3e-e5-schedules-build.txt`) |
| 3 `…-3-business-ref.txt` | 1/6 | `fundWallet` mandaba un `business_ref` que el ledger rechaza (`422 validation_failed`, `business_ref invalid_format`) | `TEST_BUG` | P5 (`e2e/lib/p5-schedules.ts`) | `<id de comercio>:<verbo>` |
| 4 `…-4-verbo-con-digito.txt` | 1/6 | El verbo del `business_ref` solo admite `[a-z_]` (regex de `services/pay-ledger/src/ledger/schemas.ts`); mi verbo llevaba un dígito (`e5_…`) | `TEST_BUG` | P5 | Verbos `apertura_uno` / `apertura_dos` |
| 5 `…-5-forma-de-respuesta.txt` | 5/6 | `GET /transactions/{business_ref}` devuelve `{business_ref, attempts: Transaction[]}` (contrato `internal-ledger-v1.yaml`); mi aserción leía `id`/`status` en la raíz | `TEST_BUG` | P5 (`e5.e2e.ts`) | Aserción sobre `attempts` |
| 6, 7 | **6/6** | — | — | — | — |
| 8 `…-8-en-flows.txt` | **6/6** | Ya en `e2e/flows/`, con `e2e/jest.config.cjs` | — | — | — |

**Nada de lo que falló pertenecía a otro carril**: no hay hallazgos para P1, P2 ni P3 en esta tanda. La única interacción con otros fue de coordinación (stacks simultáneos; ver `3e-e5-intento-*.txt`).

**No cubierto:** el saldo inicial del médico se carga con un asiento de apertura sintético [DOBLE] contra el ledger real (no hay entrada de dinero real); el reloj de «hoy» es un doble de `makeMandateDueToday`; sin `pay-mockbank` ni modo B; PR-18 (ejecución directa contra el ledger sin riesgo) sigue como decisión abierta del dueño y no se implementó.
