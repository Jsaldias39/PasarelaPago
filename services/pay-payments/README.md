# pay-payments

> Dueño: **P3** · Base propia: `pay_payments` · Plan: [`docs/plan/PLAN-MAESTRO.md`](../../docs/plan/PLAN-MAESTRO.md)

Intención de pago, máquina de estados, sagas en Temporal (cobro, reembolso, anulación, disputa), idempotencia, cotización, medios de pago.

Este servicio no lee la base de ningún otro y no importa código de otro servicio: solo `contracts/` y las librerías `@pay/*`. Se crea desde la plantilla de `platform/` (P1.H1.M2).
