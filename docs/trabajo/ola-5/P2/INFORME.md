# Ola 5 · P2 — Guardianes de solo-agregar en nueve tablas

Cierra `ola-3/P2/PROPUESTAS.md` #20 y `ola-2/P4/PROPUESTAS.md` #12. Regla de fondo: `CLAUDE.md` reglas 5 y 11 (los registros de dinero y de auditoría son de solo-agregar; los errores se corrigen con asientos inversos). Hasta ahora la cumplía el código y no la base: `UPDATE ledger_legs SET amount_minor = …` a mano pasaba.

Pipeline respetado: `.puml` → `gen_ddl_pay.py` → `SQL/pay/` → vendorizado en cada servicio. Ningún DDL suelto. Sin commits ni PR (los dos repos ya tienen commits `wip(ola-5)` que hizo el arnés, no yo).

## 1. Demostración: ¿es de solo-agregar? (tarea 1)

Búsqueda multilínea sobre el árbol de `99a3024` (antes de mi trabajo): [`evidencia/grep-solo-agregar.txt`](./evidencia/grep-solo-agregar.txt). Resultado: **en `src/` de todos los servicios hay solo `INSERT`** (ni un `UPDATE`, `DELETE`, `TRUNCATE` ni `INSERT … ON CONFLICT DO UPDATE`) sobre las nueve. En `test/` y `e2e/` hay exactamente tres sitios que borran, y los tres son limpieza o corrupción deliberada de pruebas.

| Tabla | Servicio | Escribe (solo INSERT) | Veredicto | Borrado en pruebas (antes) |
|---|---|---|---|---|
| `ledger_transactions` | pay-ledger | `ledger.service.ts:162` | **guardada** | ninguno |
| `ledger_legs` | pay-ledger | `ledger.service.ts:180` | **guardada** | ninguno |
| `ledger_statement_lines` | pay-ledger | `ledger.service.ts:188` | **guardada** | `invariant.spec.ts:51` (corrupción deliberada) |
| `ledger_rejections` | pay-ledger | `ledger.service.ts:142`, `hold.service.ts:128` | **guardada** | ninguno |
| `settlement_audit` | pay-settlement | `payout.service.ts:237`, `reconciliation.service.ts:230` | **guardada** | ninguno |
| `reveal_audit` | pay-vault | `vault.repo.ts:98` | **guardada** | ninguno |
| `connector_callback_events` | pay-connectors | `apply.ts:43` (`ON CONFLICT DO NOTHING`) | **guardada** | `test/support/app.ts` `reset()` |
| `connector_api_attempts` | pay-connectors | `provider-gateway.ts:87` | **guardada** | `test/support/app.ts` `reset()` |
| `webhook_delivery_attempts` | pay-webhooks | `delivery.worker.ts:117` (`ON CONFLICT DO NOTHING`) | **guardada** | `delivery.spec.ts:35` (`beforeEach`) |

**Excluidas: ninguna de las nueve.** El estado que sí cambia vive en tablas hermanas que no se tocaron: `webhook_deliveries` (estado de entrega), `ledger_holds` (máquina de estados), `settlement_*` de estado, `connector_charges/transfers/refunds` (monotonía, ya guardadas en af60b79).

## 2. Qué cambió en el modelo (tarea 2)

Repo `mantra-core-health-model`, estilo exacto de af60b79 (`forbid_mutation()`, SQLSTATE `23000` `integrity_constraint_violation`, mensaje `la tabla % es inmutable (%)`; nombres `<tabla>_immutable` = `BEFORE UPDATE OR DELETE … FOR EACH ROW` y `<tabla>_no_truncate` = `BEFORE TRUNCATE … FOR EACH STATEMENT`). Solo UPDATE/DELETE/TRUNCATE, **no** INSERT: sin costo por escritura (relevante para `connector_api_attempts`, de alto volumen).

