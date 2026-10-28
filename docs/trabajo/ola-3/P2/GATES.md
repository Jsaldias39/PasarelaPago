> **AVANCE (matriz de gates): 10 / 13 gates de PLAN-MAESTRO §7 en PASS (los gates 5, 6 y 7 con un GAP menor declarado y con dueño) · 3 `NO APLICA AÚN`** — más la fila de Dockerfile en PASS y la de inmutabilidad como GAP propuesto. Peldaño: **`TESTED`** (nada se ejecutó contra el stack E1–E8, ni contra Jaeger, ni contra un banco real).

# Matriz de gates P2 — `pay-ledger` y `pay-settlement` (ola 3)

- Fecha: 2026-10-28 · Rama: `claude/adoring-allen-ly7r6f` · **Sin commit** (lo hace el coordinador).
- Fuente de los gates: [`docs/plan/PLAN-MAESTRO.md` §7](../../../plan/PLAN-MAESTRO.md). Cada fila es **PASS** (comando + salida literal en `evidencia/`), **GAP** (qué falta y de quién es) o **NO APLICA AÚN** (con el motivo).
- Esquema vendorizado del modelo: **`mantra-core-health-model` @ `af60b79`** (`SQL/pay/72_pay_ledger/ddl.sql` y `SQL/pay/78_pay_settlement/ddl.sql`), comprobado con `scripts/vendor-model-sql.sh --check` (`evidencia/3c-vendor-check.txt`).
- Las propuestas que salen de esta matriz están en [`PROPUESTAS.md`](./PROPUESTAS.md) (20–26).
- Cómo se corrió: una suite jest a la vez, `--maxWorkers=2`, Postgres del Compose (54321) con el rol `pay_<svc>` de cada servicio, **TigerBeetle real**. Ver «Entorno» al final: la máquina estaba saturada y el OOM killer del kernel mató TigerBeetle dos veces; las corridas válidas usan un TigerBeetle propio.

## Resumen

| # | Gate (§7) | Veredicto | Una línea |
|---|---|---|---|
| 1 | Typecheck, lint y unitarios | **PASS** | typecheck/build/eslint/`yarn lint` raíz en 0; suites completas verdes ×2 por servicio |
| 2 | Integración contra base real (+ TigerBeetle) | **PASS** | Postgres con el rol del servicio + TigerBeetle real; sin ORM (pg directo); ledger real en proceso aparte |
| 3 | Contrato | **PASS** (con alcance declarado) | respuestas y eventos validados contra OpenAPI/AsyncAPI; `contracts:lint` y `contracts:events` en 0 |
| 4 | Idempotencia en paralelo | **PASS** | N=10 en paralelo, misma clave, por cada mutación: un solo efecto |
| 5 | Autorización negativa | **PASS** con **GAP** (clave revocada: es de P1/P5) | otro comercio, sin identidad/clave, `test` contra `live`: probados |
| 6 | Separación | **PASS** con **GAP** menor (`template1`, de P1) | prueba nueva con el rol `dev_only_<svc>` + salida de `psql` + contenedor |
| 7 | Datos sensibles | **PASS** con **GAP** menor (propuesta 24) | script reproducible; canarios en logs, errores, eventos y filas |
| 8 | PCI | **PASS** (clasificación provisoria de settlement) | `pci-alcance.md` líneas 33–34 |
| 9 | Deriva de esquema | **PASS** | `drift.spec` ×2 contra el `ddl.sql` del modelo |
| 10 | Observabilidad (Jaeger) | **NO APLICA AÚN** | |
| 11 | Fallos | **PASS** (residual declarado: propuesta 27) | `SIGKILL` a TigerBeetle; reconciliador de recuperación TigerBeetle → Postgres; cortes de conexión de Postgres (pool, idempotencia, outbox) |
| 12 | Carga (T-01) | **NO APLICA AÚN** | |
| 13 | Sandbox (ola 4) | **NO APLICA AÚN** | |
| + | Dockerfile (docker build de producción) | **PASS** tras corregir 2 defectos; arranque del ledger **BLOQUEADO** (ENVIRONMENT) | imágenes construidas, probadas y borradas |
| + | Cortes de conexión de Postgres (3d) | **PASS** | `guardPool` + `pg_terminate_backend` en pool, clientes prestados, `@pay/idempotency` y `@pay/outbox` |
| + | Inmutabilidad de registros de dinero (3c) | **GAP** propuesto, no implementado | propuesta 20 |

---

## 1 · Typecheck, lint y unitarios — PASS

Comandos (salida literal en [`evidencia/3a-gates.txt`](./evidencia/3a-gates.txt) y, tras la vendorización, [`evidencia/3c-gates.txt`](./evidencia/3c-gates.txt)):

```text
(cd services/pay-ledger && yarn typecheck)        exit=0
(cd services/pay-settlement && yarn typecheck)    exit=0
(cd services/pay-ledger && yarn build)            exit=0
(cd services/pay-settlement && yarn build)        exit=0
yarn eslint "services/pay-ledger/**/*.ts" "services/pay-settlement/**/*.ts"   exit=0
yarn lint   (raíz, todo el repo)                  exit=0
```

Suites completas con TigerBeetle real, `--maxWorkers=2`:

| Servicio | Corrida | Suites | Pruebas | Salida |
|---|---|---|---|---|
| pay-ledger | 1 | 19/19 | **299/299** | `evidencia/3d-test-pay-ledger-run1.txt` |
| pay-ledger | 2 | 19/19 | **299/299** | `evidencia/3d-test-pay-ledger-run2.txt` |
| pay-settlement | 1 | 29/29 | **570/570** | `evidencia/3d-test-pay-settlement-run1.txt` |
| pay-settlement | 2 | 29/29 | **570/570** | `evidencia/3d-test-pay-settlement-run2.txt` |

