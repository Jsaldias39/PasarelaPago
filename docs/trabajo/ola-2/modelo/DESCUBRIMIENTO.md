# Descubrimiento — las bases `pay_*` en el pipeline de `mantra-core-health-model` (D-18)

- Fecha: 2026-10-27 · Repos: `mantra-core-health-model` (rama `claude/adoring-allen-ly7r6f`), `pasarelapago` (misma rama)
- Alcance: ¿cómo genera el pipeline `SQL/` desde los `.puml`, qué admite, y cuál es la forma mínima y aditiva de
  incorporar las once bases de la pasarela? Rutas del modelo relativas a `mantra-core-health-model/`.
- Peldaño (regla 30): este documento es `DISCOVERED`. Lo que se construyó y se verificó con la salida pegada está en
  `evidencia/` y se resume en `INTEGRACION.md`.

## 1. Hechos (con ruta)

### 1.1 Cómo se genera `SQL/`

| # | Hecho | Dónde |
|---|---|---|
| H1 | La dirección es `.puml → gen_ddl.py → SQL/ → base → entidades MikroORM`; lo derivado «se regenera, nunca se edita a mano; si algo sale mal, se arregla el generador». | `README.md`; `Mantra Core Health Context/docs/architecture/ddl-sources.md` |
| H2 | Los `.puml` viven en `Mantra Core Health Context/modules/diagram_<NN>_<código>.puml` (**70 archivos, 00–69**; el README aún dice «66 .puml (00–65)»). El `(schema: x)` del título da el schema; la salida es `SQL/<NN>_<schema>/`. | `salud-db/paths.py:36` (`PUML_DIR`); `salud-db/gen_ddl.py:398` (`parse_module`) |
| H3 | Un módulo se **registra** de dos formas: el archivo en `modules/` (lo descubren todos los generadores con `glob("diagram_*.puml")`) y una entrada en `modules:` del manifiesto (`number`, `code`, `title`, `file`, `table_like_elements`, `index_sets`, `status`). **En el workspace nada parsea la lista `modules:` (solo documentación la cita)**; `gen_ddl.py` solo extrae `version:` del manifiesto con un regex. | `Mantra Core Health Context/model-manifest.yaml:240`; `salud-db/gen_ddl.py:48` (`model_version`) |
| H4 | Salida por fases idempotentes: `01_schema`, `02_tables`, `03_fk_intra`, `04_indexes`, `90_fk_deferred`; `gen_integrity.py` agrega `05_constraints.sql` **solo desde el módulo 33** (`CHECK_SQL`, `EXCLUDE_SQL`, guardas de inmutabilidad); `gen_apply.py` arma `apply_all.sql` / `apply_deferred.sql` con todo directorio `NN_*` de `SQL/`. | `salud-db/gen_ddl.py:640` (`emit`); `salud-db/gen_integrity.py:31,159`; `salud-db/gen_apply.py` |
| H5 | **Una sola base, muchos schemas.** El generador califica todo (`"schema"."tabla"`) y `CREATE SCHEMA IF NOT EXISTS`. No tiene noción de «base»: la separación por base no se puede expresar sin cambiarlo. | `salud-db/gen_ddl.py:636` (`q`), `emit` |
| H6 | Los directorios `NN_*` de `SQL/` **los consume todo SALUD por glob**: `apply_all.sql` (init de la base de la API, `postgres-init`), `gen_seeds.ddl_files()` y `rebuild_stack.expected_from_sql()` (cuenta tablas y FK contra la base). Un módulo ajeno en `SQL/NN_*` entraría en esos conteos y en el init de SALUD. | `salud-db/gen_seeds.py:855-891,1093`; `salud-db/rebuild_stack.py:266-291`; `mantra-core-health-api/docker/db-init/init-postgres.sh` |
| H7 | `gen_ddl.py <N>` (un módulo) **igual** reescribe `SQL/_generation_report.md` con solo ese módulo y `SQL/00_shared/00_types.sql`; `gen_ddl.py all` reescribe todo. Es decir: «generar solo lo nuevo» no existe en el generador base. | `salud-db/gen_ddl.py:779,856` (`write_report`, `main`) |
| H8 | **Línea base reproducible.** En una copia (`gen_ddl.py all` + `gen_integrity.py` + `gen_apply.py`, con la bóveda de FK enlazada) el árbol `SQL/` (sin `patches/`, que es a mano) coincide byte a byte con el versionado salvo `00_platform/` (versionado, que el generador no emite), `README.md` y `apply_all/deferred.sql` (que listan `00_platform`). `_generation_report.md` idéntico. | corrida de este descubrimiento (copia en el scratchpad; no se tocó `SQL/`) |
| H9 | Un `CREATE TABLE` fuera de `SQL/` y `NoSQL/` **ya lo marca** `check_ddl_sources.py` — y lo marcaba para la pasarela: 14 hallazgos de `pasarelapago/services/*/sql` y `contracts/packages/*/sql` (el workspace es `/home/user`, donde `pasarelapago` es hermano del modelo). Es la prueba de que la regla 97.1 alcanza a este DDL. | `salud-db/check_ddl_sources.py:190` (`ddl_fuera_de_lugar`); salida en `evidencia/` (ver `INTEGRACION.md` §5) |
| H10 | `check_ddl_sources.py` compara además la copia de despliegue de la API (`mantra-core-health-api/database/SQL`) contra `SQL/` **recursivamente**: todo archivo nuevo bajo `SQL/` aparece como «faltan N» hasta correr `yarn db:vendor`. | `salud-db/check_ddl_sources.py:141` (`copia_de_despliegue_desfasada`) |
| H11 | `SHA256SUMS.txt` de `Mantra Core Health Context/` ya está desfasado en el repo (README, `ddl-sources.md`, etc. fallan `sha256sum -c` antes de este trabajo): no es una puerta vigente y no se actualizó. | `Mantra Core Health Context/SHA256SUMS.txt` |
| H12 | Verificadores de deriva que existen: `check_ddl_sources.py` (quién declara DDL), `rebuild_stack.py` (tablas/FK esperadas de `SQL/` vs. observadas en la base, tras un rebuild), el catálogo de índices/FK del ORM de la API (`yarn orm:catalog`, ver la tabla de `ddl-sources.md`) y las pruebas `tests/test_generation_contracts.py` (21, verdes). **No existe** un verificador SQL ↔ base que sirva a una base `pay_*`. | `salud-db/rebuild_stack.py:266`; `salud-db/tests/` |

