# pay-risk

> Dueño: **P5** · Base propia: `pay_risk` · Plan: [`docs/plan/PLAN-MAESTRO.md`](../../docs/plan/PLAN-MAESTRO.md)

Reglas y límites, cribado de sanciones con moov Watchman, decisión allow / review / deny.

Este servicio no lee la base de ningún otro y no importa código de otro servicio: solo `contracts/` y las librerías `@pay/*`. Se crea desde la plantilla de `platform/` (P1.H1.M2).