(Serie 3d, posterior al reconciliador y a `guardPool`; la serie 3c —276/276 ×2 y 560/560 ×2, `evidencia/3c-test-*`— quedó como antecedente.) Comando de cada corrida: `cd services/<svc> && TB_ADDRESS=127.0.0.1:54310 NATS_URL=nats://127.0.0.1:54250 PAY_TEST_NATS_URL=nats://127.0.0.1:54250 yarn test --maxWorkers=2` (TigerBeetle y NATS **propios**, ver «Entorno»; Postgres del Compose). Lista de las pruebas nuevas con su resultado: [`evidencia/3c-pruebas-nuevas.md`](./evidencia/3c-pruebas-nuevas.md).

- Pruebas **nuevas** de esta ola: `separation.spec.ts` (×2 servicios), `sensitive-data.spec.ts` (×2), `idempotency-parallel.spec.ts` (ledger), `faults.spec.ts` (ledger), `holds-accounts-fk.spec.ts` (ledger).
- Corridas que **no** cuentan (se conservan en `evidencia/` con su causa, regla 80.4): ver «Entorno».

## 2 · Integración contra base real — PASS

- **Postgres real**: todas las suites con base abren un esquema aislado en la base del servicio **con el rol del servicio** (`PAY_TEST_DATABASE_URL=postgres://pay_<svc>:…@127.0.0.1:54321/pay_<svc>`, `test/env.ts`) y le aplican el `ddl.sql` vendorizado. Ningún ORM: ambos servicios hablan SQL parametrizado con `pg` (no hay ORM que mockear).
- **TigerBeetle real**: `pay-ledger` en todas sus suites (cuentas, transferencias, retenciones pendientes con vencimiento nativo, invariante global); `pay-settlement/test/ledger-real.spec.ts` (11 pruebas) arranca el **binario real** `services/pay-ledger/dist/main.js` como proceso aparte y le habla por HTTP.
- **NATS JetStream real**: `pay-ledger/test/events.spec.ts` (relé del outbox en orden y una sola vez) y `pay-settlement/test/nats.spec.ts` (consumidores durables, duplicados, basura).
- Dobles declarados (regla 65): conectores y, en el resto de las suites de settlement, el ledger (`FakeLedger`); el contrato del ledger real se ejercita en `ledger-real.spec.ts`.
- **No cubierto**: banco real (Q-11, T-03) y stack E1–E8 completo (lo corre P1).

## 3 · Contrato — PASS (alcance declarado)

```text
yarn contracts:lint     exit=0   (13 contratos válidos)
yarn contracts:events   exit=0
```
(`evidencia/3a-gates.txt`.)

| Qué | Dónde | Qué prueba |
|---|---|---|
| Cada operación del contrato tiene su ruta y no hay rutas fuera del contrato | `pay-ledger/test/contract.spec.ts` (13), `pay-settlement/test/contract.spec.ts` (4) | contrato ↔ implementación en los dos sentidos |
| **Cada respuesta HTTP de las pruebas se valida contra el OpenAPI** | helper `checked(ctx, método, ruta, respuesta)` (`@pay/testing` `loadContract`), usado en `transactions`, `holds`, `statements`, `payout`, `batch`, `reconciliation`, `public-payouts`… | forma de las respuestas, incluidos los `problem+json` |
| **Cada evento del outbox se valida contra el AsyncAPI** | `pay-ledger/test/events.spec.ts` (9), `pay-settlement/test/events-mode.spec.ts`, `reconciliation.spec`, `payout.spec`, `consumers.spec` (eventos de entrada) | forma de los eventos emitidos y consumidos |
| Llamadas entrantes documentadas (quién puede llamar qué, con qué modo) | `pay-settlement/test/inbound-mode.spec.ts` | no se asumen llamadores |
| Cliente HTTP real de settlement contra el contrato de conectores y ledger | `connectors-client.spec.ts` (44), `ledger-client.spec.ts` (24) | respuestas conformes al contrato, ambiguas, caídas |

**Alcance declarado:** los «tests de consumidor» son validadores construidos desde los YAML (`loadContract`) que se aplican a las respuestas y eventos **reales** de nuestros servicios, no un generador de clientes. Contra el proveedor real de **otro** carril (`pay-connectors`) el contrato se ejercita con un servidor HTTP local conforme al contrato; que el simulador y el conector real pasen los **mismos** tests es el gate «Sandbox» (ola 4).

## 4 · Idempotencia en paralelo — PASS

N = 10 peticiones simultáneas; efecto medido en TigerBeetle (saldo) **y** en Postgres (filas). Nota de comportamiento (verificada): una duplicada que llega mientras la primera sigue en curso recibe `409 idempotency_request_in_progress` (señal de «reintentá», no un segundo efecto); la prueba lo acepta explícitamente y exige un reintento posterior que repita la respuesta.