- `.puml` (PAY_EXTRAS): `diagram_70_pay_connectors`, `_72_pay_ledger`, `_78_pay_settlement`, `_79_pay_vault`, `_80_pay_webhooks`. Los módulos 72, 78, 79 y 80 declaran su propio `FUNCTION forbid_mutation` (una base por servicio, igual que merchants/risk/connectors).
- Regenerado con `gen_ddl_pay.py`: `SQL/pay/{70,72,78,79,80}_*/05_constraints.sql`, `ddl.sql`, `_generation_report.md` (funciones 5→9, triggers 18→36). Los guardianes TRUNCATE de connectors que ya existían (charges/transfers/refunds) no cambiaron.
- `gen_ddl_pay.py --check`: `SQL/pay/ coincide con los .puml`; `salud-db/tests`: 21/21 ([`vendorizado-y-modelo.txt`](./evidencia/vendorizado-y-modelo.txt)).

## 3. Excepción de las pruebas que borran (decisión tomada, sin bypass)

Investigué qué usa el modelo para entornos descartables: **no existe ningún bypass en el modelo** (`grep` de `session_replication_role`, `DISABLE TRIGGER`, `current_setting` en `SQL/pay`: nada). Lo que ya hay es (a) cada suite crea su esquema con `createIsolatedDatabase` y lo borra con `DROP SCHEMA … CASCADE`, que los triggers no frenan; (b) `pay-merchants/test/merchants-truncate.spec.ts` ya usa `ALTER TABLE … DISABLE TRIGGER` desde la prueba, siendo dueño de la tabla. Seguí (b) sin tocar el guardián:

`deleteFromImmutable(pool, tabla, where?, params?)` (`pay-ledger/test/helpers/immutable.ts`, `pay-connectors/test/support/immutable.ts`, `pay-webhooks/test/immutable.ts`): dentro de **una transacción** apaga SOLO `<tabla>_immutable`, borra y lo rearma; si falla, `ROLLBACK` lo deja armado; ninguna otra conexión ve el guardián apagado. Está probado en `append-only.spec.ts` (queda armado también si el `DELETE` falla; no apaga el de la tabla vecina; rechaza nombres de tabla raros). Los tres sitios que borraban ahora lo usan: `invariant.spec.ts`, `connectors test/support/app.ts reset()`, `delivery.spec.ts`. No se debilitó ni borró ninguna aserción.

Existe solo en código de pruebas; en producción no hay vía de borrado. Ver "No cubre".

## 4. Servicios

- `pay-ledger`, `pay-settlement`: `bash scripts/vendor-model-sql.sh` (+ `--check` PASS).
- `pay-vault`: `yarn sql:vendor` / `yarn sql:check` OK (también `sql/ddl.sql.source`).
- `pay-connectors`: `bash scripts/vendor-ddl.sh` / `--check` OK (no tiene script `sql:*` en `package.json`).
- **`pay-webhooks` (decisión a revisar):** no vendorizaba el modelo; usaba `sql/001_webhooks.sql` escrito a mano (ola-1/P1: "pendiente de mover al modelo, D-18"). Sin vendorizar, el guardián no llegaría ni a sus pruebas ni a `sandbox-migrate`/e2e (que aplican todo `services/*/sql/*.sql`). Comparé la referencia contra `SQL/pay/80_pay_webhooks/ddl.sql` en dos esquemas descartables ([`webhooks-referencia-vs-modelo.txt`](./evidencia/webhooks-referencia-vs-modelo.txt)): **columnas, tipos, nulabilidad y defaults idénticos**; difieren solo los nombres de PK/FK (`*_pkey` vs `pk_*`) y el `UNIQUE (endpoint_id, event_id)` pasa de constraint a índice único; ningún código ni prueba nombra esas constraints. Por eso: agregué `scripts/vendor-model-sql.sh` + `sql:vendor`/`sql:check`, generé `sql/ddl.sql` (+ `.source`), **borré `sql/001_webhooks.sql`** (hay copia en mi scratchpad; `git checkout` lo restaura) y `test/harness.ts` ahora aplica solo `sql/ddl.sql`. Si P1 prefiere hacerlo él, se revierte con esos cuatro cambios y la prueba de webhooks pasa a aplicar el DDL del modelo a mano.

## 5. Pruebas (tarea 4) y mutación

