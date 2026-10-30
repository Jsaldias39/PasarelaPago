> **AVANCE (tanda 3e P2): E4 y E8 de punta a punta en verde (14/14) · P2.H2.M6a → HECHO · carril P2: 18 / 19 — 94,7 % (queda M6b, BLOQUEADO por Q-11/T-03).**

# Reporte corto — P2 tanda 3e

Sin commit. Detalle: [`GATES.md`](./GATES.md) (gate 13 y sección 1), [`PROPUESTAS.md`](./PROPUESTAS.md) #29, #32–#34, evidencia `evidencia/3e-*`. Peldaño: `TESTED` (el stack real corrió E4/E8); sin banco real ni Jaeger.

## Completado
| Qué | Comando | Resultado |
|---|---|---|
| **E4** contra el stack real (11 servicios + `pay-mockbank`) | `yarn e2e:pending e2e/pending/e4.e2e.ts` | 8/8 (`3e-e4-run1.txt`) |
| **E8** contra el stack real | `yarn e2e:pending e2e/pending/e8.e2e.ts` | 6/6 (`3e-e8-run6.txt`) |
| E4 + E8 ya en la suite por defecto (`git mv` a `e2e/flows/`) | `yarn e2e e2e/flows/e4.e2e.ts e2e/flows/e8.e2e.ts --verbose` | `Tests: 14 passed, 14 total`, `rc=0` |
| Ledger y settlement, suites completas ×2 | `yarn test --maxWorkers=2`, TigerBeetle y NATS propios | ledger 21/21 suites · **301/301** ×2; settlement 30/30 suites · **572/572** ×2; `rc=0` en las cuatro |
| `yarn typecheck`, `yarn build` (ambos), `eslint`, `yarn lint` raíz, `yarn e2e:typecheck` | `evidencia/3e-gates.txt` | todos `exit=0` |
| `guardPool` de `@pay/idempotency` en lugar de mis copias (cambio mecánico) | suites de arriba + `pool-resilience` 10/10 | borrado `src/pool-guard.ts` ×2 |

## Diagnóstico de cada fallo (clasificado con evidencia)
| Fallo | Clase | Dueño | Qué se hizo |
|---|---|---|---|
| E8: «E8 necesita pay-mockbank…» | `TEST_BUG` | P2 | `payerTransfersToBank` ahora llama a `POST /sandbox/payer/transfer-in` |
| E8: `startStack` sin banco | `TEST_BUG` | P2 | `mockbank: true` |
| E8: `transfer-in` responde 201, el doc dice 200 | doc | P4 (#32) | el helper acepta 200/201 |
| E8: cobro `requires_action` 60 s con el depósito ya hecho; sin evento `captured` | `TEST_BUG` (config del arnés) | P2 / P1 (#33) | el conector solo concilia por temporizador (5 min); E8 pasa `RECONCILE_INTERVAL_MS=1000` por `envOverrides`. Aserciones intactas |
| Corridas E8 3 y 5 | `ENVIRONMENT` | P5/P1 | colisión de stacks / stack ocupado; guardadas como descartadas y repetidas limpias |
| `yarn e2e` completa: `lock.spec.ts` (4) y `degraded.e2e.ts` (1) | `PRODUCT_BUG`/`TEST_BUG` de **P1** (candado en obras: `lock.ts` 02:46, `lock.spec.ts` 02:51) | P1 (#34) | no tocado |
| ledger `sensitive-data` (1 corrida) | `TEST_BUG` de P2: el detector de PAN marcó un UUID cuya corrida de dígitos cumple Luhn por azar | P2 | el detector ignora UUID canónicos; prueba nueva `pan-detector.spec.ts`; canarios intactos |

## A medias
Ninguno. (M6b sigue `BLOQUEADO`: Q-11 formato real del Mercantil y T-03 cuenta recaudadora/visto bueno legal.)

## No cubierto
Banco real; paridad de contrato simulador/real; Jaeger; la suite `yarn e2e` completa quedó en 18/20 suites por dos suites de P1 (arriba) y no se re-corrió; los docs de P1 (`e2e/README.md`, `ARNES.md § Pendientes`) siguen listando E4/E8 como pendientes.

## Desvíos / avisos
Único cambio en terreno de P1: `git mv` de `e4.e2e.ts` y `e8.e2e.ts`. Nada queda corriendo (TigerBeetle `:54310` y NATS `:54250` propios detenidos, sin `stack.lock`); P5 avisado al liberar el stack.
