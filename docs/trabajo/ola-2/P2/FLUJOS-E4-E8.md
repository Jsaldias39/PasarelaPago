# Flujos E4 y E8 del plan (carril P2) — qué asumen, qué esperan y cómo se miden

> **Peldaño de evidencia: `RUNS`** (regla 30). Los dos flujos están **escritos** (`e2e/pending/e4.e2e.ts`, `e2e/pending/e8.e2e.ts`) y **compilan y pasan el lint**
> (`yarn e2e:typecheck`, `yarn eslint`, `yarn lint`: `evidencia/4a-gates.txt`). **No se ejecutaron**: el stack lo corre P1 (un stack a la vez). Todo lo que dice «hoy pasa» o
> «hoy falla» abajo es una **predicción por lectura del código, NO una observación**. Hasta que P1 los corra, ninguna afirmación de punta a punta es `VERIFIED`.

Archivos nuevos (nada existente de `e2e/` se modificó): `e2e/pending/e4.e2e.ts`, `e2e/pending/e8.e2e.ts` y dos ayudantes **nuevos** de P2, `e2e/lib/p2-bank.ts` (importes y el
punto único del depósito del pagador) y `e2e/lib/p2-settlement.ts` (credencial de operador sintética, llamada como `pay-backoffice`, vistas del ledger, captura [DOBLE] de pay-payments,
lunes de corte, espera de eventos). `e2e/tsconfig.json` ya tipa `lib/` y `pending/`. Se mueven a `flows/` con `git mv` cuando dejen de estar bloqueados (mismas rutas relativas).

## Importes (constantes nombradas en `e2e/lib/p2-bank.ts`)

Hoy son los del conector `mock` (README de pay-connectors: escenarios por los **centavos** del importe). Los de `pay-mockbank` (P4.H4.M3, en construcción) se cambian **solo ahí**.

| Constante | Valor | Escenario del `mock` | Se usa en |
|---|---|---|---|
| `QR_GROSS_MATCHING` | 10 000 (Bs 100,00) | `…00` aprobado | E4: cobro que cruza |
| `QR_GROSS_STATEMENT_MISMATCH` | 10 009 (Bs 100,09) | `…09` el extracto trae Bs 1,00 menos (`STATEMENT_MISMATCH_MINOR = 100`) | E4: la diferencia |
| `AVAILABLE_BEFORE_CUT` | 50 000 (Bs 500,00) | transferencia saliente `…00` pagada | E4: lo que el corte paga |
| `BANK_TRANSFER_GROSS` | 20 000 (Bs 200,00) | — (no hay escenario por importe en la transferencia entrante) | E8 |
| `BANK_TRANSFER_WRONG_AMOUNT` | 19 000 | — | E8: crédito con otro importe |

Comisión y neto salen de `@pay/money` (`quoteFee`, la misma función que los servicios) con la tarifa de la siembra (QR 2,5 % + Bs 0,50; transferencia 1 %): Bs 100,00 ⇒ **97,00 / 3,00**;
Bs 200,00 por transferencia ⇒ 198,00 / 2,00. Ninguna cifra se escribe a mano en las aserciones.

## E4 — corte semanal → payout → conciliación con una diferencia → excepción

**Servicios** (`startStack({ only })`): `pay-ledger` (+ TigerBeetle privado), `pay-qr`, `pay-connectors` (simulador `mock`), `pay-merchants` (relé de la siembra) y `pay-settlement`.
**No** se levantan `pay-payments` ni `pay-edge`: sus cobros terminan `failed/risk_denied` (D-29/D-30), así que las capturas las manda un [DOBLE] declarado de pay-payments con el asiento exacto
que manda su `recordLedger` (como `flows/ledger-capture.e2e.ts`). **Variables** (todas las arma `envFor`; ninguna se agrega): `PAY_MODE=sandbox`, `SETTLEMENT_MODE=bank`,
`SETTLEMENT_TRANSFER_CONNECTOR=mock`, `OPERATOR_TOKEN_{PUBLIC_KEY,ISSUER=e2e-issuer,AUDIENCE=pay-settlement}`, `LEDGER_URL`, `CONNECTORS_URL`, `TB_ADDRESS`, `NATS_URL`; `SETTLEMENT_CUTOFF_WEEKDAY`
sin definir (⇒ lunes, D-19). La llamada es como `pay-backoffice` (D-31), `X-Pay-Mode: test`.

