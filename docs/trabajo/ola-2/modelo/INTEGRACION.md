# Integración — cómo cada servicio pasa a consumir el SQL del modelo (D-18)

- Qué se entrega: el modelo (`mantra-core-health-model`, rama `claude/adoring-allen-ly7r6f`, **sin commit**) declara las once bases
  en `Mantra Core Health Context/pay-modules/diagram_70..81_*.puml` y genera `SQL/pay/<NN>_pay_<svc>/ddl.sql`
  (ver `Mantra Core Health Context/docs/architecture/pay-databases.md` y `DESCUBRIMIENTO.md`).
- **Ningún servicio se tocó** (otros agentes los están modificando). Todo lo de abajo es recomendación para el integrador.
- Estado de la evidencia: `evidencia/00` en adelante; resumen de resultados en §6.

## 1. Cómo se consume el SQL (recomendación)

`ddl.sql` es SQL plano, **sin calificar** y sin `CREATE SCHEMA`, idempotente (aplicado dos veces deja el mismo catálogo) y
aplicable por el **rol dueño** de la base (verificado con un rol no superusuario: `evidencia/08`). Incluye las tablas técnicas
que ese servicio usa (outbox/inbox/idempotencia), así que **reemplaza juntos** al `sql/001_*.sql` del servicio y a los
`contracts/packages/*/sql` que hoy se aplican a su lado.

Como el monorepo se construye por servicio (Docker) y no ve el repo hermano, la forma coherente con el precedente de la API
(`ddl-sources.md`, «copia de despliegue» + `vendor-ddl.sh`) es **vendoring verificado**:

```bash
# platform/scripts/vendor-model-sql.sh  (propuesta; no creado)
MODEL="${MODEL_REPO:-../mantra-core-health-model}/SQL/pay"
declare -A N=([connectors]=70 [edge]=71 [ledger]=72 [merchants]=73 [payments]=74 [qr]=75 [risk]=76 [schedules]=77 [settlement]=78 [vault]=79 [webhooks]=80)
for s in "${!N[@]}"; do
  src="$MODEL/${N[$s]}_pay_$s/ddl.sql"; dst="services/pay-$s/sql/ddl.sql"
  if [ "${1:-}" = "--check" ]; then diff -q --strip-trailing-cr "$src" "$dst" || exit 1; else cp "$src" "$dst"; fi
done
# y la de las librerías: SQL/pay/81_pay_lib/ddl.sql -> contracts/packages/testing/sql/ddl.sql
```

El archivo copiado ya lleva la cabecera «Generado de diagram_NN_….puml — NO editar a mano».

**Cambio necesario en el modelo para que el vendoring no se marque como DDL suelto** (no lo hice: es una edición de herramienta
existente): `salud-db/check_ddl_sources.py` barre el workspace entero y hoy marca 14 `CREATE TABLE` de `pasarelapago`
(`evidencia/09`). Las copias `services/pay-*/sql/ddl.sql` tendrían que declararse como «copia de despliegue» (el mecanismo
`COPIA_DE_DESPLIEGUE` / `copia_de_despliegue_desfasada()` de ese archivo): comparar cada copia contra su `SQL/pay/NN/ddl.sql` y no
enumerarla como `CREATE TABLE` fuera de lugar.

## 2. Cambio exacto por servicio

Siempre: **borrar** `services/pay-<svc>/sql/001_<x>.sql`, **agregar** `services/pay-<svc>/sql/ddl.sql` (copia vendorizada) y
cambiar las referencias. Las líneas son las vigentes al 2026-10-27 (`grep -rn "sql/001_"`); donde un helper arma una lista de
SQL con las dos librerías, esas dos entradas **se pueden quitar** (el `ddl.sql` ya trae sus tablas) o dejar (son `IF NOT
EXISTS`, inofensivas) hasta borrar las librerías.

