# Propuestas P2 — ola 2, tanda 2a

Cosas que **no** son de mi carril o que dependen de un contrato; cada una con quién la decide. Nada de esto se aplicó fuera de `services/pay-ledger` y `services/pay-settlement`.

| # | Propuesta | Por qué | Quién |
|---|---|---|---|
| 1 | `mode` (`test\|live`, opcional) en los datos de `ledger.transfer.posted`, `ledger.hold.*`, `settlement.batch.closed` y `reconciliation.exception.opened` (`ledger-settlement.yaml`) | Hoy solo `payout.*` lo declaran y el esquema es `additionalProperties: false`: el ledger NO puede publicarlo. Consecuencia: `pay-settlement` conoce a los comercios por `ledger.transfer.posted` sin saber en qué modo vendieron (por eso su directorio `settlement_merchants` no tiene modo y un comercio sin movimiento en un modo libera 0 en ese modo). | Coordinador (contratos) |
| 2 | `PayMode` pasa a `required: true` en las 8 operaciones del ledger, las 11 de settlement y `GET /balance` | Los dos servicios ya responden `403` sin la cabecera (CONTRATOS.md §5, fila «recomendada ola 2»). El contrato dice «opcional»; hoy miente. | Coordinador |
| 3 | Documentar en `internal-ledger-v1.yaml` que `tx_…`/`hd_…` incluyen el modo (la misma operación en `test` y en `live` da ids distintos) y que pedir un id de otro modo da `404` | Cambia la derivación de los ids públicos (solo desarrollo: no hay ledger con datos) | Coordinador |
| 4 | `pay-settlement` puede emitir `unknown_reference` tal cual: el contrato ya lo admite | `settlement-events.ts` todavía lo traduce a `missing_in_ledger` (ola 1). No lo cambié: no estaba en el pedido. | P2, próxima tanda |
| 5 | DDL del modo al pipeline `.puml → SQL/ → base → ORM` (D-18): columna `mode` en 6 tablas del ledger y 5 de settlement + `settlement_merchant_marks` | Los `sql/001_*.sql` de los dos servicios son de referencia hasta que exista el modelo | Repo `mantra-core-health-model` |
| 6 | `docs/plan/PLAN-MAESTRO.md` §3.3: las cuentas del plan existen **por modo** (`merchant:X:pending` de `test` y de `live` son dos cuentas) | Está fuera de mi alcance | Coordinador |
| 7 | Rutas de conciliación: hoy exigen el modo (la corrida lee el ledger de UN modo, por lo tanto no se puede evitar). Confirmar que la consola (`pay-console`) manda la cabecera | `pay-console` es un nombre provisorio y no existe | Coordinador / D-1 |