### 1.2 Lo que el generador base expresa, y lo que el DDL de la pasarela necesita

| El DDL de referencia de la pasarela usa… | `gen_ddl.py` | Cómo se resolvió |
|---|---|---|
| Tablas, columnas, `NOT NULL`, PK simple y **compuesta** (02 emite todas las columnas `<<PK>>`) | sí (`pk_<tabla>`) | nativo |
| FK de una columna | sí, por arista etiquetada (`resolve_fk_from_diagram`), nombre `fk_<tabla>_<col>` | nativo |
| FK **compuesta** (`(mode, account) → ledger_accounts`), 4 en total | **no** (`pk_map` toma la primera columna de la PK; la comenta «sin PKs compuestas en el modelo») | `FK_SQL` en `PAY_EXTRAS` |
| Índices con nombre, `UNIQUE`, `DESC`, expresiones (`(source ->> 'id')`), `WHERE` parcial | sí | nativo |
| `UNIQUE` de tabla / de columna | como **índice** único (`UK … UNIQUE`), no como restricción | nativo; cambia el tipo de objeto, no el comportamiento |
| `DEFAULT now()`, `0`, `'pending'`, `'{}'::jsonb` (156 en total) | **no** (solo `row_version` y `DEFAULT_TRUE/FALSE`) | `DEFAULT` en `PAY_EXTRAS`; los booleanos usan el estereotipo nativo |
| `bigserial` | **no** (fuera de `KNOWN_TYPES`: la columna se omite con aviso) | admitido por el perfil |
| `GENERATED ALWAYS AS IDENTITY` (2) | no | `IDENTITY` en `PAY_EXTRAS` |
| `CHECK` (223, de columna y de tabla, algunos con regex) | solo vía `CHECK_SQL` del **módulo 33** (que habría que editar, y es un módulo existente de SALUD) | `CHECK_SQL` en `PAY_EXTRAS` |
| Funciones plpgsql + 12 triggers (inmutabilidad, monotonía) | solo la guarda de `integrity.forbid_mutation` desde el módulo 33 | `FUNCTION` / `TRIGGER` en `PAY_EXTRAS` |
| Una fila de configuración idempotente (`risk_rule_sets` v1 = «sin límites», D-23) | no hay mecanismo de semillas por base | `SEED_SQL` en `PAY_EXTRAS` |
| Objetos **sin calificar** (el servicio los resuelve por `search_path`) | no (siempre calificados) | el perfil emite sin calificar |