| Servicio | Referencias a cambiar (`001_*.sql` → `ddl.sql`) | Texto/documentación |
|---|---|---|
| pay-connectors | `test/support/app.ts:19` (+ quitar `:20-21`) | `README.md:7` |
| pay-edge | `test/harness.ts:14` | — |
| pay-ledger | `test/helpers/app.ts:58` (+ quitar `:59-60`); `test/drift.spec.ts:9` (+ quitar `:10-11`) | `src/ledger/schema-map.ts:4`; `README.md:6` |
| pay-merchants | `test/support/app.ts:21` (+ quitar `:19-20`) | `README.md:6` |
| pay-payments | `test/helpers/stack.ts:26` (+ quitar `:27-28`) | `README.md:19` |
| pay-qr | `test/startup.spec.ts:9`; `test/qr.spec.ts:16`; `test/pay-mode.spec.ts:14` (quitar la entrada de idempotencia) | `README.md:25-26` |
| pay-risk | `test/support/app.ts:17`; `test/rule-sets.spec.ts:29` (lee el archivo y toma la línea que empieza con `INSERT INTO risk_rule_sets`: **esa línea existe tal cual en `ddl.sql`**, así que solo cambia la ruta) | `README.md:6` |
| pay-schedules | `test/support/app.ts:23` (+ quitar `:21-22`) | `README.md:6` |
| pay-settlement | `test/helpers/app.ts:109` (+ quitar `:110-111`); `test/helpers/real-ledger.ts:36` (ruta del ledger → `services/pay-ledger/sql/ddl.sql`) (+ quitar `:37-38`); `test/nats.spec.ts:40` (+ quitar `:41-42`); `test/drift.spec.ts:9` (+ quitar `:10-11`) | `src/settlement/schema-map.ts:4`; `README.md:7` |
| pay-vault | `test/helpers/app.ts:15` (quitar la entrada de idempotencia) | — |
| pay-webhooks | `test/harness.ts:18` (quitar la entrada de idempotencia) | — |
| e2e | `e2e/lib/infra.ts:93-102` (`ddlFiles`): devolver solo `join(ROOT, 'services', name, 'sql', 'ddl.sql')` (las dos librerías ya no hacen falta) | comentario de `:105-107` |
| librerías | `contracts/packages/outbox/src/outbox.spec.ts:16`, `contracts/packages/idempotency/src/index.spec.ts:6`, `contracts/packages/orm-queryable/src/index.spec.ts:27` → `contracts/packages/testing/sql/ddl.sql` (copia de `SQL/pay/81_pay_lib/ddl.sql`); borrar `contracts/packages/{outbox,idempotency}/sql/` | — |
| pay-mockbank | **sin cambio**: su `sql/001_mockbank.sql` es el de un doble (D-26), no está en el modelo (decisión pendiente, U-3) | — |

Qué **no** cambia: el código de los servicios (`src/`), los `schema-map.ts` (salvo el comentario), los `drift.spec` (salvo la
ruta), `PAY_DB_SCHEMA`/`DB_SCHEMA` ni `@pay/testing`: el SQL sin calificar se aplica donde apunte el `search_path`. Los nombres
que usa el código (`connector_charges_live_intent_uidx`, `connector_refunds_refund_id_uidx`) se conservan.

## 3. Despliegue de las bases

Aplicar `services/pay-<svc>/sql/ddl.sql` con el rol dueño de la base al arrancar el contenedor de init del servicio (mismo
patrón que `postgres-init` de la API: idempotente, sin guardas especiales). **No** hay migración de datos: ninguna base real
existe aún (U-5). Un cambio posterior = editar el `.puml`, regenerar, vendorizar y, si la base ya tiene datos, un ALTER fechado.

## 4. Efectos en el repo del modelo y en la API de SALUD (para avisar a sus dueños)

- `SQL/pay/` cuelga dentro de `SQL/`. Ningún generador ni el init de SALUD lo alcanza (`apply_all.sql` no lo lista; los globs son
  `SQL/[0-9][0-9]_*`). Pero `yarn db:vendor` de la API copiaría `pay/` a `mantra-core-health-api/database/SQL` (~120 KB, inerte).
  Si no se quiere, excluir `pay/` en `scripts/db/vendor-ddl.sh`, o mover la salida a un árbol aparte y declararlo en
  `check_ddl_sources.py` (alternativa M-4 de `DESCUBRIMIENTO.md`).
- `check_ddl_sources.py`: el conjunto de archivos marcados es **idéntico con y sin `SQL/pay/`** (16 = 14 de la pasarela + 2 de
  la API; `evidencia/09`). Solo cambia el texto del hallazgo de la copia de despliegue de la API (que ya estaba desfasada).

