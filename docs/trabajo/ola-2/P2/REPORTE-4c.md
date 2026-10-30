> **AVANCE (tanda 4c): 3 / 3 — 100,0 %** (`HECHO` 3). Peldaño: **`TESTED`** (pay-settlement contra Postgres, NATS y TigerBeetle reales). E4/E8 no se ejecutaron. Carril P2 sin cambio de total: **15 / 19 — 78,9 %**.

# Reporte — P2 ola 2, tanda 4c (`merchant_id` de la línea)

Sin commit. Evidencia con prefijo `4c-` en [`evidencia/`](./evidencia/).

## Completado
| ID | Qué se logró | Verificación | Resultado |
|---|---|---|---|
| O2.P2.H8.M1 | `StatementLine.merchant_id` (opcional, `^mc_…`) en puertos y parsers JSON/CSV (camt.053 no lo lleva); mal formado ⇒ `statement_malformed` | `statement-parsers.spec`, `connectors-client.spec`, `reconciliation.spec` | PASS |
| O2.P2.H8.M2 | Cruce: si el `merchant_id` de la línea no coincide con el comercio del asiento al que apunta (o las líneas de una clave nombran a comercios distintos) ⇒ excepción **`unknown_reference`**; se decide antes que el importe; sin el campo, igual que antes | `reconcile.spec` (tres niveles), `reconciliation.spec` | PASS |
| O2.P2.H8.M3 | `settlement-events.ts` emite `unknown_reference` tal cual (el contrato del evento ya lo admite) | `reconciliation.spec` valida el evento contra `ledger-settlement.yaml` | PASS |

**Tipo de excepción citado:** `unknown_reference`, de `ReconciliationException.kind` (`internal-settlement-v1.yaml`, enum cerrado: no hay un tipo más específico) y de `reconciliation.exception.opened.kind` (`ledger-settlement.yaml`).

**Tres niveles:** correcto (mismo comercio cruza; igual comercio y otro importe ⇒ una `amount_mismatch`), límite (ausente/`null`; solo con `our_reference`; dos líneas de una clave, una sin campo y otra correcta cruzan), inválido (otro comercio con el importe igual ⇒ `unknown_reference`, con otro importe también una sola; `pi_` inexistente ⇒ `missing_in_ledger` aunque traiga merchant; `merchant_id` mal formado ⇒ corrida `failed`/`statement_malformed`; el ledger no se mueve; repetir la corrida no reabre ni re-notifica).

## Gates (`4c-gates.txt`, `4c-test-settlement-run1..4.txt`, `4c-test-ledger.txt`)
typecheck, build (ledger y settlement), eslint de raíz sobre los archivos de P2, `contracts:lint`, `e2e:typecheck`: `exit=0`. `yarn test` pay-settlement con TigerBeetle real, `--maxWorkers=2`, una suite a la vez:
- **run3 y run4: 26 suites, 547/547 en verde, las dos.**
- run1 y run2 (las primeras dos, conservadas): 546/547, falló `nats.spec.ts › ledger.transfer.posted … guarda el abono` por `Exceeded timeout of 20000 ms`. Clasificación: **ENVIRONMENT (carga de la máquina)**, no producto: la máquina iba con carga 6–10 y 6 procesos jest de otros carriles; `nats.spec` solo da 5/5 y las dos corridas completas siguientes dan 547/547 sin cambiar código. No se subió ningún timeout ni se reintentó dentro de la suite.
- TigerBeetle detenido al final.

## A medias / Pendiente
- P2.H2.M6a: sin cambio (falta que P4 emita `payment_intent_id` y `merchant_id` en `fetchStatement` y correr E4). P2.H2.M6b: BLOQUEADO (Q-11, T-03).
- **`yarn lint` de la raíz falla** por un archivo de P4 (`pay-connectors/test/mockbank.spec.ts`, import sin usar); no es de P2 ni se tocó.

## No cubierto / Desvíos
- Un `merchant_id` en un reembolso con `pi_` se compara igual contra el asiento `:capture`.
- Desvío: se quitó la traducción `unknown_reference → missing_in_ledger` del evento y se cambió la expectativa de un test que la fijaba (cambio de contrato, no debilitamiento: ahora exige `unknown_reference`).