### 1.3 Referencia que se porta

- Fuente: `services/pay-*/sql/001_*.sql` (11 servicios) + `contracts/packages/{outbox,idempotency}/sql/001_*.sql`
  (tablas técnicas que cada base repite). `services/pay-mockbank/sql/` **no se portó**: es el doble del banco (D-26,
  Ola 4, otro agente lo está construyendo) y no es esquema de producción.
- Totales del DDL portado: 87 tablas (12 módulos), 28 FK (24 de una columna + 4 compuestas), 90 índices no-PK, 223 CHECK,
  156 defaults no booleanos, 2 identidades, 3 funciones, 12 triggers, 1 semilla. Hash de cada archivo de referencia en
  `evidencia/01-referencia-sha256.txt`.
- Los nombres de restricción que el código usa (`connector_charges_live_intent_uidx`, `connector_refunds_refund_id_uidx`
  en `pay-connectors/src/core/{charges,refunds}.service.ts`) son **índices únicos parciales**: el modelo los conserva con
  el mismo nombre. Ningún servicio depende de nombres de PK/FK (grep en `src/`, `test/`, `e2e/`; la única mención es un
  regex alternativo `/outbox_events_pkey|duplicate key/` en `contracts/packages/orm-queryable/src/index.spec.ts:125`).

## 2. Qué se decidió (aditivo, sin tocar SALUD)

| ID | Decisión | Motivo (hecho que la sostiene) |
|---|---|---|
| M-1 | Los módulos pay viven en **`Mantra Core Health Context/pay-modules/`**, no en `modules/`. Numeración 70–89 reservada (70–80 las once bases, 81 `pay_lib`). | H3, H6: todo generador de SALUD hace `glob` sobre `modules/`; `gen_entities.py` les generaría entidades en la API de salud y `model_inventory.py` cambiaría los conteos. |
| M-2 | Registro en una sección **nueva** `pay_databases:` del manifiesto (YAML válido, `modules:` intacta: 70 entradas). | H3: nada lo parsea; `modules:` alimenta documentación de SALUD. |
| M-3 | Generador **nuevo y aparte**, `salud-db/gen_ddl_pay.py`: reutiliza `parse_module`/`emit` de `gen_ddl.py` reapuntando sus variables de módulo (`PUML_DIR`, `OUT_DIR`, `q`, `KNOWN_TYPES`, `column_default`) y **no edita una línea de `gen_ddl.py`**. | H5, H7: cambiar el generador base arriesga SALUD y colisiona con quien lo toque; el reuso asegura que las FK/índices/tablas se emiten con el mismo código. |
| M-4 | Salida en **`SQL/pay/<NN>_pay_<svc>/`**, no en `SQL/NN_*`. | H6: ningún glob de SALUD (`[0-9][0-9]_*`) la alcanza (verificado: `gen_seeds.ddl_files()` → 64 archivos, ninguno de `pay/`). Además `check_ddl_sources` la reconoce como legítima (queda dentro de `SQL/`). **Costo:** H10 (la copia de despliegue de la API pasa a «faltar 79»; ver `INTEGRACION.md` §4). Alternativa descartada: `SQL-pay/` aparte, que evita ese costo pero exige editar `check_ddl_sources.py` y la política de `ddl-sources.md`. |
| M-5 | SQL **sin calificar** y sin `CREATE SCHEMA`. | H5 + el hecho de que cada servicio ya resuelve por `search_path` (`PAY_DB_SCHEMA`; `@pay/testing` usa `-c search_path=t_<hex>`). Así el `ddl.sql` es intercambiable con el `sql/001_*.sql` actual, sin tocar servicios ni helpers de prueba. |
| M-6 | Lo que el generador base no expresa se declara **en el mismo `.puml`** (entidad `<<PAY_EXTRAS>>`) y lo materializa el perfil en `05_constraints.sql` / `06_seed.sql`. Nada queda como `.sql` a mano. | 97.1: «prohibido DDL a mano fuera del mecanismo declarado». |
| M-7 | Módulo 81 `pay_lib` con las tres tablas técnicas, para que las pruebas de `@pay/outbox`, `@pay/idempotency` y `@pay/orm-queryable` consuman DDL del modelo (los dos `.sql` de `contracts/packages/*/sql` son hoy dos de los hallazgos de `check_ddl_sources`). | H9. |
| M-8 | Nombres: PK `pk_<tabla>` y FK de una columna `fk_<tabla>_<col>` (convención del generador, no se pelea); FK compuestas, CHECK, UNIQUE e índices **conservan** su nombre. | Ningún código depende de nombres de PK/FK (§1.3). |