Un `test/append-only.spec.ts` por servicio (Postgres real 127.0.0.1:54321, esquema descartable de `createIsolatedDatabase`, sin TigerBeetle ni app). Por tabla, tres niveles:
- correcto: INSERT permitido y legible; reentrega `ON CONFLICT DO NOTHING` no la toca;
- límite: UPDATE/DELETE de cero filas pasan (el guardián es por fila); tabla hermana sin guardián (`idempotency_keys`) sigue mutable; los triggers existen, habilitados y con el tipo correcto (fila/UPDATE/DELETE y sentencia/TRUNCATE);
- inválido: UPDATE, DELETE, TRUNCATE (a secas, `CASCADE`, y el guardián propio con los de las otras tablas apagados en una transacción que se revierte) e `INSERT … ON CONFLICT DO UPDATE`, con SQLSTATE `23000` y mensaje exacto; la fila queda intacta.

Corridas dirigidas: ledger 27, settlement 8, vault 8, webhooks 9, connectors 15 (todas verdes). **Mutación** ([`mutacion-sin-trigger.txt`](./evidencia/mutacion-sin-trigger.txt)): quitando de `sql/ddl.sql` los triggers de las tablas de cada servicio fallan 18/27, 5/8, 5/8, 6/9 y 10/15; luego se restauró y se comprobó `cmp` idéntico.

## 6. Suites completas (tarea 5; `yarn e2e` no se corrió)

Todo con `flock /tmp/pay-heavy.lock`. typecheck y build: exit=0 en los cinco ([`gate-*-typecheck.txt`](./evidencia/), [`gate-*-build.txt`](./evidencia/)). `eslint` de los 12 archivos tocados: exit=0.

| Servicio | `yarn test` | Fallos | Causa |
|---|---|---|---|
| pay-vault | 137/137 | 0 | — |
| pay-connectors | 905 passed, 23 todo, 33/33 suites | 0 | — |
| pay-ledger | 326/328 | 2 | `deployment.spec.ts` (no mío, ver 7) |
| pay-settlement | 577/580 | 3 | `deployment.spec.ts` (no mío, ver 7) |
| pay-webhooks | 505/531 | 26 | Svix/health/config en curso de otro agente (no mío, ver 7); `append-only`, `delivery`, `engine-contract` dirigidos: 32/32 |

Ninguna falla toca las nueve tablas ni un guardián: no apareció ningún `inmutable` en los logs. Conclusión: ningún camino legítimo actualizaba ni borraba esas tablas. La primera corrida de ledger dio 125 fallos por TigerBeetle caído (`ENVIRONMENT`: el dev en :54300 no corría; lo levanté con `platform/scripts/tigerbeetle-dev.sh start`, repetí y lo bajé con `stop`); queda como [`gate-ledger-test-SIN-TIGERBEETLE-ENTORNO.txt`](./evidencia/gate-ledger-test-SIN-TIGERBEETLE-ENTORNO.txt), no es evidencia de nada.

## 7. Defectos de otros módulos (no arreglados)

1. `pay-ledger/test/deployment.spec.ts` (2 pruebas "PAY_MODE=live") y `pay-settlement/test/deployment.spec.ts` (3): `IDEMPOTENCY_MASK_KEY es obligatoria bajo PAY_MODE=live` (`contracts/packages/idempotency/src/mask-key.ts`, nuevo en un commit `wip(ola-5)`); esas pruebas no definen la variable. `PRODUCT_BUG`/`TEST_BUG` del dueño del cambio de `mask-key`.
2. `pay-webhooks`: `test/health.spec.ts`, `test/svix/svix-engine-errors.spec.ts`, `test/svix/svix-reconciler-guards.spec.ts` (`WEBHOOKS_SVIX_NAMESPACE`, tope de borrados, margen de reloj: "Received function did not throw"). `src/` de webhooks tiene cambios sin commit de otro agente (p. ej. `svix-namespace.ts` borrado). No relacionado con el DDL.

## 8. No cubre

