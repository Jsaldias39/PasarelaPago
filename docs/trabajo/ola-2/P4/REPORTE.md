> **AVANCE (tanda 2a, adaptación a contratos): 7 / 7 pedidos aplicados — 100 %.** Peldaño: `TESTED` (pruebas de integración contra Postgres y NATS reales; sin banco real).

# Reporte P4 — ola 2, tanda 2a

| # | Pedido | Estado | Evidencia |
|---|---|---|---|
| 1 | `GET /refunds/{id}` (`cr_…`, `refresh`, `stale`, solo `pay-payments`), en la matriz de identidad; conteo 10→11 | HECHO | `test/ola2-contratos.spec.ts`, `test/contract.spec.ts` (las 3 rojas pasan) |
| 2 | `refund_id` opcional: se guarda, vuelve en `ConnectorRefund`, va al evento | HECHO | ídem |
| 3 | Eventos con `mock`, ids `ch_`/`cr_` y `card_declined` (borrados `eventConnectorCode` y `connectorTransactionId`) | HECHO | ídem + `callbacks.spec.ts`, `domain.spec.ts` |
| 4 | Datos de la cuenta en `bank_transfer_instructions` (`BANK_TRANSFER_*`; sin cuenta no se inventa) | HECHO | ídem |
| 5 | `connector.transfer.status_changed` por outbox, en la misma transacción que el cambio de estado | HECHO | ídem (validado contra el AsyncAPI) |
| 6 | `pay-qr` prueba contra `contracts/openapi/internal-qr-v1.yaml` | HECHO | `pay-qr/test/qr.spec.ts` (44 pasan) |
| 7 | Regla 11 y la carrera de envíos intactas | HECHO | las suites de la ola 1 siguen verdes (562) |

Gates literales en `evidencia/`: `connectors-typecheck`, `connectors-build`, `connectors-test-1/2` (562 pasan, 2 corridas), `qr-typecheck`, `qr-build`, `qr-test-1/2` (44 pasan, 2 corridas), `eslint-raiz` (exit 0). Una suite a la vez, `--maxWorkers=2`.

**A MEDIAS / no hecho:** `X-Pay-Mode` (D-28, la recomendada «f»; no estaba en el pedido de esta tanda). Adaptadores del Mercantil: siguen sin documentación.
**No cubierto:** nada se ejercitó contra un banco real; la cuenta de la transferencia es sintética en sandbox (T-03).
**Decisiones:** `DECISIONES-TOMADAS.md` (D-P4-22 a D-P4-28).

---

> **AVANCE (tanda 2b, D-28 `X-Pay-Mode`): 6 / 7 pedidos aplicados; 1 no aplicable (`mode` en eventos: el contrato no lo admite).** Peldaño: `TESTED`.

| # | Pedido | Estado | Evidencia |
|---|---|---|---|
| 1 | `X-Pay-Mode ∈ {test, live}` exigido en charges, refunds, transfers y qr; ausente/inválido ⇒ 403 sin efecto | HECHO (8 ops de connectors + 6 rutas de qr) | `test/pay-mode.spec.ts` (92), `pay-qr/test/pay-mode.spec.ts` |
| 2 | Modo de la petición = modo del despliegue y del conector (`live`↔sandbox ⇒ 403, nunca cae en live) | HECHO (compuerta + ruteo + CHECK en la base) | ídem |
| 3 | Modo del pedido guardado (`pay_mode`; el del conector se renombró `connector_mode`); lecturas por (id, modo); otro modo ⇒ 404 | HECHO | ídem |
| 4 | Misma `Idempotency-Key` en test y live = dos operaciones | HECHO (scope `llamador\|modo`, índices únicos con `pay_mode`) | ídem |
| 5 | `mode` opcional en los eventos | NO APLICABLE: `connectors.yaml` no lo admite (`additionalProperties: false`); propuesta en `PROPUESTAS.md` | — |
| 6 | Callbacks: el modo sale del registro del cobro | HECHO (`connector_callback_events.pay_mode`) | ídem |
| 7 | Pruebas en 3 niveles + test↔live en los dos sentidos; regla 11 y carrera de envíos intactas | HECHO | 656 + 92 pasan (2 corridas cada una) |
| — | Auditoría de llamadas salientes | HECHO: la única es `HttpQrClient` → `pay-qr`; propaga `X-Pay-Mode` | `qr-client.spec.ts` |