## 5. Lo que queda abierto (no se hizo, y por qué)

1. Las **entidades del ORM**: la pasarela no usa MikroORM; la capa «ORM» del DoD (`modelo ↔ base ↔ ORM`) se cubre con el mapa del
   código (`schema-map.ts`) donde existe. Existe en 4 servicios (ledger, settlement, payments, vault). **Faltan** `drift.spec` + mapa
   en connectors, merchants, schedules, risk, qr, edge y webhooks: es trabajo de P4/P5/P1, no del modelo.
2. Un único lugar para las tablas técnicas: hoy se repiten en cada módulo (con el 81 como referencia) y su igualdad se comprueba
   por el comparador de catálogos, no por construcción.
3. Promover `gen_ddl_pay.py` a capacidad del generador base (HIP-3 de `DESCUBRIMIENTO.md`) — decisión del dueño del modelo.
4. `pay-mockbank` en el modelo (U-3).

## 6. Resultado de la verificación (peldaño `TESTED` para la generación y el catálogo; ver cada archivo)

| Qué | Evidencia | Resultado |
|---|---|---|
| Regeneración determinista (`--check`) | `evidencia/02-generacion.txt` | PASS (12 bases, 87 tablas) |
| Catálogo generado == catálogo de referencia, por servicio (tablas, columnas en orden, tipos, nulabilidad, defaults, identidad, PK, FK, CHECK, índices, triggers, funciones, filas) + idempotencia | `evidencia/03-equivalencia-catalogos.txt`, `evidencia/equivalencia/*.json` | 12/12 PASS; 0 diferencias semánticas |
| El comparador detecta deriva (control negativo) | `evidencia/03b-control-negativo.txt` | FAIL esperado en 3 aspectos |
| Deriva real de cada servicio (`drift.spec`) contra el SQL generado | `evidencia/04-deriva-specs-servicios.txt` | ledger 5/5, payments 7/7, settlement 6/6, vault 5/5 |
| Suites completas contra el SQL generado | `evidencia/05-suites-completas-contra-sql-generado.txt` | qr 93, vault 68, merchants 145, schedules 158, webhooks 388, edge 381, connectors 471, risk 181 verdes (con las exclusiones ENVIRONMENT/EXTERNAL declaradas en el archivo) |
| Conteos, huérfanos, nulos, sondas negativas (FK compuesta, CHECK, triggers, identidad, índice parcial, semilla ×2) | `evidencia/06-consultas-de-verificacion.txt` | PASS |
| Librerías contra `pay_lib` | `evidencia/07-libs-contra-sql-generado.txt` | outbox 21, idempotency 11, orm-queryable 7 verdes |
| Aplicación ×2 como rol no superusuario dueño | `evidencia/08-aplicacion-como-rol-dueno.txt` | 12/12 |
| `check_ddl_sources.py` con y sin `SQL/pay/` | `evidencia/09-check-ddl-sources.txt` | mismo conjunto de 16 hallazgos |

**No cubierto:** las specs que arrancan servicios con `yarn build` o necesitan servicios externos (`startup.*`, `env-example.*`,
`pay-mockbank` real, Watchman real) no corren en la copia mínima; son ENVIRONMENT/EXTERNAL y no dependen del SQL. Las entidades
del ORM no existen. Ninguna base real (`pay_<svc>`) fue tocada.

## 7. Endurecimiento 2026-10-28 (revisión de seguridad) — qué cambió en el SQL y qué deben saber los servicios

Los tres huecos eran fieles al SQL de referencia; al ser ahora el modelo la fuente única, se corrigieron en los `.puml`
(`pay-modules/diagram_70/72/73_*.puml`) y se regeneró `SQL/pay/` (`gen_ddl_pay.py --check` en verde). Diferencias con el SQL de
referencia, **todas aditivas** (`solo en referencia: []` en `evidencia/10b`): los otros 9 módulos siguen idénticos.

### 7.1 Auditoría de tablas inmutables / append-only (los 12 módulos)