| Mutación | Misma clave ×N | Claves distintas, misma operación de negocio | Prueba |
|---|---|---|---|
| `POST /transactions` (ledger) | un 201, el resto 200 (o 409 en curso); 1 fila | 1 efectiva | `idempotency-parallel.spec.ts` · `transactions.spec` («10 llamadas simultáneas idénticas») |
| `POST /holds` | 1 retención; disponible baja una vez | — (clave natural `business_ref`+`attempt`) | `idempotency-parallel.spec.ts` |
| `POST /holds/{id}/post` | 1 confirmación; `payout:clearing` sube una vez; el reintento repite (`Idempotency-Replayed`) | 5 simultáneas con claves distintas: 1×200 y 4×409 | `idempotency-parallel.spec.ts` · `holds.spec` |
| `POST /holds/{id}/void` | 1 anulación; el monto vuelve una vez | — | `idempotency-parallel.spec.ts` |
| contracargo (débito a `pending` mayor que lo pendiente) | 1 efectiva; deuda 50, no 100 | 10 contracargos de 30 sobre 100: salen 100 de `pending`, 200 son deuda | `idempotency-parallel.spec.ts` · `transactions.spec` |
| `POST /batches` (settlement) | 5 cortes del mismo lunes: 1 lote, 1 pago por comercio | — | `batch.spec` |
| `POST /payouts` | 10 con la misma clave: 1 pago | 20 pagos que superan el disponible: saldo nunca negativo | `payout.spec`, `ledger-real.spec` |
| `POST /reconciliation_runs` | 5 corridas: excepciones no se duplican, 1 aviso cada una | — | `reconciliation.spec` |
| `POST /charges` (comisión/deuda) | 5 simultáneas: se cobra una vez | — | `netting.spec` |
| eventos de entrada (inbox) | el mismo evento ×10: 1 procesado, 9 duplicados | tres versiones a la vez, repetidas | `consumers.spec` |

**Descubierto al escribirlas:** `POST /transactions` y `POST /holds` (crear) **no** guardan la `Idempotency-Key` (se deduplican por `business_ref`+`attempt`); sí lo hacen `/holds/{id}/post` y `/void`. Es coherente con el contrato; la duplicada de `/transactions` responde `200 result: exists`.

## 5 · Autorización negativa — PASS, con GAP (clave revocada)

Los servicios de P2 son **internos**: la autenticación de la API pública (clave de API, modo de la clave) ocurre en `pay-edge` (P1) y la emisión/revocación de claves en `pay-merchants` (P5). P2 recibe `X-Service-Id` (identidad de servicio) y, desde el borde, `X-Merchant-Id` y `X-Pay-Mode` ya resueltos (D-28).

| Caso del gate | Resultado | Prueba |
|---|---|---|
| **Otro comercio** (IDOR/BOLA) | `GET /payouts?merchant_id=` de otro comercio ⇒ 422 (el filtro no existe en la API pública) y la lista de A no incluye lo de B; `GET /balance` de B no filtra el de A y un comercio que nunca operó recibe el mismo formato en cero (no se filtra su existencia); `GET /payouts/{id}` de pay-edge ⇒ 403 | `public-payouts.spec` («IDOR»), `statements.spec` («otro comercio, otro saldo») |
| **Sin clave / sin identidad** | sin `X-Service-Id` válido ⇒ 403 en **todas** las rutas internas; sin `X-Merchant-Id` válido en las públicas ⇒ 401 (también con inyección SQL en el valor); sin `Idempotency-Key` ⇒ 400 | `contract.spec` (ledger y settlement), `public-payouts.spec`, `statements.spec`, `transactions.spec` |
| **Servicio no autorizado / rol insuficiente** | un servicio que no está en la política de la ruta ⇒ 403 (pay-risk, pay-payments en `/payouts`, pay-edge en rutas internas…); un operador no puede pedir un ajuste (403) y un `admin` sí | `contract.spec`, `payout.spec` («solo pay-schedules y la consola»), `batch.spec`, `resolve.spec`, `reconciliation.spec` |
| **Credencial de operador inválida/vencida** | firma ajena o alterada, `alg: none`, confusión HS256, `iat` futuro, `exp` ausente ⇒ 401 sin decir por qué; nada cambia | `operator-token.spec` (34), `resolve.spec` |
| **`test` contra `live`** (D-28/D-26) | sin `X-Pay-Mode` o con valor inválido ⇒ 403 en cada ruta; un despliegue `sandbox` rechaza claves `live` y al revés; `settlement` live contra un ledger sandbox **no paga** (403 del ledger real, sin orden al conector); mismas cuentas lógicas en cada modo suman por separado | `mode.spec` (ledger 45, settlement 31), `inbound-mode.spec`, `ledger-real.spec` («un pay-settlement live apuntando a un ledger sandbox NO paga») |
| 404 sin filtrar existencia | un id mal formado o inexistente responde 404 `resource_not_found` igual | `holds.spec`, `reconciliation.spec` |

**GAP — clave de API revocada:** no es verificable en P2. Quien la revoca y quien la rechaza es `pay-merchants`/`pay-edge` (P1/P5); P2 nunca ve la clave. Lo único de P2 que se puede decir es que **no confía en el cliente**: ante una identidad de servicio ausente responde 403 y ante un modo ausente 403. La prueba «clave revocada ⇒ 401 y `pay-ledger` no se entera» es del flujo E1/E7 (P1). **De quién:** P1 (borde) y P5 (claves).

## 6 · Separación — PASS, con GAP menor

**Prueba de integración nueva** (en cada servicio): `test/separation.spec.ts` — usa el rol REAL del Compose (`pay_ledger`/`dev_only_ledger`, `pay_settlement`/`dev_only_settlement`; escrito en la prueba a propósito, no leído del entorno) y comprueba, 10 casos por servicio:

1. el rol entra a su base (`current_user`, `current_database()`);
2. no es superusuario, no crea bases ni roles, no replica, no se salta RLS, no pertenece a otro rol;
3. `has_database_privilege(..., 'CONNECT')` es verdadero **solo** sobre la base propia;
4. **intentar conectarse a cada una de las demás bases de servicio, a `pay_test` y a `postgres` da `42501` (permission denied)**, no otra causa; hay un caso de control que demuestra que la misma sonda SÍ detecta una conexión permitida;
5. el rol de **otro** servicio tampoco entra a esta base (el espejo);
6. **la aplicación completa (`AppModule`) arranca con ESE rol**: `/health/ready` ⇒ 200 con la base propia y el pool de la aplicación es de ese rol;
7. desde el pool de la aplicación una consulta entre bases (`pay_ledger.public.…`) falla (`0A000`).

