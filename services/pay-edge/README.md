# pay-edge

> Dueño: **P1** · Base propia: `pay_edge` · Plan: [`docs/plan/PLAN-MAESTRO.md`](../../docs/plan/PLAN-MAESTRO.md)

Única puerta pública: API key (hash), rate limit, forma, Idempotency-Key obligatoria en los POST, enrutamiento. Sin lógica de negocio.

Este servicio no lee la base de ningún otro y no importa código de otro servicio: solo `contracts/` y las librerías `@pay/*`. Se crea desde la plantilla de `platform/` (P1.H1.M2).
