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