Evidencia: `evidencia/3c-test-pay-*-run*.txt` (suites completas) y `evidencia/3a-separacion-psql.txt` (salida literal de `psql` con `dev_only_ledger` y `dev_only_settlement`, y de `platform/scripts/check-db-separation.sh`: **168 comprobaciones correctas, 0 fallas**).

**En contenedor:** la imagen de `pay-settlement` arrancó con `DB_USER=pay_settlement` y `/health/ready` respondió `database: up` (`evidencia/3a-docker-humo-settlement.txt`). La de `pay-ledger` no pudo arrancar por una causa del entorno (ver gate «Dockerfile»).

**GAP menor (de P1) — `template1`:** cualquier rol de servicio abre `template1` (`PGPASSWORD=dev_only_ledger psql -U pay_ledger -d template1` ⇒ entra). No contiene datos de negocio, pero el gate dice «sin permisos sobre las demás bases». La prueba lo declara con `it.failing` (pasa mientras el hueco exista y **falla cuando P1 lo cierre**). Propuesta 22: `REVOKE ALL ON DATABASE template1 FROM PUBLIC` en `platform/postgres/init-databases.sh`.

## 7 · Datos sensibles — PASS, con GAP menor

**Script reproducible:** [`scripts/check-sensitive-data.sh`](../../../../scripts/check-sensitive-data.sh) (`--static`, `--self-test`).

- *Etapa estática* (grep sobre `src/`, `sql/` y los contratos de P2; 0 coincidencias por regla): ningún `console.*`; ningún log vuelca cuerpos/DTO/extractos/glosas; ningún campo `pan|card_number|cvv|cvc|holder|full/first/last_name|document_number|national_id` en código, SQL ni contratos (`x-pii: none`); ningún literal de 15–19 dígitos; la telemetría no activa captura de valores (`enhancedDatabaseReporting`, `requestHook`, `setAttribute`); el importador sigue **descartando la glosa** del banco.
- *Etapa dinámica* (`test/sensitive-data.spec.ts` de cada servicio): se meten **canarios** (PAN de prueba `4111…1111` pelado, con espacios y con guiones; `CVV=737`; documento; nombre) por todas las puertas —campos que el contrato no tiene, ids malformados en cuerpo/ruta/consulta/cabecera, glosa/titular/documento/cuenta de origen en **extractos CSV y `camt.053`**, eventos de entrada con el dato dentro, y un **error interno cuyo mensaje trae el dato**— junto a operaciones legítimas, y se busca en **todo lo que el servicio produjo**: logs (stdout/stderr: pino y logger de Nest), respuestas de error (`problem+json`), eventos del outbox y **todas las filas de todas las tablas** del esquema. Detector: canarios + valores con forma de PAN (15–19 dígitos, Luhn, con separadores) + nombres de campo sensibles. Control negativo: el detector grita sobre el mismo material con un canario añadido; el script tiene `--self-test`.
- Resultado: `datos sensibles: LIMPIO (0 fallas)` — 7 reglas estáticas en PASS; `sensitive-data.spec` ledger 5/5 y settlement 3/3 (incluye 3 casos `it.failing` que documentan los GAP de abajo y se invertirán cuando P1 los cierre).

Salida literal: [`evidencia/3c-datos-sensibles.txt`](./evidencia/3c-datos-sensibles.txt) y [`evidencia/3c-datos-sensibles-selftest.txt`](./evidencia/3c-datos-sensibles-selftest.txt).

**Lo que la prueba descubrió (un GAP abierto con `it.failing` que avisa cuando se cierre; el otro ya se cerró):**

| Hallazgo | Severidad | Dónde | Propuesta |
|---|---|---|---|
| ~~La `Idempotency-Key` se guarda tal cual 24 h~~ **CERRADO por P1** durante esta tanda: `@pay/idempotency` guarda una clave con forma de PAN como `masked-<sha256>` (no la rechaza; la idempotencia sigue). Las dos pruebas `it.failing` avisaron al cerrarse y se convirtieron en pruebas normales (ledger y settlement: sin PAN en la base ni en la respuesta; la clave queda enmascarada) | — | `@pay/idempotency` | — (propuesta 23 cerrada) |
| La ruta del cliente se refleja en `instance` del `problem+json` y en el log de acceso (`GET /holds/4111111111111111` ⇒ 404 con la ruta). Vuelve al mismo cliente | MENOR | `ProblemFilter`/plantilla (P1) | 24 |
| Solo se prueba que el **código** no activa captura de valores en la telemetría; **no se inspeccionaron spans reales** (Jaeger) | — | gate «Observabilidad» | cuando exista E1 |

Lo que **sí** quedó limpio, y es la superficie más sensible de P2: la glosa de un extracto con PAN, titular y documento (CSV y `camt.053`) **no llega** a los logs, a las respuestas, a los eventos ni a ninguna fila (`pci-alcance.md` §3 «Provisoria» y pregunta B: esto es evidencia a favor de que, aunque el banco mande el PAN, el servicio no lo conserva; no reemplaza la confirmación del banco).

## 8 · PCI — PASS (clasificación provisoria de settlement)

`docs/cumplimiento/pci-alcance.md` §3 «Clasificación por servicio» (dueño: P1; revisión pendiente de P3 y de un QSA):

