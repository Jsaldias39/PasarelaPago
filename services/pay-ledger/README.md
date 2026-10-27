# pay-ledger

> Dueño: **P2** · Base propia: `pay_ledger` · Plan: [`docs/plan/PLAN-MAESTRO.md`](../../docs/plan/PLAN-MAESTRO.md)

Partida doble sobre TigerBeetle: cuentas, retenciones en dos fases, saldos, extractos, saldo AloVida, exportación a M16.

Este servicio no lee la base de ningún otro y no importa código de otro servicio: solo `contracts/` y las librerías `@pay/*`. Se crea desde la plantilla de `platform/` (P1.H1.M2).
