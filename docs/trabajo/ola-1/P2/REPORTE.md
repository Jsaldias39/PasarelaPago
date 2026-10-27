> **AVANCE: 15 / 18 — 83,3 %.** (`HECHO` 15 · `A MEDIAS` 3 · `TODO` 0 · `BLOQUEADO` 0)

# Reporte P2 — ola 1: `pay-ledger` y `pay-settlement`

- Fecha: 2026-10-27 · Carril: [`P2-ledger-y-liquidacion.md`](../../../plan/carriles/P2-ledger-y-liquidacion.md) · Rama: `claude/adoring-allen-ly7r6f` (sin commit: lo hace el integrador)
- **Peldaño de evidencia: `TESTED`** en las 15 `HECHO`. No hay `VERIFIED` ni `REGRESSION_VERIFIED`: falta el stack E1–E8 (ola 3) y un banco real.
- Gates literales: [`evidencia/gates.txt`](./evidencia/gates.txt) (typecheck, build, `yarn lint` de la raíz y eslint del carril: todos `exit=0`).
- Corridas repetidas: [`evidencia/corridas-repetidas.txt`](./evidencia/corridas-repetidas.txt): **pay-ledger 3/3 (138 pruebas)** y **pay-settlement 3/3 (404 pruebas)** con el código final, de a una suite por vez (antes de la última reforma hubo 5/5 de cada una).

## Completado (CA cumplido y DoD ejecutado; salida en `evidencia/<ID>.txt`)

| ID | Qué se logró | Prueba principal |
|---|---|---|
| H1.M3 | Cuenta lógica ↔ id de 128 bits determinista; plan de cuentas | `ids.spec` (propiedad), `config.spec` |
| H1.M4 | `POST /transactions` atómico e idempotente por `(business_ref, attempt)` con regla de intentos del servidor | `transactions.spec` contra TigerBeetle real: 10 llamadas idénticas simultáneas ⇒ una efectiva |
| H1.M5 | Retenciones en dos fases con vencimiento | `holds.spec` |
| H1.M6 | `GET /balances` y `/statements` paginados, orden determinista | `statements.spec` |
| H1.M7 | Invariante global (job + prueba) y `ledger.transfer.posted` por outbox | `invariant.spec`, `events.spec` (relé a NATS real) |
| H1.M8 | Saldo AloVida: saldo justo aceptado, un centavo más rechazado sin efecto | `transactions.spec` |
| H1.M9 | Rastro de rechazos en Postgres | `transactions.spec` |
| H2.M2 | Corte semanal idempotente por `cutoff_date`; T+7 con marca de agua; deuda del comercio neteada | `batch.spec` (29): 5 cortes simultáneos ⇒ 1 lote y 1 pago por comercio |
| H2.M3 | `PayoutRail` + `bank_transfer` (modo A) + `acquirer_settlement` (doble, modo B) | `rails.spec`, `connectors-client.spec` (servidor HTTP validado contra el contrato), `ledger-client.spec` |
| H2.M4 | Payout: retener → riel → confirmar/anular; ambiguo ⇒ hold vivo | `payout.spec`, `ledger-real.spec` (pay-ledger REAL en proceso aparte: 20 pagos simultáneos ⇒ exactamente 6) |
| H2.M5 | Comisión programada 7.8 y contracargo (D-22): neteo parcial y deuda abierta | `netting.spec` |
| H2.M7 | Exportación para M16 que cuadra con `platform:fees` | `export.spec` |
| H2.M8 | Modo B declarado como doble; no arranca con `PAY_MODE=live` | `health-mode.spec`, `payout.spec`, `config.spec` |
| H2.M9 | Abono mensual una sola vez por mes; deuda si no alcanza | `netting.spec` |
| H1.M1 | (ya `HECHO` antes: spike) | — |

