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