| # | Paso | Qué espera ver | Cómo se mide |
|---|---|---|---|
| 1 | Siembra del comercio (`seedMerchant`) y espera de que settlement lo conozca | el directorio de settlement lo tiene (lo aprende por `fee_schedule.published`) | `SELECT` de solo lectura sobre `settlement_merchants` (el directorio no tiene API) |
| 2 | **COBROS**: dos cobros QR reales en pay-connectors (10 000 y 10 009) + su captura en el ledger | `merchant:X:pending` = neto 1 + neto 2; **97,00 / 3,00** para Bs 100,00 | `GET /balances`; **débitos = créditos** = importe bruto por asiento (`doubleEntryOf`: líneas de extracto de pending, fees y compensación) |
| 3 | **CORTE** `POST /batches` con el último lunes cuya medianoche local ya pasó, tras un asiento [DOBLE] de Bs 500,00 ya disponibles | lote `completed`, `released_minor = 0` (lo cobrado hace segundos **no** se libera: T+7), `payouts_count = 1`; `available` = 0; `payout:clearing` sube exactamente 50 000; payout `paid`, `simulated=false`, con `batch_id`; el conector tiene UNA transferencia `…:payout:1` `paid`; un `payout.created` (con `settlement_batch_id` y `mode=test`) y un `payout.paid` | `GET /balances`, `GET /payouts?merchant_id=`, `GET /transfers/{ref}` y lectura del stream `PAY_SETTLEMENT` (espera por condición, nunca por tiempo) |
| 4 | **REINTENTO**: mismo corte con la misma clave, con otra clave | `201` con `Idempotency-Replayed`; `200` y el mismo `id`; **un** payout, `payout:clearing` sin cambio y **una** línea de crédito con el `business_ref` del payout, un solo lote, un solo `payout.created` | ídem; esta es la medida de «sin doble pago» |
| 5 | **PRECONDICIÓN DEL CRUCE**: el extracto del conector trae `payment_intent_id` (`pi_…`) de los dos cobros | los dos `pi_…` aparecen en el campo `payment_intent_id` de las líneas (4b: P4 debe emitirlo en `fetchStatement`) | `GET /statements?connector=mock` (como `pay-settlement`) |
| 6 | **CONCILIACIÓN**: `POST /reconciliation_runs` (202) y espera | corrida `completed`, **una** excepción abierta `amount_mismatch`, `business_ref=pi_…:capture`, `statement_amount_minor = 10 009 − 100`, `ledger_amount_minor = 10 009`; el cobro de 10 000 cruza; **ningún saldo del ledger cambia**; **un** `reconciliation.exception.opened` con `difference_minor = −100` y el `payment_intent_id` | snapshot de 5 saldos antes y después; lista de excepciones; stream |
| 7 | **REPETIDA**: otra corrida sobre el mismo periodo | la misma excepción (ni una nueva ni otro evento) | lista y stream |
| 8 | **RESOLUCIÓN** | sin credencial `401`; `settlement_operator` pidiendo ajuste `403`; `settlement_admin` descarta ⇒ `dismissed` con `resolved_by` = su `sub`; ya no hay abiertas | JWT RS256 firmado con la clave privada sintética de la corrida |
| 9 | **MODO** | clave `live` o sin modo contra el despliegue sandbox ⇒ `403`, incluido `POST /batches`; el conteo de payouts no cambia | `GET /payouts` antes/después |

## E8 — transferencia bancaria confirmada por la línea del extracto

**Servicios**: los 11 (`startStack({ tolerateFailures: false })`), como E1. **Variables**: las de `envFor`, con la cuenta recaudadora SINTÉTICA de sandbox
(`BANCO SIMULADO (SANDBOX)` / `ALOVIDA PAY (SANDBOX)` / `SANDBOX-0000-0001`).

| # | Paso | Qué espera ver | Cómo se mide |
|---|---|---|---|
| 1 | **INSTRUCCIONES**: `POST /v1/payment_intents` con `bank_transfer` (Bs 200,00) y repetirlo con la misma clave | `201 requires_action`, `fee/net` de `quoteFee`, `bank_transfer_instructions` con referencia y la cuenta sintética; la repetición devuelve el mismo cobro y la misma referencia | API pública |
| 2 | **ANTES DEL EXTRACTO** | sigue `requires_action`; el ledger sin capturas (el banco no avisa) | `GET /v1/payment_intents/{id}`; `ledgerOfCapture` |
| 3 | **CONFIRMACIÓN**: el pagador transfiere con la referencia y el importe exactos (`payerTransfersToBank`) | `succeeded`; `pending` = 198,00 y `fees` = 2,00; **débitos = créditos** = 20 000; **una** línea de crédito en pending con `pi_…:capture`; `GET /v1/balance.pending_minor` = neto | ledger real + API pública |
| 4 | **UNA SOLA VEZ** | tras otro ciclo de lectura del extracto (una corrida de settlement), un solo evento `captured` del conector y una sola captura | `connectorEvents`, `ledgerOfCapture` |
| 5 | **CONCILIACIÓN (P2)** del conector `bank_transfer` | corrida `completed`, ≥ 1 cruzada, **0 excepciones**; el ledger no se mueve | snapshot de saldos; lista de excepciones |
| 6 | **IMPORTE DISTINTO** (19 000) | el cobro **no** se captura (sigue `requires_action`, sin captura en el ledger) y queda **una** excepción `missing_in_ledger` por 19 000 para una persona | corrida de settlement + lista |