> **Línea exigida por H2.M8 — DOBLE DECLARADO:** con `settlement.mode=acquirer` el servicio arranca y `GET /health/ready` informa `settlement.simulated: true`; el riel
> `acquirer_settlement` es un doble (D-02 eligió el modo A), no mueve dinero y todo payout que pasa por él sale `simulated: true`.

## A medias

### H1.M2 — esquema `pay_ledger` por el pipeline del modelo
- **Qué anda:** `sql/001_ledger.sql` con índices y restricciones con nombre explícito; `schema-map.ts`; verificador de deriva SQL ↔ base ↔ mapa que detecta tabla ausente, columna ausente, columna obligatoria no mapeada, nulabilidad, tipo, tabla sin mapear e índice con nombre generado (`drift.spec`, 5 pruebas, incluidas las que provocan cada deriva).
- **Qué no anda:** el esquema NO está en `mantra-core-health-model` ni pasó por `.puml → SQL/ → base → ORM`: ese repo todavía no existe (D-18).
- **Qué falta exactamente:** (1) declarar las 6 tablas en el modelo; (2) generar el DDL de ahí y borrar `sql/`; (3) reemplazar `schema-map.ts` por las entidades del ORM y repetir `drift.spec`.
- **Dónde quedó:** `services/pay-ledger/sql/001_ledger.sql`, `src/ledger/schema-map.ts`, `test/drift.spec.ts`; compila y pasa.

### H2.M1 — esquema `pay_settlement` por el pipeline del modelo
- **Qué anda:** `sql/001_settlement.sql` (12 tablas, restricciones probadas en `drift.spec`: pagos terminales, cobro de más, doble abono, doble lote, excepción duplicada), mapa y verificador de deriva.
- **Qué no anda:** igual que H1.M2: no está en el modelo.
- **Qué falta exactamente:** los mismos 3 pasos para las 12 tablas.
- **Dónde quedó:** `services/pay-settlement/sql/`, `src/settlement/schema-map.ts`, `test/drift.spec.ts`; compila y pasa.

### H2.M6 — conciliación (importador `camt.053` + CSV, cruce, excepciones)
- **Qué anda:** importadores JSON/CSV/camt.053 (fechas inválidas, XML truncado, XXE, entradas agrupadas, comillas sin cerrar), cruce puro (propiedad de 200 casos), 5 clases de excepción, dedupe entre corridas, corridas que fallan enteras sin asentar nada, resolución con `OperatorToken` (alg none/HS256/firma/exp/aud/roles), confirmación de payouts por extracto. El ledger no se toca (verificado contra el doble y contra el pay-ledger real).
- **Qué no anda:** el DoD pide «E4 en verde» y E4 es de la ola 3; el formato real del banco (camt.053 vs CSV vs API, y qué devuelve como nuestra referencia) no existe (Q-11), así que `camt.053` sigue la norma estándar, no el banco.
- **Qué falta exactamente:** correr E4 sobre el stack sandbox; ajustar el importador cuando el Mercantil entregue su formato; definir el tope de montos de `request_adjustment` (`x-open-question`).
- **Dónde quedó:** `src/settlement/{statement-parsers,reconcile,reconciliation.service,operator-token}.ts`; compila y pasa.

## Pendiente

Ninguna microtarea en `TODO` ni `BLOQUEADO`. Las decisiones que dependen de otros están en [`DECISIONES-TOMADAS.md`](./DECISIONES-TOMADAS.md) y los cambios de contrato en [`PROPUESTAS.md`](./PROPUESTAS.md) (16).

## Dobles (regla 65 / CLAUDE.md #10): todos declarados y ejercitados en los tres niveles

