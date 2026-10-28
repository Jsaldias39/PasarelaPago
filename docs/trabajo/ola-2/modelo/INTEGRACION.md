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
