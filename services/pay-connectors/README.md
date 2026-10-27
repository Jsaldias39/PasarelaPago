# pay-connectors

> Dueño: **P4** · Base propia: `pay_connectors` · Plan: [`docs/plan/PLAN-MAESTRO.md`](../../docs/plan/PLAN-MAESTRO.md)

Interfaz Connector y adaptadores (simulador, Banco Mercantil Santa Cruz para QR y tarjeta, transferencia), ruteo por reglas, callbacks, consulta de estado.

Este servicio no lee la base de ningún otro y no importa código de otro servicio: solo `contracts/` y las librerías `@pay/*`. Se crea desde la plantilla de `platform/` (P1.H1.M2).
