# Carril P2 — Ledger y liquidación (dinero en reposo)

> **Estado:** `EN CURSO` (ola 1) · **AVANCE: 17 / 19 — 89,5 %** · **Peldaño:** `TESTED` en lo marcado HECHO (pruebas de integración contra Postgres, NATS y TigerBeetle reales, contra el `pay-ledger` real en un proceso aparte y contra dobles declarados de conectores; sin banco real ni stack E1–E8); `A MEDIAS` en H2.M6a; `BLOQUEADO` en H2.M6b
> **Evidencia, decisiones y propuestas de la ola 1:** [`docs/trabajo/ola-1/P2/`](../../trabajo/ola-1/P2/REPORTE.md)
> **Antes de empezar, leé** [`spikes/tigerbeetle.md`](../../spikes/tigerbeetle.md) (hallazgos H-1 a H-7).
> **Predecesor:** P1.H1 (plataforma y plantilla). Ningún otro: los colaboradores se simulan.
> **Carpetas del monorepo:** `services/pay-ledger/`, `services/pay-settlement/` · esquema en `mantra-core-health-model`.
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md)

**Skills:** `accounting-double-entry`, `concurrency-and-locking`, `model-driven-schema`, `data-modeling-plantuml`,
`postgresql-advanced`, `mikroorm-patterns`, `background-jobs-scheduling`, `state-machines-workflows`,
`integrity-testing`, `audit-trail-history`, `data-quality-validation`, `evidence-and-verification`.

## Resultado observable

Cada centavo que entra a la pasarela queda en un libro mayor de partida doble donde débitos y
créditos siempre suman lo mismo. El comercio ve su saldo pendiente y disponible y su extracto.
Una vez por semana (corte fijo, decisión D-08) los fondos pasan de pendiente a disponible y salen como *payout* a su cuenta.
La conciliación contra el extracto del PSP o del banco encuentra las diferencias y las deja como
excepciones, sin taparlas.

**Kill-test:** mandar la misma transferencia (mismo `id`) 10 veces en paralelo y pedir un payout
mayor que el disponible. Si el saldo cambia más de una vez, o si el payout se acepta, no está
hecho. Y sumar todos los débitos y créditos del ledger después de E1–E5: si no dan igual, tampoco.

## Contratos

- **Expone:** `internal/ledger/v1` (transfers, holds con `post`/`void`, balances, statements),
  `internal/settlement/v1/payouts`, el plan de cuentas (§3.3 del maestro) y los eventos
  `ledger.*`, `payout.*`, `settlement.batch.*` y `reconciliation.exception.*`.
- **Consume:** `payment_intent.succeeded`, `refund.*` (P3); `connector.transaction.status_changed`
  y la API de extractos de conectores (P4); `fee_schedule.published` (P5) solo para la comisión
  semanal.

## Criterios

- **REQ-P2-1** — Dada una transferencia con `id` X, cuando se envía N veces, entonces existe una sola y las siguientes devuelven el mismo resultado. — `TESTED` (`transactions.spec`: 10 llamadas simultáneas idénticas ⇒ una efectiva; contra TigerBeetle real)
- **REQ-P2-2** — Dada una cuenta `merchant:*:available` con 50,00, cuando se pide un débito de 50,01, entonces se rechaza con `code=insufficient_funds` y el saldo no cambia. — `TESTED` (`transactions.spec`, `payout.spec`, `ledger-real.spec`)
- **REQ-P2-3** — Dada una retención pendiente con vencimiento, cuando pasa el plazo sin `post` ni `void`, entonces el monto vuelve a la cuenta original. — `TESTED` (`holds.spec`: vencimiento corto)
- **REQ-P2-4** — Dado cualquier momento, cuando se suman todos los débitos y créditos, entonces son iguales (invariante verificada por un job y por test). — `TESTED` (`invariant.spec`: por job y por prueba)
- **REQ-P2-5** — Dado el corte semanal, cuando corre la liquidación, entonces cada comercio con saldo pendiente vencido pasa a disponible y se crea un lote de payout por comercio, una sola vez aunque el job corra dos veces. — `TESTED` (`batch.spec`: dos corridas y cinco simultáneas del mismo lunes ⇒ un lote y un pago por comercio)
- **REQ-P2-6** — Dado un extracto con una línea que no coincide con el ledger, cuando corre la conciliación, entonces se crea una excepción con la diferencia y el ledger **no** se ajusta solo. — `TESTED` (`reconciliation.spec`: el ledger no cambia; falta E4 sobre el stack)
- **REQ-P2-7** — Dado `settlement.mode=acquirer`, cuando se pide un payout, entonces se usa el rail `acquirer-settlement` (doble) y el reporte lo declara. — `TESTED` (`payout.spec`, `health-mode.spec`; doble declarado, D-02)
- **REQ-P2-8** — Dado un periodo cerrado, cuando se exportan los asientos, entonces la exportación cuadra con el ledger y M16 la puede importar. — `TESTED` (`export.spec`)