Gates literales en `evidencia/2b-*`: typecheck, build, test×2 (`--maxWorkers=2`) por servicio y `yarn eslint` desde la raíz, todos exit 0.
**Decisiones:** D-P4-29 a D-P4-35. **Hallazgo:** el `health.spec.ts` de la plantilla (10 servicios) tiene una aserción intermitente (`not.toContain('4111')` contra un UUID aleatorio); corregida en los dos míos.

---

> **AVANCE (tanda 2c, arranque del arnés): 5 / 5 pedidos aplicados — 100 %.** Peldaño: `TESTED` (Postgres y NATS reales, procesos `node dist/main.js` reales; sin banco real).

| # | Pedido | Estado | Evidencia |
|---|---|---|---|
| 1 | `BANK_TRANSFER_*`: en sandbox opcionales con valor sintético declarado (rótulo SANDBOX); en live los tres o ninguno, sin cuenta no se inventa | HECHO (tres niveles: correcto, límite, inválido) | `test/ola2-contratos.spec.ts` (8 casos nuevos), D-P4-36 |
| 2 | `PAY_MODE` explícito y sin valor por defecto; bajo `live` no arranca con mock o doble | HECHO en los dos servicios, con el binario real y entorno armado desde cero | `pay-connectors/test/startup.spec.ts` (5), `pay-qr/test/startup.spec.ts` (5), D-P4-37/38/39 |
| 3 | `mode` en eventos de `connectors.yaml` solo como propuesta | HECHO (`contracts/` intacto; propuesta #1 en `PROPUESTAS.md`) | — |
| 4 | Cobro QR de importe normal capturado por callback firmado y por polling; documentado en el README | HECHO (temporizadores reales, espera por condición, control negativo; 8 corridas seguidas verdes) | `test/end-to-end.spec.ts` (4), README «Cobro de punta a punta sin banco real» |
| 5 | `.env.example` coherentes con el arnés | HECHO (`PAY_QR_URL`, secreto del mock, `BANK_TRANSFER_*` opcionales y `QR_ACCOUNT_GUID`) | ambos `.env.example`, ambos README |

**Hallazgo y arreglo (PRODUCT_BUG, D-P4-41):** una corrida con carga de la prueba de punta a punta falló (`evidencia/2c-connectors-test-0-FALLO-carrera.txt`). Causa demostrada: si el callback del banco llegaba entre la respuesta del proveedor y el `UPDATE charge_sent`, ese UPDATE devolvía `provider_status` a `pending` pese a que el callback ya estaba `applied`. Ahora la respuesta síncrona solo fija el estado si el cobro sigue `pending`. La prueba determinista falla sin el arreglo y pasa con él.

**Gates literales** (`evidencia/2c-*`, `--maxWorkers=2`, una suite a la vez): connectors typecheck/build exit 0, 672 pasan ×2; qr typecheck/build exit 0, 97 pasan ×2; `yarn eslint services/pay-connectors services/pay-qr` exit 0. Los dos archivos `2c-connectors-test-0*` son de la corrida previa al arreglo (una falla, conservada a propósito).

**Cambio de comportamiento a avisar:** un despliegue `live` que arrastre variables del simulador (`PAY_SECRET_CONNECTOR_MOCK_*`, `MOCK_PUMP_INTERVAL_MS`, cuenta con rótulo SANDBOX) o un `QR_ACCOUNT_GUID` provisional ahora no arranca.
**No cubierto:** nada contra un banco real; el chequeo de GUID de pay-qr es por rótulo (un GUID de prueba sin esos rótulos pasaría); no se corrió el arnés e2e de P1 completo, solo los equivalentes dentro de mis servicios.
**A MEDIAS:** nada. Adaptadores del Mercantil siguen sin documentación.

---

> **AVANCE (tandas 4a + 4b, capa sandbox `pay-mockbank`): 5 microtareas de P4.H4 — 4 HECHO, 1 A MEDIAS (M4); 4 / 4 pedidos de la 4b aplicados.** Peldaño: `TESTED` (procesos reales de `pay-mockbank` y `pay-qr`, Postgres real; sin banco real). Carril: 16 / 22 — 72,7 %.

| ID | Qué | Estado | Evidencia |
|---|---|---|---|
| P4.H4.M1 | Suite de contrato por conector (`mock`, `bank_transfer`; `mercantil_qr`/`mercantil_card`) | HECHO para `mock` y `bank_transfer`; los dos del Mercantil **BLOQUEADOS** (sin documentación ni ambiente del banco) | `4a-contract-*` |
| P4.H4.M2 | Servicio `services/pay-mockbank` (puerto 3112, base `pay_mockbank`): QR, tarjeta auth/captura/anulación, reembolsos, transferencias, extracto JSON/CSV/`camt.053`, callbacks firmados | HECHO | `4a-mockbank-test-*` |
| P4.H4.M3 | Escenarios por importe en tabla, un test por fila | HECHO | `scenarios.spec.ts`, `ESCENARIOS.md` |
| P4.H4.M4 | Pagador simulado (CLI + endpoint) con `pay-qr` real | **A MEDIAS** (falta E1 del arnés, de P1) | `payer-e2e.spec.ts`, `mockbank.spec.ts` |
| P4.H4.M5 | Guardia de modo | HECHO | `startup.spec.ts` ×2 |
| 4b-1 | `payment_intent_id` y `merchant_id` en el extracto (emparejada ⇒ ambos; sin cobro ⇒ `null`) | HECHO (en `StatementsService`, vale para todo conector) | `statements.spec.ts`, `mockbank.spec.ts` |
| 4b-2 | Depósito del pagador (E8) + tabla de importes para E4/E8 | HECHO | `POST /sandbox/payer/transfer-in`, `ESCENARIOS.md` |
| 4b-3/4 | `yarn lint` de la raíz limpio | HECHO | `4a-yarn-lint.txt` (exit 0) |

**Decisión de integración (D-P4-42):** el conector `mock` habla con pay-mockbank por HTTP si hay `MOCKBANK_URL`; sin ella usa el banco en memoria. No se tocó `contracts/`.
**Gates literales** (`evidencia/4a-*`, `--maxWorkers=2`, una suite a la vez): pay-mockbank typecheck/build exit 0, 93 pasan ×2; pay-connectors typecheck/build exit 0, 758 pasan + 23 `todo` ×2; `test:contract` por conector (mock 37 + 5 todo; bank_transfer 26 + 16 todo; mercantil_* 1 + 1 todo cada uno); pay-qr typecheck/build exit 0, 98 pasan ×2; `yarn eslint` de los tres servicios exit 0 y **`yarn lint` completo exit 0**.
**Hallazgo en el camino (corregido antes de escribirlo en el código):** en el pagador simulado, un monto distinto del QR se rechazaba DESPUÉS de haber pagado; ahora todo se valida antes de tocar nada (`payer.spec.ts`).
**Propuestas (`PROPUESTAS.md` #6 a #9):** contrato del banco simulado, `pay-mockbank` en `POST /qr/decode`, lo que el arnés debe lanzar, y que `pay-connectors`/`pay-qr` todavía no envían `X-Pay-Mode: sandbox`.
**No cubierto:** `yarn e2e` / el stack completo (lo hace P1; no se levantó); nada contra un banco real (el contrato del banco es **ficticio**, no se usa para los adaptadores reales); el ciclo auth/captura/anulación de tarjeta lo expone el banco pero el conector aún no lo usa (D-P4-43); `e2e/lib/p2-bank.ts` (de P2) no se editó: sus constantes coinciden con `ESCENARIOS.md` y solo falta que P2 cambie `payerTransfersToBank` por la llamada documentada.
**A MEDIAS:** P4.H4.M4 — anda el pagador contra `pay-qr` real y el cobro llega a `succeeded` por callback firmado; falta el DoD literal (E1 con `yarn e2e`, que corre P1).
**Decisiones:** D-P4-42 a D-P4-50.