## 3. Desconocidos

| ID | Qué no se sabe | A quién / cómo se resuelve |
|---|---|---|
| U-1 | Las **entidades del ORM** de los servicios: la pasarela usa `pg` directo con un `schema-map.ts` por servicio (4 tienen `drift.spec`: ledger, settlement, payments, vault), no MikroORM. La capa «ORM» de `modelo ↔ base ↔ ORM` no existe como tal; su equivalente es el mapa del código. | Decisión del integrador: ¿el mapa del código cuenta como la capa 4? (los 4 que lo tienen quedaron en verde). `pay-connectors`, `pay-merchants`, `pay-schedules` y los demás **no tienen `drift.spec` ni mapa**: su deriva contra el código no es verificable hoy (P4, P5). |
| U-2 | Si el equipo del modelo acepta `SQL/pay/` dentro de `SQL/` (M-4) o prefiere el árbol aparte. | Dueños del modelo (revisión humana del PR a `dev`). |
| U-3 | Si `pay-mockbank` (D-26) debe entrar al modelo. Hoy es un doble de pruebas, no esquema de producción. | Decisión del dueño / P4.H4. |
| U-4 | Cómo se despliega el DDL en cada base de producción (Coolify: ¿vendoring del `ddl.sql` al repo de la pasarela, o init con el repo del modelo?). El monorepo se construye por servicio y no ve el repo hermano. | Plataforma (P1). Ver `INTEGRACION.md` §2: se recomienda el vendoring verificado (precedente: `vendor-ddl.sh` de la API). |
| U-5 | Migración de bases **ya pobladas**: `ddl.sql` converge lo que falta pero no migra datos ni cambia tipos de una tabla existente. Hoy no hay bases pobladas (solo desarrollo). | Cuando exista la primera base real, un ALTER fechado por cambio (patrón de `SQL/patches/`). |

## 4. Hipótesis (marcadas como tales)

- **HIP-1.** El módulo 42 de SALUD (`payments`, 54 tablas: pasarelas, transacciones, reembolsos, payouts) es de dominio
  parecido al de la pasarela; los carriles de la pasarela dicen haberse «reducido» de él (`merchants`, `payment_intents`,
  `mandates`). Se asume que **no** hay que fusionarlos (D-18 los separa por base y por dueño). No se verificó con el
  equipo de SALUD.
- **HIP-2.** `SQL/00_platform/` versionado y no regenerable parece un resto de una versión anterior del generador; no
  afecta este trabajo y no se tocó.
- **HIP-3.** Unificar el perfil en `gen_ddl.py` (que `DEFAULT`, `CHECK_SQL`, FK compuesta, función/trigger y
  `bigserial` sean ciudadanos del generador, y que `emit` pueda calificar o no) es el destino natural, pero es un cambio
  de gran alcance sobre el generador que gobierna SALUD: **no se hizo**. Si se decide, las piezas están aisladas en
  `gen_ddl_pay.py` (`parse_extras`, `parse_module_with_extras`, `write_constraints`) y migrarlas es mover ~150 líneas.