## H1 — `pay-ledger` (olas 0 y 1)

**CA:** Dado `pay-payments`, cuando registra un cobro, entonces el asiento es atómico, idempotente y respeta los invariantes de saldo.
**DoD:** REQ-P2-1 a 4 con tests contra TigerBeetle y Postgres reales.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P2.H1.M1 | **Spike** TigerBeetle: cliente Node, dos fases, invariantes, vencimiento, licencia confirmada en su `LICENSE` | Responde sí o no a «¿sirve?», con criterio escrito | `evidencia/spike-tigerbeetle.md` con las salidas → [spike](../../spikes/tigerbeetle.md): **SÍ con condiciones** (`TESTED`) | HECHO |
| P2.H1.M2 | Esquema `pay_ledger` (metadatos de cuentas y transferencias) en el modelo, por el pipeline | Sin deriva modelo ↔ base ↔ ORM | Salida del verificador de deriva | HECHO — `pay-modules/diagram_72_pay_ledger.puml` → `SQL/pay/72_pay_ledger/ddl.sql` en `mantra-core-health-model` @ `af60b79`, vendorizado en `services/pay-ledger/sql/ddl.sql` (`scripts/vendor-model-sql.sh --check` → `PASS  pay-ledger: sql/ddl.sql coincide con el modelo (282 líneas)`, `evidencia/3c-vendor-check.txt`). `drift.spec` 5/5 contra ese `ddl.sql` y suite completa 276/276 ×2 con TigerBeetle real (`docs/trabajo/ola-3/P2/evidencia/3c-test-pay-ledger-run1.txt`, `…run2.txt`); el `001_ledger.sql` de referencia se quitó. **ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18)** |
| P2.H1.M3 | Plan de cuentas y mapeo cuenta lógica ↔ id de 128 bits, determinista | La misma cuenta lógica da siempre el mismo id | Test de propiedad | HECHO |
| P2.H1.M4 | `POST /transfers` (lote enlazado, atómico) con `business_ref` estable + `attempt`; el servidor deriva el id de 128 bits. Un rechazo exige subir `attempt` (H-TB1) | REQ-P2-1 y 2; tras un rechazo, el mismo `attempt` devuelve el mismo rechazo y `attempt`+1 se acepta; **un `attempt` nuevo tras un intento aceptado, o con salto, da `409 invalid_state_transition` sin mover dinero** | Test concurrente (10×) contra TigerBeetle real | HECHO |
| P2.H1.M5 | `POST /holds`, `/holds/{id}/post`, `/holds/{id}/void` con vencimiento | REQ-P2-3 | Test con vencimiento corto | HECHO |
| P2.H1.M6 | `GET /balances` y `/statements` paginados, con orden determinista | Extracto estable entre páginas | Test pegado | HECHO |
| P2.H1.M7 | Job de invariante global + evento `ledger.transfer.posted` por outbox | REQ-P2-4; sin outbox no hay evento | Test pegado | HECHO |
| P2.H1.M8 | Medio de pago **saldo AloVida**: transferencia de `merchant:{id}:available` (o billetera del usuario) al comercio cobrador, atómica y con invariante de saldo | Saldo insuficiente → rechazo sin efecto; saldo justo → aceptado | Test contra TigerBeetle real | HECHO |
| P2.H1.M9 | Rastro de rechazos en Postgres (`pay_ledger`): TigerBeetle no guarda las transferencias rechazadas (H-TB2) | Toda transferencia rechazada deja una fila con `business_ref`, `attempt` y motivo | Test de integración: rechazar una transferencia y encontrar su fila | HECHO |

## H2 — `pay-settlement` (olas 1 y 2)