- línea 33: «| `pay-ledger` | P2 | **Fuera de alcance** | Solo montos y cuentas. Sin datos de tarjeta. | `contracts/asyncapi/ledger-settlement.yaml` (`x-pii: none`) |»
- línea 34: «| `pay-settlement` | P2 | **Fuera de alcance** | Cortes, payouts y conciliación. Sin datos de tarjeta. **Provisoria**: los extractos del banco (`camt.053`/CSV) pueden traer PAN enmascarado; confirmar con el banco que nunca llega completo. | pregunta B en §6 |»
- línea 96 (pregunta B, abierta): «¿Los extractos del banco (conciliación) pueden traer PAN completo? … Si sí, `pay-settlement` entra al alcance.»

Respaldo de P2 a esa clasificación: gate 7 (ni el PAN ni la glosa se conservan) y el contrato `x-pii: none`. **Qué sigue abierto y no es de P2:** la respuesta del banco a la pregunta B (Banco Mercantil, T-03/Q-11) y la validación de un QSA; mientras tanto la clasificación de `pay-settlement` es provisoria **tal como el documento la declara**.

## 9 · Deriva de esquema — PASS

Verificación (97.2): fuente de verdad (el `ddl.sql` del modelo, vendorizado) ↔ base aplicada ↔ mapa del código (`schema-map.ts`; no hay ORM). `drift.spec.ts` (ledger 5, settlement 6) comprueba tabla ausente, columna ausente, columna obligatoria no mapeada, nulabilidad y tipo divergentes, tablas sin mapear e índices con nombre autogenerado, **y que el verificador detecta cada tipo de deriva** (si no detectara, el «sin deriva» no valdría).

- Vendorización: `scripts/vendor-model-sql.sh` / `--check` (`evidencia/3c-vendor-check.txt`): **PASS** contra el modelo en `af60b79`; el `--check` **no falla si el repo del modelo no existe** (probado con `MODEL_REPO=/nonexistent` ⇒ `SKIP`, exit 0); y antes de copiar daba `FALLA` (control negativo).
- Los `001_ledger.sql` y `001_settlement.sql` de referencia **se quitaron** (`evidencia/3c-referencias-001.txt`: ninguna referencia en código, pruebas ni e2e). Las suites completas pasan ×2 por servicio **sin ellos**.
- Nueva prueba del constraint del modelo (`holds-accounts-fk.spec.ts`, 6 casos en tres niveles): correcto (el servicio registra las dos cuentas **antes** del `INSERT` de la retención, aceptada o rechazada), límite (cuenta de otro modo / solo una de las dos registrada ⇒ la base rechaza), inválido (cuentas inexistentes ⇒ la base rechaza; por la API, comercio que nunca operó ⇒ 422 limpio con cuentas registradas y fila `rejected`, cuentas con forma inválida ⇒ 400/422, nunca 500; el reintento converge). **Confirmado: `hold.service.ts` registra las cuentas con `AccountRegistry.register` dentro de la misma transacción y antes de ambos `INSERT` (línea 107 vs 124 y 141); no hace falta ningún cambio de código.** Control negativo: contra el SQL de referencia anterior la prueba falla (`evidencia/3c-control-negativo-fk.txt`; el control está parcialmente confundido porque ese SQL no trae las tablas de outbox, que ahora vienen en el `ddl.sql`).
- **ORM = mapa del código (`schema-map.ts`): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18).**

## 10 · Observabilidad (traza OTel de E1 en Jaeger) — NO APLICA AÚN

Motivo: la traza de E1 de punta a punta exige el stack completo (P1/P3/P4) corriendo con `OTEL_EXPORTER_OTLP_ENDPOINT`; P2 no está en el camino de E1 hasta el asiento (ledger) y el stack no se levanta en esta ola. Lo que sí existe: ambos servicios tienen `src/observability/telemetry.ts` con instrumentación de http/express/nest/pg, **solo activa** si hay `OTEL_EXPORTER_OTLP_ENDPOINT`, y la etapa estática del gate 7 verifica que no capture valores. Jaeger está levantado en el Compose (healthy) pero **no se inspeccionó ningún span**. Se activa con E1 (ola 3, P1).

## 11 · Fallos — PASS

**Experimento de inyección de fallos documentado** (`pay-ledger/test/faults.spec.ts`, ledger real, `evidencia/3c-test-pay-ledger-run*.txt`): se levanta un TigerBeetle propio (puerto libre al azar, binario copiado con otro nombre y caché reducida), se lo mata con **`SIGKILL`** en medio del servicio y se observa.

| Paso | Observado |
|---|---|
| TigerBeetle caído, `POST /transactions`, `POST /holds`, `/holds/{id}/post`, `/void`, `GET /balances` | **503 `ledger_unavailable`** en todas, en < 6 s (`TB_TIMEOUT_MS=1500`); las lecturas también (nunca un saldo viejo) |
| Efectos a medias | ninguna fila del movimiento fallido, ninguna de la retención nueva, ningún evento; la retención previa sigue `pending` |
| TigerBeetle vuelve (mismos datos) | el cliente se reconecta solo; el reintento de la transacción termina; `/holds/{id}/post` con la **misma clave** que había recibido 503 da 200 (**el 503 no quedó guardado como respuesta final**), el siguiente reintento repite (`Idempotency-Replayed`); la anulación posterior da 409 |
| Estado final | un solo movimiento y una sola retención, saldos exactos, **invariante global `ok`** |
| Retención con vencimiento que vence durante la caída | al volver el monto se restituye solo; invariante `ok` |