- **El dueño de la tabla puede apagar el trigger.** Un `ALTER TABLE … DISABLE TRIGGER` lo permite al rol dueño (y al superusuario), también en producción si la aplicación conecta como dueña. El guardián frena el SQL accidental o malicioso de un rol sin ese privilegio y a la propia aplicación; no a un DBA ni a un rol dueño. Cerrarlo es de infraestructura (rol de la aplicación sin ser dueña, migrador aparte); `p5-gates.mjs truncate` ya prueba el rol de la aplicación para merchants, **no se extendió a estas nueve**.
- No se corrió `yarn e2e`: los flujos e2e no borran estas tablas (solo `e2e/flows/e7.e2e.ts:123` hace `SELECT` en `reveal_audit`), pero no lo ejecuté.
- No hay vía de retención/supresión en producción para ninguna. **Decisión abierta**: `settlement_audit` y `reveal_audit` (retención y derecho al olvido: con legal) y `connector_api_attempts` (volumen; la salida habitual sería particionar y `DROP PARTITION`, que no frena el trigger). No inventé un bypass.
- Corrección manual de un DBA (p. ej. un `attempt` mal cargado) exige apagar el trigger a propósito y dejar rastro; no hay procedimiento escrito.
- `ledger_holds`, `ledger_accounts`, `settlement_*` de estado, `idempotency_keys`, `outbox_events`, `inbox_events`: fuera de alcance, sin guardián.
- Las pruebas del guardián usan el pool de pruebas (superusuario/dueño); no se probaron con el rol real de la aplicación.
- El e2e y `sandbox-migrate` con el nuevo `sql/ddl.sql` de webhooks no se ejecutaron (solo las pruebas del servicio).
- Tras commitear el modelo, repetir `yarn sql:vendor` en vault y webhooks para que `sql/ddl.sql.source` registre el commit definitivo (hoy dice `5050446`, el `wip`).

## Archivos tocados

Modelo: los 5 `.puml` de `Mantra Core Health Context/pay-modules/` (70, 72, 78, 79, 80) y `SQL/pay/{70,72,78,79,80}_*/{05_constraints,ddl}.sql` + `SQL/pay/_generation_report.md`.

pasarelapago: `services/pay-{ledger,settlement,vault,connectors,webhooks}/sql/ddl.sql` (vault y webhooks también `ddl.sql.source`); `pay-webhooks`: `package.json`, `scripts/vendor-model-sql.sh` (nuevo), `sql/001_webhooks.sql` (borrado), `test/harness.ts`, `test/delivery.spec.ts`, `test/immutable.ts` (nuevo), `test/append-only.spec.ts` (nuevo); `pay-ledger/test/{append-only.spec.ts,helpers/immutable.ts}` (nuevos) y `invariant.spec.ts`; `pay-connectors/test/{append-only.spec.ts,support/immutable.ts}` (nuevos) y `support/app.ts`; `pay-settlement/test/append-only.spec.ts` y `pay-vault/test/append-only.spec.ts` (nuevos); esta carpeta.

## 9. Re-revisión de dinero F-D1 — los servicios verifican sus guardianes en `/health/ready`

**Causa (RE-REVISION-DINERO F-D1, CONFIRMADO por lectura).** Los triggers `<tabla>_immutable` y `<tabla>_no_truncate` solo existen en bases creadas con el DDL nuevo: `platform/scripts/sandbox-migrate.mjs` hace «ya tiene N tablas, no se toca» y ningún servicio comprobaba que existieran. Las pruebas pasaban (cada suite crea su esquema con el DDL nuevo) y una base desplegada antes de ola 5 podía quedar sin guardián sin que nada lo avisara.

**Arreglo.** En `pay-ledger`, `pay-settlement`, `pay-vault` y `pay-connectors` (cada uno con su copia, sin código compartido) `src/append-only-guards.ts` consulta `pg_trigger` por los triggers esperados de SUS tablas y `src/health.controller.ts` los expone en **`GET /health/ready` → `checks.append_only_guards: { ok: boolean, missing: string[] }`** (mismo nombre y forma que `pay-webhooks`):

| Servicio | Tablas | Triggers esperados |
|---|---|---|
| `pay-ledger` | `ledger_transactions`, `ledger_legs`, `ledger_statement_lines`, `ledger_rejections` | 8 |
| `pay-settlement` | `settlement_audit` | 2 |
| `pay-vault` | `reveal_audit` | 2 |
| `pay-connectors` | `connector_callback_events`, `connector_api_attempts` | 4 |