**CA:** Dado el corte semanal, cuando corre la liquidación, entonces cada comercio cobra lo suyo una sola vez y lo que no cuadra queda a la vista.
**DoD:** REQ-P2-5 y 6 + flujo E4 en verde.

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| P2.H2.M1 | Esquema `pay_settlement` (lotes, payouts, corridas, excepciones) en el modelo | Sin deriva | Verificador de deriva | HECHO — `pay-modules/diagram_78_pay_settlement.puml` → `SQL/pay/78_pay_settlement/ddl.sql` @ `af60b79`, vendorizado en `services/pay-settlement/sql/ddl.sql` (`--check` → `PASS  pay-settlement: sql/ddl.sql coincide con el modelo (463 líneas)`). `drift.spec` 6/6 y suite completa 560/560 ×2 con TigerBeetle real (`docs/trabajo/ola-3/P2/evidencia/3c-test-pay-settlement-run1.txt`, `…run2.txt`); el `001_settlement.sql` de referencia se quitó. **ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18)** |
| P2.H2.M2 | Job de corte: `pending → available` según la política del comercio (T+N), idempotente por `(merchant, periodo)` | REQ-P2-5 corriendo el job 2 veces | Test pegado | HECHO |
| P2.H2.M3 | Interfaz `PayoutRail` + `bank-transfer` (modo A) + `acquirer-settlement` (doble del modo B) | Elige por `settlement.mode` | Test de los dos modos | HECHO |
| P2.H2.M4 | Payout: retención en `merchant:available` → rail → `post` o `void` según el resultado | Rail falla → retención anulada, saldo intacto | Test con rail en fallo | HECHO |
| P2.H2.M5 | Comisión semanal de proveedores (7.8): neteo contra saldo o cargo programado, según el acuerdo | El neteo deja el asiento correcto | Test pegado | HECHO |
| P2.H2.M6a | Conciliación contra el **sandbox**: importadores `camt.053` + CSV + JSON, cruce por `payment_intent_id` (respaldo `our_reference`), excepciones | REQ-P2-6 | E4 en verde | A MEDIAS — Importadores, cruce (clave `payment_intent_id`, 4b), excepciones y resolución con credencial de operador: probados en tres niveles. Falta que P4 emita `payment_intent_id` en `fetchStatement` y correr E4 (`e2e/pending/e4.e2e.ts`) contra el stack. T+7 con ledger doble en `batch.spec.ts`; E4 solo prueba que el corte no libera lo fresco |
| P2.H2.M6b | Conciliación: paridad con el **formato real del banco** | REQ-P2-6 contra el extracto real | Extracto real conciliado | BLOQUEADO — Q-11 (formato real del Mercantil) y T-03 (cuenta recaudadora, visto bueno legal); dependen del dueño y del banco. Nada se asume ni se inventa |
| P2.H2.M7 | Exportación de asientos para M16 (accounting) | REQ-P2-8: la exportación cuadra | Test de cuadre pegado | HECHO |
| P2.H2.M8 | Dejar el rail del modo B como doble declarado detrás de `settlement.mode` (D-02: se eligió el modo A) | Con `settlement.mode=acquirer` el servicio arranca y el reporte dice que es un doble | Test + línea en `REPORTE.md` | HECHO |
| P2.H2.M9 | **Abono mensual** del comercio (D-07): cargo por neteo contra su saldo en el corte, o deuda si no alcanza | El corte deja el asiento del abono una sola vez por mes | Test pegado | HECHO |

## Dobles (regla 65)

| Colaborador que falta | Contrato | Correcto | Límite | Inválido |
|---|---|---|---|---|
| P3 (llamador del ledger) | `internal/ledger/v1` | Cobro 100,00 → 97,50 + 2,50 | Monto de 1 centavo; comisión que redondea | Transferencia desbalanceada → `422`, sin efecto |
| P4 extractos | API de extractos / `camt.053` | Extracto que cuadra | Extracto con una línea de un día distinto (corte) | Archivo malformado → corrida fallida y reportada, sin asientos |
| Rail del modo B | `PayoutRail` | Payout confirmado | Confirmación tardía (después del corte) | Rechazo → retención anulada |

**Modo B:** la decisión D-02 eligió el modo A. El rail del modo B queda como doble declarado; operarlo de verdad exige licencia y una decisión nueva.

## Gates y entrega

Gates de §7 del maestro + **97.7** (qué cambió en el modelo, salida de la aplicación, deriva en
verde, consultas de huérfanos y duplicados). PRs contra `dev`, mergeables (regla 35).

**Matriz de gates de la ola 3 (PASS/GAP por gate, con comando y salida):** [`docs/trabajo/ola-3/P2/GATES.md`](../../trabajo/ola-3/P2/GATES.md).