**Hallazgo (propuesta 25) y su cierre en 3d — reconciliador de recuperación TigerBeetle → Postgres** (`src/ledger/reconciler.service.ts`, `test/reconciler.spec.ts`, 13 pruebas con TigerBeetle y Postgres reales, `evidencia/3d-test-pay-ledger-run*.txt`):

- **Qué hace.** TigerBeetle aplica primero y Postgres registra después; si el proceso muere entre los dos, o el cliente nativo entrega tras un *timeout* lo que quedó en su cola, TigerBeetle queda por delante. El job (al arrancar y cada `LEDGER_RECONCILE_INTERVAL_MS`, 5 min por defecto; candado de sesión de Postgres por esquema y modo ⇒ una réplica a la vez) lee de TigerBeetle **solo** las transferencias marcadas como de este despliegue y modo, las agrupa por operación y busca la operación en Postgres. Lo que no está: **huérfano** (aviso `ledger.reconciliation.diverged` nivel error con importes y cuentas, sin `business_ref` ni datos de personas, + gauges `orphanGroups/orphanAmountMinor/resolutionAhead`). Una retención que Postgres da por `pending` y TigerBeetle ya resolvió: **resolución adelantada**. Una retención huérfana ya vencida: se cuenta (`expiredHolds`), no alerta (TigerBeetle devolvió el monto solo).
- **Qué NO hace, a propósito.** Solo lee: no inserta, no actualiza, no borra, no asume nada (reglas 5 y 11). Y **no reconstruye la fila**: de una transferencia solo quedan ids (hashes irreversibles) y la marca; el `business_ref` y el `attempt` (NOT NULL) solo los tiene el llamador. Para que sea posible hace falta esquema nuevo (propuesta 27: tabla de hallazgos y tabla de intención previa), que es del modelo.
- **La marca.** Toda transferencia lleva `user_data_128` = grupo de la operación (asiento, o retención + post/void), `user_data_64` = despliegue, `user_data_32` = modo; TigerBeetle filtra del lado del servidor. Es lo que permite atribuir un huérfano y ignorar lo de otro despliegue/modo.
- **Los tres niveles** (`reconciler.spec.ts`): *correcto* — sin divergencia no hace nada (6 transferencias / 4 operaciones, `ok`, Postgres intacto, invariante `ok`). *Límite* — TigerBeetle por delante por **una pata**, por **varias patas enlazadas**, por un **contracargo partido**, por una **retención pendiente** y por una **segunda fase**: en cada caso se informa (con nombres de cuenta e importe) y **el reintento del llamador con la misma clave adopta lo aplicado sin duplicar** (saldos exactos, invariante `ok`, reconciliador `ok`); lo muy reciente (`graceMs`) no se informa; la retención vencida no alerta. *Inválido* — transferencias de otro despliegue, de otro ledger de TigerBeetle y sin marca no se leen; las de otro modo solo aparecen al reconciliar ese modo; **idempotente** (3 corridas con huérfanos pendientes ⇒ mismo informe, Postgres y TigerBeetle sin cambios); **falla cerrado** (error al leer TigerBeetle, a mitad del recorrido o al conectar a Postgres ⇒ `failed`, sin `ok` ni huérfanos a medias, alerta propia, y el huérfano sigue ahí cuando se vuelve a poder leer); **una sola réplica** (con el candado tomado, `skipped` sin leer nada).
- **Cómo se provoca la caída.** Un trigger de PRUEBA, en el esquema desechable, hace fallar el INSERT/UPDATE de Postgres justo después de que el servicio aplicó en TigerBeetle: el servicio responde 500 de verdad y TigerBeetle queda por delante (no se simula con una transferencia armada a mano).
- **Veredicto.** El riesgo de dinero movido y no visible queda **detectado, avisado y adoptable por el reintento**; el residual que sí queda es que, si **nadie** reintenta, un huérfano **requiere a una persona** (regla 11) hasta que el modelo agregue las tablas de la propuesta 27. Por eso el gate pasa a PASS pero el residual está declarado, no escondido.

Otros experimentos de fallos que ya existían y se corren en las mismas suites: riel ambiguo (`ambiguous_executed`/`ambiguous_lost`) ⇒ retención viva y escalamiento, nunca anulada; ledger caído a mitad de un pago/corte/neteo (`failNext`, `applyFirst`) ⇒ converge al reintentar; extracto ilegible o conector caído ⇒ corrida `failed` sin asientos; muerte del servicio justo tras aplicar en TigerBeetle y antes de Postgres (contracargo) ⇒ el reintento no duplica.

## 12 · Carga (objetivo de T-01) — NO APLICA AÚN

Motivo: T-01 (el objetivo de capacidad) todavía no tiene un valor acordado ni un entorno de carga; medir «su parte» sin objetivo sería inventar una meta. Lo único medible hoy sin inventar: las suites de concurrencia (gate 4) corren 10–20 operaciones simultáneas con efecto único. **Qué lo destraba:** el valor de T-01 (dueño del producto) y un entorno de carga (P1).

## 13 · Sandbox (ola 4) — NO APLICA AÚN

Motivo: «sus flujos E2E pasan contra `pay-mockbank` y los tests de contrato del conector son idénticos para el simulador y el real» es del cierre de la ola 4. Hoy `e2e/pending/e4.e2e.ts` y `e8.e2e.ts` compilan y pasan lint pero **no se ejecutaron** (dependen de que P4 emita `payment_intent_id`/`merchant_id` en el extracto y de `pay-mockbank`; ver `ola-2/P2/FLUJOS-E4-E8.md`).

## + · Dockerfile (docker build de la imagen de producción) — PASS tras 2 correcciones

`docker build -f services/<svc>/Dockerfile .` (contexto = raíz del repo, igual que la instrucción de cada Dockerfile). **No se subió ninguna imagen a ningún registro.** Salidas: `evidencia/3a-docker-build-pay-ledger.txt`, `…-pay-settlement.txt`.

