# Evidencia P5 — ola 2, tanda 4a

| Punto | Artefacto | Resultado |
|---|---|---|
| E5 (pago mensual del médico con saldo AloVida) | `e2e/pending/e5.e2e.ts`, `e2e/lib/p5-schedules.ts` (nuevo, de P5), `docs/trabajo/ola-2/P5/FLUJO-E5.md` | **Escrito, tipado y con lint en 0; NO ejecutado** (el stack lo corre P1). Peldaño `WRITTEN`+`RUNS`. Lista de supuestos sin verificar en el documento |
| Typecheck del arnés | `4a-typecheck-arnes.txt` (`yarn e2e:typecheck`) | `exit=0` |
| Lint | `4a-eslint-e2e.txt` (`e2e/**`) y `4a-eslint-carril-p5-y-e2e.txt` (mis tres servicios + `e2e/**`): `exit=0`. `4a-eslint-raiz.txt` (`yarn lint` completo): **`exit=1` por 1 error ajeno** — `services/pay-mockbank/src/sandbox/bank.controller.ts` 1:33 `'Header' is defined but never used` (servicio nuevo de P4; no se tocó) | mío limpio; raíz roja por otro carril |
| Jest ve el flujo | `4a-pending-listtests.txt` (`--listTests`, sin levantar nada) | `e2e/pending/e5.e2e.ts` listado junto a e1 y e2 |
| P5.H2.M1 | `docs/plan/carriles/P5-comercios-riesgo-y-programados.md` § «Estado de P5.H2.M1» | `BLOQUEADO` (externo): listas vigentes sin acceso desde este entorno + umbrales Q-12 (Cumplimiento). Sin umbrales ni listas inventados; el contrato está simulado en tres niveles con las listas estáticas de 2019 (solo sandbox) |

**No cubierto:** cualquier corrida del flujo E5 contra el stack; la migración de pagos programados a `POST /intents` (PR-18, decisión abierta: el documento marca qué cambiaría).

**Archivos existentes de `e2e/` tocados: ninguno.** `e2e/lib/p5-schedules.ts` es nuevo; se avisa a P1.
