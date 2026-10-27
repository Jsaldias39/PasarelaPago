> **AVANCE (tanda 4a): 4 / 4 — 100,0 %** (`HECHO` 4). Peldaño: **`RUNS`** — compilan y pasan el lint; **los flujos NO se ejecutaron** (el stack lo corre P1). Nada de lo que dicen sobre «qué pasa hoy» está observado.

# Reporte — P2 ola 2, tanda 4a (flujos E4 y E8)

- Documento principal: [FLUJOS-E4-E8.md](./FLUJOS-E4-E8.md) · Propuestas 15–18: [PROPUESTAS.md](./PROPUESTAS.md). Sin commit.

## Completado
| ID | Qué se logró | Comando | Resultado |
|---|---|---|---|
| O2.P2.H6.M1 | `e2e/pending/e4.e2e.ts`: 9 pruebas (cobros 97,00/3,00 y débitos = créditos · corte que no libera lo fresco y paga lo disponible una vez · reintento sin doble pago · precondición del cruce · conciliación con UNA excepción `amount_mismatch` de −100 y ledger intacto · repetida · resolución 401/403/200 · modo) | `yarn e2e:typecheck` | exit 0 |
| O2.P2.H6.M2 | `e2e/pending/e8.e2e.ts`: 6 pruebas (instrucciones · antes del extracto · confirmación por la línea · una sola vez · conciliación sin excepciones · importe distinto) | ídem | exit 0 |
| O2.P2.H6.M3 | `e2e/lib/p2-bank.ts` (importes nombrados + el único punto del depósito del pagador) y `e2e/lib/p2-settlement.ts` (credencial de operador, llamada como `pay-backoffice`, vistas del ledger, captura [DOBLE], lunes de corte, espera de eventos). **Archivos nuevos de P2 en `e2e/lib/`: AVISO a P1.** No se tocó ningún archivo existente (los `M` que muestra `git status` en `e2e/lib/{events,seed,services}.ts` no son míos) | `evidencia/4a-listado.txt` | PASS |
| O2.P2.H6.M4 | `FLUJOS-E4-E8.md`: servicios, variables, importes, qué espera cada paso y cómo se mide; y la confirmación de P2.H2.M6 | — | escrito |

## Confirmación por escrito (P2.H2.M6)
«E4 en verde» depende del stack en tres puntos, ninguno de P2: **(1)** la clave de cruce — settlement cruza por el `business_ref` del ledger (`pi_…:capture`) y el simulador devuelve `ch_…`, que un `business_ref` nunca puede igualar (propuesta 15); **(2)** el reloj — con el ledger real no se puede
liberar un cobro fresco a T+7, así que E4 prueba que NO lo libera y el dinero ya liberado entra como [DOBLE] (propuesta 16); **(3)** el formato real del banco (Q-11): no se asume ni se inventa; E4 contra el simulador no prueba la conciliación con el Mercantil. M6 sigue `A MEDIAS`; propongo partirlo en M6a (sandbox) y M6b (formato real).

## Evidencia (`evidencia/`, prefijo `4a-`)
`4a-gates.txt` (`yarn e2e:typecheck`, `yarn eslint` de los archivos nuevos y de `services/{pay-ledger,pay-settlement}` + `e2e`, `yarn lint`: todos `exit=0`) · `4a-listado.txt` (jest lista los 5 archivos de `pending/` sin arrancar stack; tamaños).

## No cubierto
- **Ninguna ejecución**: no se levantó el stack ni se arrancó TigerBeetle (no hubo suites de jest esta tanda).
- Todo lo de «Qué depende del stack» en FLUJOS-E4-E8.md; el depósito del pagador (pay-mockbank, propuesta 17); `pay-payments` en E8 (D-29/D-30).

## Procesos
Ninguno levantado.
