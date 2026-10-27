# Inyección de fallos de pay-payments (P3.H2.M8)

Generado por `services/pay-payments/test/failures.matrix.spec.ts` contra Postgres, Temporal y NATS reales y los dobles de riesgo, conectores y ledger ([DOBLE], regla 65). Cada fila es lo OBSERVADO en la corrida, no lo esperado.

**Clase:** *definitivo* = respuesta que el contrato declara (4xx con su cuerpo, `502 connector_unavailable` exacto, rechazo 422 del ledger); *ambiguo* = timeout, corte, otro 5xx o respuesta fuera de contrato (no prueba que la orden no se ejecutó: se conserva el estado, se reintenta con la MISMA clave y se escala).

| # | Dependencia | Fallo inyectado | Clase | Esperado | Observado | Asientos del ledger | Escalado a una persona |
|---|---|---|---|---|---|---|---|
| 1 | pay-risk | 503 Service Unavailable | fail-closed (no mueve dinero) | failed risk_unavailable, sin cargo | failed (risk_unavailable), cargo creado: no | 0 | no |
| 2 | pay-risk | no responde (timeout 300 ms) | fail-closed (no mueve dinero) | failed risk_unavailable en pocos segundos | failed en 876 ms | 0 | no |
| 3 | pay-risk | respuesta lenta (150 ms < 300 ms) | sin fallo | el cobro sigue | requires_action | 0 | no |
| 4 | pay-connectors | 502 problem+json connector_unavailable (crear cargo) | definitivo (no se envió nada) | reintenta y cierra failed connector_unavailable | failed (connector_unavailable); POST /charges: 9 llamadas en total | 0 | no |
| 5 | pay-connectors | 500 al crear el cargo, luego vuelve | ambiguo | processing + escalado; al volver, 1 solo cargo y succeeded | processing → requires_action → succeeded; cargos creados: 1 | 1 | charge_outcome_unknown |
| 6 | pay-connectors | 422 validation_failed (rechazo del proveedor) | definitivo | failed, sin asiento | failed (validation_failed) | 0 | no |
| 7 | pay-ledger | 3 respuestas 500 seguidas | ambiguo | se reintenta con la misma clave; 1 asiento | succeeded | 1 | no |
| 8 | pay-ledger | 500 sostenido tras el cobro del banco, luego vuelve | ambiguo | processing, sin devolver el dinero, escalado; al volver 1 asiento | processing (devoluciones al banco: 0) → succeeded | 1 | ledger_outcome_unknown |
| 9 | pay-ledger | 422 insufficient_funds al registrar el cobro | definitivo | compensa: devuelve el dinero en el conector y cierra failed | failed (insufficient_funds); devoluciones al banco: 1 | 0 | no |
| 10 | pay-connectors (eventos) | captured ×3, authorized atrasado y failed contradictorio | duplicado / obsoleto / contradicción | un solo estado terminal y un solo asiento | succeeded; eventos terminales: 1 | 1 | no |
| 11 | pay-connectors | 502 connector_unavailable exacto al reembolsar | definitivo (sin efecto) | anula la retención; reembolso failed | failed; retención voided; saldo 20000 | 0 | no |
| 12 | pay-connectors | 500 al reembolsar, luego vuelve | ambiguo | retención conservada, escalado; al volver se confirma 1 vez | pending (retención pending) → succeeded (retención posted) | 1 retención confirmada | refund_outcome_unknown |
| 13 | pay-ledger | 500 al crear la retención, luego vuelve | ambiguo | pending sin tocar al conector; al volver se completa | pending → succeeded | 1 retención confirmada | hold_outcome_unknown |
| 14 | pay-connectors (eventos) | devolución `pending` y el aviso nunca llega | ambiguo (sin consulta posible) | no se libera la retención ni se da por fallido; escalado | pending, retención pending, esperando el aviso sin plazo | 0 confirmadas | refund_pending_timeout |
| 15 | pay-ledger | 500 al debitar el contracargo, luego vuelve | ambiguo | sigue abierta y escalada; al volver 1 débito | open → lost | 1 | dispute_ledger_unknown |

No inyectado aquí (ver REPORTE): caída del worker (`payment.kill.spec.ts`, SIGKILL real, 5 corridas), caída de Postgres, partición de red de NATS.
