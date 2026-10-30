> **AVANCE (tanda 4b): 3 / 3 — 100,0 %** (`HECHO` 3). Peldaño: **`TESTED`** en el cruce por `payment_intent_id` (pay-settlement, Postgres + NATS + TigerBeetle reales); **E4 y E8 NO se ejecutaron** (el stack lo corre P1; P4 aún debe emitir el campo). Carril P2: **15 / 19 — 78,9 %** tras partir M6.

# Reporte — P2 ola 2, tanda 4b (cruce por `payment_intent_id`)

Sin commit. Evidencia con prefijo `4b-` en [`evidencia/`](./evidencia/).

## Completado
| ID | Qué se logró | Comando | Resultado |
|---|---|---|---|
| O2.P2.H7.M1 | Cruce por `payment_intent_id` (`pi_…` ⇒ `pi_…:capture`), respaldo `our_reference`, parsers JSON/CSV con el campo opcional | `yarn test` pay-settlement | PASS · `4b-test-payment-intent.txt` |
| O2.P2.H7.M2 | Tres niveles: **correcto** (cruza con `our_reference=ch_…`; una sola `amount_mismatch` −100), **límite** (sin pi ⇒ respaldo; null/ausente; líneas mixtas; duplicados), **inválido** (pi inexistente / de otro modo ⇒ excepción; pi que contradice `our_reference` ⇒ `unknown_reference`; cobro repartido entre comercios ⇒ `unknown_reference`; pi mal formado ⇒ corrida `statement_malformed`) | `yarn test --maxWorkers=2` ×2 | 26 suites, **526/526** en las dos corridas (`4b-test-settlement-run1.txt`, `run2.txt`); pay-ledger 247/247 (`4b-test-ledger.txt`) |
| O2.P2.H7.M3 | E4/E8, FLUJOS, PROPUESTAS 15–19 y carril actualizados; M6 partido en M6a/M6b | typecheck, build, eslint raíz, `yarn lint`, `contracts:lint`, `e2e:typecheck` | todos `exit=0` (`4b-gates.txt`) |

## A medias
### P2.H2.M6a — E4 contra el sandbox
- Qué anda: importadores, cruce por `payment_intent_id`, excepciones, resolución; todo probado contra Postgres/NATS/TigerBeetle reales y dobles de conectores.
- Qué no anda: E4 no se ejecutó; con las líneas actuales del simulador (sin `payment_intent_id`) darían 4 excepciones en vez de 1.
- Qué falta: P4 emite `payment_intent_id` en `fetchStatement`; P1 corre `yarn e2e:pending`; `git mv` a `e2e/flows/`.
- Dónde quedó: `e2e/pending/e4.e2e.ts`, compila y pasa lint.

## Pendiente
| ID | Estado | Qué lo destraba |
|---|---|---|
| P2.H2.M6b | BLOQUEADO | Q-11 (formato real del banco) y T-03; dueño y banco |

## No cubierto
- E4/E8 contra el stack; el campo emitido por P4 (el contrato de P4 se probó con el cliente HTTP real contra un doble de respuesta conforme al contrato).
- **«pi_ de otro comercio»**: la línea no trae comercio; solo se detecta de forma indirecta (cobro del ledger repartido entre comercios) → propuesta 19 (`StatementLine.merchant_id` opcional).
- Un reembolso con `pi_` cruza solo contra la clave `:capture`.
- T+7 end-to-end (decisión 16: sin reloj nuevo): cobertura declarada = ledger doble en `batch.spec.ts`; E4 solo prueba que el corte NO libera lo fresco.
- Importes de escenarios y depósito del pagador: los expone P4 en pay-mockbank (17/18); `e2e/lib/p2-bank.ts` es el único punto a cambiar.

## Desvíos
- Una invocación de más de `yarn lint` dentro del servicio (no tiene ese script) se quitó de la evidencia y se dejó nota en `4b-gates.txt`.

## Decisiones y ambigüedades
- Una línea con `payment_intent_id` y un `our_reference` con forma de `business_ref` de otro cobro es contradictoria: excepción `unknown_reference`, nunca se elige una. Confirmar con el coordinador.
