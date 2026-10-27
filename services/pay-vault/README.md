# pay-vault

> Dueño: **P3** · Base propia: `pay_vault` · Plan: [`docs/plan/PLAN-MAESTRO.md`](../../docs/plan/PLAN-MAESTRO.md)

Bóveda de tarjetas (CDE PCI), basada en hyperswitch-card-vault. Red aislada: solo la alcanza pay-payments.

Este servicio no lee la base de ningún otro y no importa código de otro servicio: solo `contracts/` y las librerías `@pay/*`. Se crea desde la plantilla de `platform/` (P1.H1.M2).