- Un guardián cuenta solo si el trigger existe **en la tabla esperada**, está habilitado para la sesión normal (`tgenabled` `O`/`A`; apagado con `DISABLE TRIGGER` o solo `REPLICA` ⇒ falta), llama a `forbid_mutation()` y tiene el evento esperado (`tgtype`: `_immutable` = por fila, BEFORE, UPDATE y DELETE; `_no_truncate` = BEFORE TRUNCATE). Un trigger con el nombre correcto pero otra función u otro evento falta.
- **`PAY_MODE=live` y `ok:false` ⇒ readiness 503** (`status: "error"`, con `checks` en el cuerpo). **Sandbox ⇒ 200** con `ok:false` visible y un `warn` `append_only_guards_missing` (en live, `error`), una sola vez por cambio de estado (no en cada sondeo del orquestador). Solo nombra triggers: ningún dato.
- **Fail-closed**: si la consulta a `pg_trigger` falla, `ok:false` con todos los guardianes como faltantes (y sin acusarlos en el log: con la base caída la readiness ya cae por la base).
- `pay-ledger` ahora exporta `LEDGER_CONFIG` desde `LedgerModule` (la readiness necesita `payMode`); no cambia nada más del módulo.
- **Procedimiento para bases ya creadas**: `docs/runbooks/sandbox-a-produccion.md` §7.1 (bloque de guardianes en una transacción, o el `ddl.sql` completo; ventana; verificación).

**Evidencia.**
- Base creada con el **DDL VIEJO real** (`git show b6f398c~:services/<svc>/sql/ddl.sql`), en los cuatro servicios: live ⇒ 503 con los `missing` esperados; sandbox ⇒ 200 con `ok:false`; reaplicar el `ddl.sql` nuevo completo (dos veces seguidas) ⇒ 200 `ok:true`; aplicar solo el bloque de guardianes ⇒ 200 `ok:true`. Salida literal: [`evidencia/FD1-ddl-viejo-prueba.txt`](./evidencia/FD1-ddl-viejo-prueba.txt). El bloque del runbook también se corrió con `psql` real sobre un esquema descartable de `pay_connectors` (3 → 7 triggers, idempotente en la segunda pasada).
- Pruebas permanentes: `services/pay-{ledger,settlement,vault,connectors}/test/append-only-guards.readiness.spec.ts` (13 por servicio: correcto, límite e inválido; incluye guardián apagado, solo réplica, evento equivocado, otra función, tabla inexistente, consulta que falla, y el controlador real en live/sandbox con supertest).
- Mutaciones (`evidencia/FD1-mutaciones.txt`, hechas en un `git worktree` aparte y restauradas): sin comprobar `tgtype`, sin filtrar `tgenabled`, sin comprobar la función, «live nunca bloquea» (en los cuatro servicios), fail-open si la consulta falla, aviso repetido en cada sondeo, y una tabla fuera de la lista (ledger, connectors). Las 11 hacen fallar al menos una prueba.

**No cubre.** El rol real de la aplicación (las pruebas usan el pool de pruebas, dueño y superusuario; `pg_trigger` es legible por cualquier rol). Que `pay-webhooks` tiene su propio chequeo (otro agente). Que la readiness es un aviso/bloqueo de despliegue: no impide que alguien apague un trigger con el servicio ya listo hasta el siguiente sondeo, y el dueño de la tabla sigue pudiendo apagarlo (ver §8).

## 10. Re-revisión de dinero F-D1 en `pay-webhooks`

`pay-webhooks` tiene su propia copia de `src/append-only-guards.ts` (tabla `webhook_delivery_attempts`: `webhook_delivery_attempts_immutable` y `webhook_delivery_attempts_no_truncate`) y expone **`checks.append_only_guards: { ok, missing[] }`** en `GET /health/ready` con el mismo nombre, forma, regla de `live` (503) y de sandbox (200 con `ok:false` visible y `warn`) que los otros cuatro servicios (§9). Probado con una base creada con el DDL anterior (sin triggers) y reaplicando el DDL: `services/pay-webhooks/test/append-only-guards.spec.ts`; detalle, mutaciones y gates en `../P1/INFORME.md` §10 y `../P1/evidencia/fb-*`. Procedimiento para bases ya creadas: `docs/runbooks/sandbox-a-produccion.md` §7.1.