**Antes de mi cambio el build fallaba (también para los otros 10 servicios, que usan la misma plantilla):**
1. `yarn workspaces foreach -A … --from X` ⇒ `Usage Error: property "all" forbids using property "from"` (Yarn 4.14.1). Corregido: `-R … --from X`.
2. `yarn install --immutable` ⇒ `YN0028 The lockfile would have been modified` porque el Dockerfile copia **un solo** servicio y `yarn.lock` lista los 12. Corregido: `COPY services ./services` y, tras compilar, `find services -mindepth 1 -maxdepth 1 ! -name <svc> -exec rm -rf {} +` (la imagen lleva solo ese servicio).

Resultado: **ambos builds `rc=0`** (imagen de 991 MB cada una; incluye `devDependencies`, ver propuesta 21). Arranque:

- `pay-settlement`: `docker run --network host -e DB_USER=pay_settlement … ` ⇒ `/health/live` ok, `/health/ready` `database: up`, proceso como usuario `node` (no root). **PASS** (`evidencia/3a-docker-humo-settlement.txt`).
- `pay-ledger`: **BLOQUEADO — ENVIRONMENT.** El cliente nativo de TigerBeetle aborta dentro del contenedor (`error(io): io_uring is not available … PermissionDenied`): este kernel de pruebas deshabilita `io_uring` en contenedores (el mismo cliente corre bien en el host). Qué lo destraba: un host con `kernel.io_uring_disabled=0` o un perfil de contenedor que lo permita. (`evidencia/3a-docker-humo-ledger.txt`.)

**Nota de entorno del build:** la salida a internet de esta máquina pasa por un proxy que re-firma TLS, así que el build usó una imagen base local con la CA del proxy (`HUB=localhub`); no es parte del servicio (no se versionó). Limpieza: imágenes `pay-ledger-gate`, `pay-settlement-gate` y la base local **borradas** y caché de build podada (`evidencia/3a-docker-limpieza.txt`).

**GAP (P1):** no existe `.dockerignore` en la raíz: el contexto completo pesa ~2 GB; por eso el build se hizo con un contexto armado con exactamente lo que el Dockerfile copia. Propuesta 21.

## + · Cortes de conexión de Postgres (pool y clientes prestados) — PASS

Defecto transversal (P5, P4): un `pg.Pool` sin manejador de `error` tira el proceso cuando Postgres corta una conexión. `pool.on('error')` **solo** cubre las ociosas; si el corte llega con la conexión **prestada** (`pool.connect()` en una transacción, un candado de asesoría, el relé del outbox) el cliente emite `error` sin escucha y el proceso muere igual. Corrección en `pay-ledger` y `pay-settlement`: `src/pool-guard.ts` (idéntico al de `pay-connectors`; `guardPool` registra el manejador del pool **y** `pool.on('connect', c => c.on('error', …))`) envolviendo el único `Pool` propio de cada servicio (`database.module.ts`); el pool del ORM (knex) se prueba aparte. Además, `inTransaction` ya no deja que un `ROLLBACK` fallido tape el error real, y los `pg_advisory_unlock` de settlement no tapan el resultado si la conexión murió.

`test/pool-resilience.spec.ts` (10 pruebas por servicio, Postgres real, cortes con `pg_terminate_backend`; los cortes son siempre de pids que la prueba identifica, nunca de otras suites):

| Nivel | Caso | Resultado |
|---|---|---|
| control | un `Pool` sin manejador mata un proceso hijo al cortarle la conexión; el `PG_POOL` real tiene los dos manejadores | PASS |
| correcto | corte de UNA conexión ociosa ⇒ el proceso sigue y el pool repone | PASS |
| límite | corte de TODAS las ociosas a la vez y la del ORM | PASS |
| límite | corte en medio de una consulta ⇒ la petición falla con `500 problem+json internal_error` (sin SQL ni mensaje) y el proceso sigue | PASS |
| límite | conexión PRESTADA cortada entre dos consultas (`inTransaction`) ⇒ la operación falla, el `ROLLBACK` no tapa el error, la conexión muerta se descarta | PASS |
| inválido | el log solo lleva el NOMBRE del error: ni mensaje de Postgres, ni SQL, ni host/rol | PASS |
| `@pay/idempotency` | corte DENTRO de `atomic` ⇒ el proceso sigue, la operación falla, **el efecto no queda**, la clave queda libre (`started`, sin bloqueo), el reintento con la misma clave lo aplica **una vez** y el siguiente lo repite | PASS |
| `@pay/outbox` (inbox) | corte dentro de `processOnce` ⇒ ni el efecto ni la marca del evento; el reintento procesa una vez y la tercera entrega es duplicado | PASS |
| `@pay/outbox` (relé) | corte con la transacción del relé abierta y el evento ya «publicado» ⇒ `drainOnce` falla, **nada queda marcado**, el siguiente ciclo lo entrega otra vez (al menos una vez, mismo id para deduplicar) | PASS |

Controles negativos (`evidencia/3d-control-negativo-pool-ledger.txt`, `…-settlement.txt`): sin el manejador del pool caen 6 pruebas con `Unhandled error. (error: terminating connection due to administrator command)`; sin el manejador de cada cliente prestado caen 3 (idempotencia, inbox y la del ORM). Ambos restaurados ⇒ 10/10.