| Módulo | Tabla | Guardián de fila | TRUNCATE antes | TRUNCATE ahora |
|---|---|---|---|---|
| pay_merchants | `contract_versions` | `BEFORE UPDATE OR DELETE` | **faltaba** | `contract_versions_no_truncate` |
| pay_merchants | `contract_acceptances` | ídem | sí | sin cambio |
| pay_merchants | `fee_schedule_versions` | ídem | sí | sin cambio |
| pay_merchants | `fee_schedule_channels` | ídem | **faltaba** | `fee_schedule_channels_no_truncate` |
| pay_risk | `risk_rule_sets` | ídem | sí | sin cambio |
| pay_risk | `risk_assessments` | ídem | sí | sin cambio |
| pay_connectors | `connector_transfers` | monotonía `BEFORE UPDATE` | **faltaba** | `connector_transfers_no_truncate` |
| pay_connectors | `connector_refunds` | monotonía `BEFORE UPDATE` | **faltaba** | `connector_refunds_no_truncate` |
| pay_connectors | `connector_charges` | **no tenía** | **faltaba** | `connector_charges_monotone_trg` + `connector_charges_no_truncate` |

Matiz honesto: `TRUNCATE` a secas sobre una tabla con FK entrante lo frena Postgres (0A000) antes que el trigger, y en
`contract_versions` el hijo `contract_acceptances` ya la protegía por `CASCADE`; el hueco real eran las tablas hoja
(`fee_schedule_channels`, `connector_transfers`, `connector_refunds`) y `TRUNCATE connector_charges CASCADE`. El trigger de
TRUNCATE dispara también para el dueño de la tabla (el rol de la aplicación) y para el superusuario.

**Tablas que dicen ser de solo-agregar y NO tienen ningún guardián (no se tocaron; decisión de sus dueños, porque agregar un
trigger de fila cambia el comportamiento):** `settlement_audit` («Solo se agrega»), `reveal_audit` (pay-vault), `ledger_transactions`,
`ledger_legs`, `ledger_statement_lines`, `ledger_rejections` (pay-ledger), `connector_callback_events`, `connector_api_attempts`,
`webhook_delivery_attempts`. Propuesta: `forbid_mutation` en UPDATE/DELETE/TRUNCATE para las de auditoría pura (`settlement_audit`,
`reveal_audit`, `ledger_rejections`, `ledger_legs`, `ledger_statement_lines`), cada una con su prueba de tres niveles.

### 7.2 `ledger_holds` → `ledger_accounts` (pay-ledger)

Dos FK compuestas nuevas, `ledger_holds_debit_account_fkey` y `ledger_holds_credit_account_fkey`: `(mode, debit_account|credit_account)
→ ledger_accounts (mode, account)`. **Son compatibles con el servicio:** `hold.service.ts#createHold` llama a
`AccountRegistry.register(client, mode, [debit, credit])` dentro de la misma transacción y antes de los dos `INSERT INTO ledger_holds`
(el `pending` y el `rejected`); `register` inserta las filas de `ledger_accounts` con `ON CONFLICT DO NOTHING`. Ningún otro código
escribe en `ledger_holds` (`grep` en `src/`, `test/`, `e2e/`). Cambio de código: **ninguno**. Evidencia: `holds.spec` y la suite completa
del ledger (10g) y la de settlement con ledger real (10l) pasan; prueba nueva `holds-accounts-fk.spec.ts`.

### 7.3 `connector_charges` (pay-connectors)

- Trigger `connector_charges_monotone_trg` (`BEFORE UPDATE`): rechaza `NEW.send_claims < OLD.send_claims` (`check_violation`).
  **La tabla no tiene `may_have_reached_provider`** (su equivalente es `ambiguous`), así que esa mitad del pedido no aplica.
- **`ambiguous` true → false NO se restringe**, a propósito (queda escrito en el `.puml`): lo bajan `apply.ts` (`ambiguous = false`
  al aplicar un estado confirmado por el proveedor, por callback o consulta autoritativa) y `charges.service.ts:159` (`Unavailable`
  cuando nadie reclamó después, `WHERE send_claims = mine`). Hacerlo monótono dejaría todo cobro ambiguo así para siempre.
- Función nueva `forbid_mutation()` en pay_connectors (la misma de merchants y risk) para los tres `*_no_truncate`.

### 7.4 Cambios exactos para los servicios