| Colaborador | Doble | Correcto | Límite | Inválido |
|---|---|---|---|---|
| `pay-ledger` (para settlement) | `FakeLedger` (`test/helpers/fakes.ts`) con las reglas reales: partida doble, `available` sin negativo, `(business_ref, attempt)`, retenciones con vencimiento. **Además se prueba contra el pay-ledger REAL** (`ledger-real.spec`) | cobro, liberación, payout | 1 centavo, saldo justo, retención vencida en tránsito | saldo insuficiente, caída con el asiento ya aplicado, respuesta de proxy |
| `pay-connectors` | `FakeConnectors` (en memoria) y `ConnectorsServer` (HTTP real, **respuestas validadas contra `internal-connectors-v1.yaml`**; las pruebas exigen cero violaciones) | transferencia pagada / en tránsito | confirmación tardía, orden repetida | 502 de proxy, 504, 404 genérico, corte, timeout, cuerpo ilegible ⇒ ambiguo; solo `502 connector_unavailable` y `404 transfer_not_found` son definitivos |
| Rail del modo B | `AcquirerSettlementRail` (doble de producción, `simulated: true`) | pago simulado | 1 centavo / entero máximo | monto 0, negativo, decimal, NaN |
| Extractos del banco | JSON/CSV/camt.053 sintéticos | extracto que cuadra | línea justo en `to`; BOM | archivo malformado ⇒ corrida `failed`, cero asientos |
| Servicio de identidad | claves RSA generadas en cada corrida | token válido | `exp`/`nbf` en el borde de la tolerancia | 14 formas de token inválido |

Quedan verificados SOLO contra el doble y pendientes contra lo real: el corte con ventana de tiempo (el ledger real fija `posted_at` con su reloj y no se puede retroceder), el riel `bank_transfer` contra un `pay-connectors` real (P4 aún no implementa `/transfers`), y los consumidores contra los eventos reales de P5.

## No cubierto

- E1–E8 y la prueba de carga a 2× el volumen (>100.000 pagos/día): el corte procesa comercio por comercio, **sin medición**; la conciliación carga el extracto en memoria (tope 20 MB / 200.000 líneas).
- mTLS: el `X-Service-Id` no se contrasta con el certificado (límite conocido de `@pay/service-auth`).
- La escalación de un pago en tránsito sin resolver es una fila de auditoría y un log de error: no hay pantalla ni alerta (la consola está fuera del plan).
- Un payout cuya retención vence mientras el banco paga queda `in_transit` sin resolverse (P2-D13); solo lo resuelve una persona.
- Rendimiento del ledger, recuperación de TigerBeetle multi-réplica (en desarrollo corre un solo nodo).

## Desvíos del plan y errores propios corregidos (detalle en `evidencia/corridas-repetidas.txt`)

- Error mío (dos veces): primero puse `pending` con invariante sin avisar; luego lo quité para calzar con P3 y eso permitía crear dinero. Corregido otra vez tras la revisión de seguridad (P2-D2): `pending` es no-negativo y el exceso de un contracargo va a `merchant:{id}:debt`; el corte netea esa deuda. el ledger parte el contracargo por el servidor (una pata bruta de P3 ⇒ `pending` por lo que haya + `debt` por el exceso, en un lote enlazado), así que P3 no cambia.
- `POST /charges` y `GET /exports/accounting` existen **fuera del contrato** (PROPUESTAS #10, #11); la prueba de contrato lista exactamente esas dos rutas extra.
- La verificación de deriva compara contra un mapa del código y no contra entidades de un ORM, porque ningún servicio de esta ola usa ORM (P2-D24).

## Riesgos residuales

- El mapa de esquema se generó desde la base aplicada: detecta cambios futuros del SQL, pero no habría detectado un error de transcripción inicial; lo cubren las pruebas de integración que ejecutan cada consulta.
- `pay-console` es un nombre provisorio de llamador (P2-D6).
- Dos suites (`ledger-real`, `nats`) dependen de procesos del compose (Postgres, NATS, TigerBeetle) y de `yarn build` en `pay-ledger`; sin ellos fallan con un mensaje claro, no en silencio.

## Procesos que quedaron corriendo

Ninguno de pay-settlement. TigerBeetle de desarrollo (`platform/scripts/tigerbeetle-dev.sh`) lo levanté yo y lo detengo al cerrar.