**Alcance honesto.** El corte «justo después de enviar `COMMIT` y antes de recibir la respuesta» (efecto aplicado, respuesta perdida) no se pudo provocar de forma determinista con `pg_terminate_backend`; la garantía para ese caso es la ya existente (ids deterministas + `ON CONFLICT`, el reintento converge) y se ejercita en `reconciler.spec.ts`. P1 publicó además un `guardPool` en `@pay/idempotency` (sin dependencia de Nest): los dos `pool-guard.ts` copiados pueden reemplazarse por ese (propuesta 29).

## + · Inmutabilidad de los registros de dinero de solo-agregar (pedido 3c) — GAP propuesto

Pregunta: ¿`ledger_transactions`, `ledger_legs`, `ledger_statement_lines`, `ledger_rejections` y `settlement_audit` deberían tener un guardián de inmutabilidad? **Sí.** `CLAUDE.md` regla 5: «los errores se corrigen con asientos inversos, nunca con `UPDATE` ni `DELETE`».

Evidencia (`grep` en `src/` de los dos servicios): las cinco tablas **solo reciben `INSERT`** (`ledger.service.ts:141,161,179,187`; `hold.service.ts:128`; `payout.service.ts:237`; `reconciliation.service.ts:230`); ningún `UPDATE`, `DELETE`, `TRUNCATE` ni `ON CONFLICT DO UPDATE`. Hoy la regla la cumple el código pero **no la base**: un `UPDATE ledger_legs SET amount_minor = …` a mano pasa y rompería el invariante sin dejar rastro. `ledger_holds` **no** debe llevarlo (es una máquina de estados legítima con `UPDATE`), ni las tablas de estado de settlement.

Qué rompería (riesgos): `invariant.spec.ts:51` borra a propósito una línea de extracto para probar la detección (necesitaría `DISABLE TRIGGER`); un futuro «aceptar una transacción rechazada» por `UPDATE` quedaría prohibido (se modelaría como fila nueva); las correcciones manuales de un DBA exigirían deshabilitar el trigger a propósito; `DROP SCHEMA … CASCADE` de las pruebas no se ve afectado. La propuesta concreta (función `forbid_mutation()` + `BEFORE UPDATE OR DELETE` por fila + `BEFORE TRUNCATE` por sentencia, con prueba de tres niveles) está en [`PROPUESTAS.md` #20](./PROPUESTAS.md). **No se implementó** (pedido del coordinador).

---

## Entorno y corridas descartadas (regla 80.4)

La máquina de pruebas estaba **saturada** durante esta ola: carga 10–17, 8+ procesos jest de otros carriles, builds de Docker y varios TigerBeetle de 2–3 GB de RAM sobre 16 GB sin swap. Clasificación con evidencia:

| Síntoma | Causa | Evidencia | Qué se hizo |
|---|---|---|---|
| El TigerBeetle compartido de desarrollo (`:54300`) quedó «detenido»; suites con 503 `ledger_unavailable` | **ENVIRONMENT — OOM killer del kernel** | `dmesg`: `Out of memory: Killed process … (p2-store) … anon-rss:3166940kB`; el log del compartido trae `client_table_entry_create: clients=64/64 evicting client` (saturado de clientes de varias corridas a la vez) | Las corridas válidas usan un TigerBeetle **propio** (`:54310`, caché reducida: ~2,1 GB en vez de 3,1 GB) y la prueba `faults` otro con `--cache-grid=128MiB` |
| `nats.spec` falla (503 de JetStream, timeout) en la corrida completa y pasa aislado 5/5 | **EXTERNAL — streams/consumidores NATS compartidos con otras corridas** | misma observación independiente del agente del modelo (`INTEGRACION.md` §7.5, fila `10l`/`10m`) | Reportado; no se subió ningún timeout |
| `faults.spec` falló en `beforeAll` (TigerBeetle de la prueba sin abrir el puerto) en 2 corridas | ENVIRONMENT bajo carga / colisión de puerto fijo | pasó aislado y en las corridas siguientes | La prueba pasó a puerto libre al azar y a registrar el log del proceso si falla |

Las salidas de esas corridas se conservan: `evidencia/3a-test-*` (primeras corridas, con TigerBeetle compartido) y `evidencia/3c-descartada-*`. **No hay `skip`, no se subió ningún timeout y no se agregó ningún reintento.** Queda sin cubrir: nada más allá de lo anotado como GAP o `NO APLICA AÚN`.

**Tanda 3d.** Una primera serie de settlement dio 14 fallos por `No space left on device` al crear esquemas de prueba (ENVIRONMENT: el disco compartido se llenó por builds de otros carriles; `evidencia/3d-descartada-settlement-run1-disco-lleno.txt`) y una segunda falló una sola prueba mía porque P1 cambió `@pay/idempotency` mientras corría (de «rechazar» a «enmascarar» la clave con forma de PAN; la prueba se adaptó a lo que la librería hace hoy, `3d-descartada-settlement-run2-…`). La serie 3d de arriba se corrió completa después, con TigerBeetle y NATS propios. Quedó **detenido** el TigerBeetle compartido (`:54300`) y se bajó el NATS propio.

## No cubierto (consolidado)

- Stack E1–E8, Jaeger, banco real, carga T-01, sandbox: ver filas 10, 12, 13.
- Arranque del contenedor de `pay-ledger` (io_uring).
- Clave de API revocada (P1/P5).
- Que el banco no envíe PAN completo (pregunta B).
- Spans reales de la telemetría.
- Corte de Postgres justo entre el envío de `COMMIT` y su respuesta (no determinista de provocar).
- Reconstrucción automática de la fila de un huérfano de TigerBeetle (imposible con el esquema actual: propuesta 27).
- Métricas del reconciliador fuera del proceso (no hay backend de métricas: propuesta 30).
- Pools de los otros 9 servicios y de `@pay/testing` (propuesta 29).