## Qué depende del stack (y NO de P2) — confirmación de P2.H2.M6

El DoD de P2.H2.M6 es **«E4 en verde»**. Qué parte depende de qué:

| Parte del DoD | Depende de | Estado hoy |
|---|---|---|
| Corte → payout, un solo pago ante reintento, resolución por persona, modo `test`↔sandbox | **solo del stack** (ledger + TigerBeetle + connectors + settlement + NATS/Postgres). Los pasos 1–4, 8 y 9 de E4 no dependen de nada de lo de abajo | **predicción**: deberían pasar al correr el stack (no observado) |
| El cruce del extracto con el ledger (pasos 5–7) | **(4b, resuelto del lado de P2)** el contrato `StatementLine.payment_intent_id` (opcional, `^pi_…`, nulo sin emparejamiento) ya existe; `pay-settlement` cruza por `${payment_intent_id}:capture` y usa `our_reference` solo de respaldo (`reconcile.ts`, probado en tres niveles). **Falta que P4 emita el campo** en `fetchStatement`: sin él las líneas del simulador (`our_reference = ch_…`) caen al respaldo y dan 4 excepciones en vez de 1 (`missing_in_ledger` ×2 + `missing_in_statement` ×2) | **depende de P4** (emisión del campo); la precondición del paso 5 lo detecta primero y con un mensaje claro |
| «Corte semanal» sobre cobros frescos | **el reloj**: el ledger real pone `posted_at` con su reloj y el corte exige una fecha pasada (`future_cutoff`). **Decisión 4b (coordinador):** no se agrega un reloj controlable ni en producción ni en el sandbox desplegable. **Cobertura declarada:** la liberación a T+7 se prueba con el ledger doble / reloj de prueba en `pay-settlement/test/batch.spec.ts`; E4 solo comprueba que el corte real **NO libera lo fresco** (`released_minor = 0`) y mueve el dinero ya liberado entrado como [DOBLE] | **cobertura declarada**: T+7 contra el ledger real queda sin ejercitar end-to-end |
| El banco real (**Q-11**) | **el formato real del Banco Mercantil**, que nadie ha entregado. Los importadores de P2 (JSON normalizado, CSV y `camt.053`, el estándar ISO 20022) son genéricos: **no se asume ni se inventa** ningún campo del Mercantil | E4 en verde contra el simulador **no** prueba la conciliación con el banco real |

**Conclusión por escrito:** «E4 en verde» se puede cumplir **contra el sandbox** sin Q-11 una vez que P4 emita `payment_intent_id` (propuesta 15, aplicada en el contrato); eso cerraría REQ-P2-6 contra el simulador `mock`. P2.H2.M6 **no** puede pasar a
`HECHO` «contra el banco real» sin Q-11. Quedó partido (4b) en **M6a** («E4 en verde contra el sandbox») y **M6b** («paridad con el formato real del Mercantil», que depende de Q-11 y de T-03); M6a `A MEDIAS` (falta la emisión de P4 y correr E4), M6b `BLOQUEADO`.

E8 depende además de **`pay-mockbank`** (P4.H4.M3): el coordinador confirmó (4b, propuestas 17/18) que P4 expone ahí los importes de los escenarios y el depósito del pagador; hoy el depósito se inyecta solo desde dentro del proceso de `pay-connectors` (`TRANSFER_BANK.injectStatementLine`, sin endpoint). `payerTransfersToBank` es el único
punto a cambiar y falla diciendo por qué; no se inventó ninguna API. Y de D-29/D-30 (el cobro por la API pública hoy se deniega).

## Lo que cada archivo pasa a ser cuando se desbloquea

`git mv e2e/pending/e4.e2e.ts e2e/flows/` (y e8) **sin otro cambio**; antes, correr `yarn e2e:pending` y revisar la predicción de arriba. Si el stack se levanta con `SETTLEMENT_RELEASE_DAYS` o un huso distinto no cambia nada: ver «el reloj».

## No cubierto

- Nada de esto se ejecutó. La predicción de qué pasa hoy es lectura de código de `pay-settlement`, `pay-connectors` y el arnés.
- El tramo `pay-payments` → ledger de E8 (D-29/D-30) y el depósito real (pay-mockbank).
- La liberación a T+7 contra el ledger real (cobertura declarada: ledger doble en `batch.spec.ts`; E4 solo prueba que no libera lo fresco); el abono mensual y la deuda por contracargo en un corte real.
- El formato real del banco (Q-11) y la cuenta recaudadora (T-03).