| Dónde | Cambio |
|---|---|
| Todos los vendorizados | Re-vendorizar `ddl.sql` de `merchants` (73), `connectors` (70) y `ledger` (72) desde el modelo. **merchants/risk/schedules ya tienen un `sql/ddl.sql` copiado por P5: el de merchants ya coincide con el modelo actual; connectors y ledger todavía no están copiados.** |
| `services/pay-connectors/test/support/app.ts:100-102` (`reset()`) | `TRUNCATE connector_charges, connector_transfers, connector_refunds, … CASCADE` **ahora falla** (`la tabla connector_charges es inmutable (TRUNCATE)`; `evidencia/10e`: 330 fallos). Cambiarlo por `DELETE FROM` en orden de FK: `bank_transfer_references`, `connector_refunds`, `connector_callback_events`, `connector_api_attempts`, `connector_charges`, `connector_transfers`, `connector_health`, `connector_callback_endpoints`, `statement_exceptions`, `idempotency_keys`, `outbox_events`, `inbox_events` (probado en la copia: 484/484, `evidencia/10j`). `DELETE` no está prohibido en esas tablas. |
| `services/pay-connectors/test/callbacks.spec.ts:276,285` | `TRUNCATE connector_callback_endpoints`: sin cambio (esa tabla no tiene guardián). |
| Pruebas nuevas (propuestas, en `evidencia/herramientas/nuevas-pruebas/`) | `connectors-money-guards.spec.ts` → `services/pay-connectors/test/`; `merchants-truncate.spec.ts` → `services/pay-merchants/test/`; `holds-accounts-fk.spec.ts` → `services/pay-ledger/test/`. Las tres fallan contra el SQL de referencia en los casos inválidos/límite corregidos (`evidencia/10k`) y pasan contra el generado. |
| Producción / bases con datos | `ddl.sql` agrega las FK de `ledger_holds`: en una base poblada, `ADD CONSTRAINT` valida las filas existentes; verificar antes con `SELECT … FROM ledger_holds h LEFT JOIN ledger_accounts a ON a.mode=h.mode AND a.account=h.debit_account WHERE a.account IS NULL` (idem crédito). Hoy no hay bases pobladas. |

### 7.5 Verificación del endurecimiento (`evidencia/10*`)

| Qué | Archivo | Resultado |
|---|---|---|
| Regeneración (`--check`) | `10b` (cabecera) y corrida de `gen_ddl_pay.py` | `SQL/pay/ coincide con los .puml` |
| Diferencias declaradas contra el SQL de referencia | `10b-equivalencia-tras-endurecimiento.txt` | connectors, ledger y merchants: solo triggers/funciones/FK **nuevos** (`solo en referencia: []`); los otros 9: PASS |
| 27 sondas SQL en tres niveles, como rol no superusuario dueño, referencia (A) vs modelo (B) | `10-sondas-endurecimiento.txt` | PASS; las diferencias A≠B son exactamente las correcciones |
| Conteos / huérfanos / nulos / aplicación ×2 y como rol dueño | `10c`, `10d` | PASS / 12 de 12 |
| Costo en pruebas existentes: `reset()` de connectors con TRUNCATE | `10e` (330 fallos) → `10f`/`10j` (helper adaptado: 473 y 484 verdes) | documentado en §7.4 |
| ledger completo (TigerBeetle real) + prueba nueva | `10g` | 267 verdes; 2 fallos de `faults.spec` (mata y relanza TigerBeetle con su propio binario, ausente en la copia) idénticos contra la referencia (`10h`) |
| merchants completo + prueba nueva | `10i` | 186 verdes |
| connectors completo + prueba nueva | `10j` | 484 verdes (sin las specs que levantan pay-mockbank real) |
| settlement con ledger real | `10l` | 554 verdes; 2 fallos de `nats.spec` en la corrida completa **no se reproducen** aislado, ni con el SQL generado ni con el de referencia (`10m`): interferencia por streams NATS compartidos con otras corridas (EXTERNAL) |
| Las pruebas nuevas detectan los huecos | `10k` | contra el SQL de referencia fallan en los casos inválidos/límite corregidos (merchants 1, connectors 3, ledger 2) y pasan contra el generado |

TigerBeetle ya estaba corriendo (lo había levantado otro agente en 127.0.0.1:54300); lo usé y **no lo detuve** para no cortarle sus corridas.
