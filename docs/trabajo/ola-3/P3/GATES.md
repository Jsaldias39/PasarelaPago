> **AVANCE (matriz de gates): 10 / 13 gates de PLAN-MAESTRO §7 en PASS (6 de ellos con un GAP declarado y con dueño: 1, 4, 5, 6, 7 y 11) · 3 `NO APLICA AÚN` (10, 12 y 13)** — más la fila de Dockerfile en PASS tras 3 correcciones. Peldaño: **`TESTED`** (nada se ejecutó contra el stack E1–E8 completo ni contra un banco real; los tres colaboradores de `pay-payments` —riesgo, conectores, ledger— son dobles declarados que validan el contrato). **Pendiente declarado:** la corrida 2 de la suite completa de `pay-payments` (el coordinador reservó la máquina; ver «Entorno»).

# Matriz de gates P3 — `pay-payments` y `pay-vault` (ola 3)

- Fecha: 2026-10-28 · Rama: `claude/adoring-allen-ly7r6f` · **Sin commit** (lo hace el coordinador).
- Fuente de los gates: [`docs/plan/PLAN-MAESTRO.md` §7](../../../plan/PLAN-MAESTRO.md). Cada fila es **PASS** (comando + salida literal en `evidencia/`), **GAP** (qué falta y de quién es) o **NO APLICA AÚN** (con el motivo). Formato igual al de [`../P2/GATES.md`](../P2/GATES.md).
- Esquema vendorizado del modelo: **`mantra-core-health-model` @ `af60b79`** (`SQL/pay/74_pay_payments/ddl.sql` y `SQL/pay/79_pay_vault/ddl.sql`), comprobado con `yarn sql:check` en cada servicio (`evidencia/3c-gates.txt`).
- Cómo se corrió: una suite jest a la vez, `--maxWorkers=2`, Postgres del Compose (54321) con el rol de cada servicio, Temporal y NATS reales, riesgo/conectores/ledger como dobles que validan el contrato (regla 65), Jaeger del Compose para las trazas.
- Hallazgos de esta ola que cambiaron código (todos con prueba y control negativo): `PRODUCT_BUG` de la falla intermitente de `internal.api.spec` (gate 4), `pg.Pool` que tumbaba el proceso (gate 11), PAN/NIT/CI en rutas y `url.query` en spans (gate 7) y la imagen de `pay-payments` que no arrancaba en alpine (gate Dockerfile).

## Resumen

| # | Gate (§7) | Veredicto | Una línea |
|---|---|---|---|
| 1 | Typecheck, lint y unitarios | **PASS** con **GAP** menor | typecheck/build/eslint/`yarn lint` raíz en 0; pay-vault 129/129 ×2; pay-payments 375/375 ×1 (la corrida 2 de 3c quedó pendiente) |
| 2 | Integración contra base real | **PASS** | Postgres, Temporal y NATS reales; sin ORM (pg directo, `MikroOrmModule` sin entidades) |
| 3 | Contrato | **PASS** (con alcance declarado) | respuestas y eventos validados contra OpenAPI/AsyncAPI; `contracts:lint` y `contracts:events` en 0 |
| 4 | Idempotencia en paralelo | **PASS** en pay-payments tras corregir un `PRODUCT_BUG`; **GAP** en pay-vault (sin prueba concurrente) | pay-payments: 50 y 10 concurrentes; pay-vault no tiene prueba concurrente |
| 5 | Autorización negativa | **PASS** con **GAP** (clave revocada: P1/P5) | otro comercio, sin identidad, servicio no permitido, sin modo: probados |
| 6 | Separación | **PASS** con **GAP** menor (`template1`, de P1) | prueba nueva con el rol `dev_only_<svc>` + `psql` + script de plataforma |
| 7 | Datos sensibles | **PASS** con **GAP** menor | script reproducible; canarios `payer_name`/`legal_name`/PAN/NIT/CI en logs, eventos, errores, filas y trazas reales |
| 8 | PCI | **PASS** | `pci-alcance.md` líneas 28 y 30 |
| 9 | Deriva de esquema | **PASS** | `schema.drift.spec` + `sql:check` contra el modelo |
| 10 | Observabilidad (Jaeger) | **NO APLICA AÚN** | traza de E1 de punta a punta; sí hay spans reales de ambos servicios en Jaeger, enmascarados |
| 11 | Fallos | **PASS** con **GAP** | worker matado en cada actividad (2g), corte de Postgres en conexión ociosa y prestada (3c) |
| 12 | Carga (T-01) | **NO APLICA AÚN** | |
| 13 | Sandbox (ola 4) | **NO APLICA AÚN** | |
| + | Dockerfile (docker build de producción) | **PASS** tras 3 correcciones | imágenes construidas, arrancadas con el rol del servicio y borradas |

---

## 1 · Typecheck, lint y unitarios — PASS (con GAP menor)

Comandos (salida literal en [`evidencia/3c-gates.txt`](./evidencia/3c-gates.txt)):

```text
(cd services/pay-payments && yarn typecheck)   exit=0        (cd services/pay-vault && yarn typecheck)   exit=0
(cd services/pay-payments && yarn build)       exit=0        (cd services/pay-vault && yarn build)       exit=0
yarn eslint services/pay-payments services/pay-vault          exit=0
yarn lint   (raíz, todo el repo)                              exit=0
```

Suites completas (`yarn test --maxWorkers=2`, Postgres/Temporal/NATS reales):

| Servicio | Corrida | Suites | Pruebas | Salida |
|---|---|---|---|---|
| pay-payments | 1 | 30/30 | **375/375** | `evidencia/3c-pay-payments-test-1.txt` |
| pay-payments | 2 | — | — | **No ejecutada**: el coordinador pidió la máquina quieta (ver «Entorno») |
| pay-vault | 1 | 11/11 | **129/129** | `evidencia/3c-pay-vault-test-1.txt` |
| pay-vault | 2 | 11/11 | **129/129** | `evidencia/3c-pay-vault-test-2.txt` |

Respaldo de la tanda anterior (mismo código salvo las pruebas y arreglos de 3c): `3b-pay-payments-test-1/2.txt` (24 suites / 314 ×2) y `3b-pay-vault-test-1/2.txt` (79 ×2).

**GAP menor:** la segunda corrida verde de `pay-payments` sobre el código FINAL de 3c no se ejecutó. Comando que lo cierra: `cd services/pay-payments && yarn test --maxWorkers=2 > …/3c-pay-payments-test-2.txt`. Hasta entonces el peldaño de `pay-payments` en este gate es una sola corrida verde sobre el código final.

Pruebas nuevas de 3c: `pg-pool.error.spec.ts` (12 en cada servicio), `pg-pool.tx-cut.spec.ts` (2 en pay-payments, 1 en pay-vault), `path-sensitive.spec.ts` (27 en cada servicio), `separation.spec.ts` (10 en cada servicio), `sensitive-data.spec.ts` (6, pay-payments), `intents.insert.race.spec.ts` (3, pay-payments) y un caso nuevo en `internal.api.spec.ts`.

## 2 · Integración contra base real — PASS

- **Postgres real**: todas las suites con base abren un esquema aislado en la base del servicio **con el rol del servicio** (`PAY_TEST_DATABASE_URL=postgres://pay_<svc>:…@127.0.0.1:54321/pay_<svc>`, `test/env.ts`) y le aplican el `ddl.sql` vendorizado. No hay ORM que mockear: ambos servicios hablan SQL parametrizado con `pg` (`MikroOrmModule` está declarado sin entidades, D-18).
- **Temporal real** (`pay-payments`): flujos de cobro, reembolso y disputa con workers en proceso y como proceso aparte (SIGKILL). **NATS JetStream real**: relé del outbox y consumidores.
- **Dobles declarados (regla 65):** pay-risk, pay-connectors y pay-ledger, en tres niveles (correcto, límite, inválido) y validando el contrato (`test/doubles/doubles.spec.ts`). `pay-vault` usa `FakeVaultBackend`, un DOBLE en memoria prohibido con `PAY_MODE=live`.
- **No cubierto**: los servicios reales de otros carriles (arnés E2E de P1) y la bóveda real (P3.H3.M1).

## 3 · Contrato — PASS (alcance declarado)

```text
yarn contracts:lint     exit=0   (13 contratos válidos)        evidencia/3c-gates.txt
yarn contracts:events   exit=0   (40 mensajes, 350 mutantes rechazados, piiHits 0)   evidencia/3c-contracts-events.txt
```

| Qué | Dónde |
|---|---|
| Cada operación del contrato tiene su ruta y no sobra ninguna | `intents.api.spec.ts` («cada operación de payment_intents y refunds…», «…de internal-payments-v1.yaml…»), `vault.api.spec.ts` («el servicio implementa TODO internal-vault-v1.yaml») |
| Cada respuesta HTTP de las pruebas se valida contra el OpenAPI | `contract.validateResponse(…)` en `intents.api.spec`, `internal.api.spec`, `ola2.contracts.spec`, `vault.api.spec` |
| Cada evento del outbox se valida contra el AsyncAPI | `test/helpers/events-contract.ts` + `events.consumers.spec.ts`, `ola2.tanda2g.contradiction.spec.ts` |
| Los dobles cumplen el mismo contrato que el proveedor real | `test/doubles/doubles.spec.ts` (ninguna ruta apunta a copias en `docs/`) |

**Alcance declarado:** los «tests de consumidor» son validadores construidos desde los YAML que se aplican a las respuestas y eventos REALES de nuestros servicios; contra el proveedor real de otro carril el contrato se ejercita con un doble conforme. Que el simulador y el conector real pasen los mismos tests es el gate «Sandbox» (ola 4).

## 4 · Idempotencia en paralelo — PASS en pay-payments, GAP en pay-vault

| Mutación | Prueba | Resultado |
|---|---|---|
| `POST /payment_intents` misma clave ×50 | `intents.api.spec.ts` («50 POST concurrentes con la misma clave crean UN solo cobro») | un solo cobro |
| `POST /payment_intents` misma clave con otro cuerpo | ídem («…OTRO cuerpo es 422 idempotency_key_reused») | 422 |
| `POST /intents` (mandato) ×10 con **claves distintas**, mismo mandato y periodo | `internal.api.spec.ts` | un solo intento |
| Reembolsos concurrentes que juntos pasan el total | `refunds.disputes.spec.ts` | se acepta UNO |
| Inserción concurrente del MISMO intento | `intents.insert.race.spec.ts` (3 casos) | UNA inserta, el resto «ya existe», 0 errores |

### El `PRODUCT_BUG` que la prueba de 10 concurrentes escondía (regla 80.4: intermitente es bug hasta demostrar lo contrario)

- **Síntoma:** `internal.api.spec.ts` («el mismo mandato y periodo…», 10 `POST` concurrentes, claves distintas) falló una vez en una corrida completa de la tanda 2h (`2h-pay-payments-test-2.txt`): dos valores distintos en `body.id` (uno de ellos, una respuesta de error sin `id`). No se reprodujo 48 veces aisladas ni en las 5 corridas completas siguientes.
- **Dato que lo resolvió:** en esa misma salida, el filtro de errores registró `err: 'error', code: '23505'` (`unique_violation`) justo antes de la falla. Un 500 por violación de unicidad.
- **Causa:** `payment_intents` tiene DOS índices únicos que el mismo intento puede violar —la clave primaria `id` y `payment_intents_mandate_period_uidx`— y el `INSERT … ON CONFLICT (id) DO NOTHING` solo arbitra el primero. Cuando dos transacciones insertan a la vez la misma fila, una puede chocar con el índice del mandato y Postgres lanza `23505` en vez de ignorarla.
- **Reproducción determinista:** `test/intents.insert.race.spec.ts` (12 inserciones simultáneas del mismo intento, 60 rondas): **rojo** antes del arreglo con 28 errores `23505` (`evidencia/3c-flaky-internal-api-ROJO-insert-race.txt`).
- **Escenario original ×100 con CPU saturada** (8 procesos quemando CPU sobre 4 núcleos, 10 POST concurrentes por ronda, 1000 peticiones):
  - código anterior: **2 rondas de 100 fallidas**, estados `{"200":255,"201":743,"500":2}` y `23505` en el log (`evidencia/3c-flaky-internal-api-100x-ANTES.txt`);
  - código corregido: **0 rondas de 100 fallidas**, estados `{"200":234,"201":766}` (`evidencia/3c-flaky-internal-api-100x-DESPUES.txt`).
- **Corrección:** `src/persistence/intents.repo.ts` usa `ON CONFLICT DO NOTHING` sin objetivo (cualquier choque único es «ya existe») y `createInternalIntent` devuelve el intento ganador si la carrera la ganó otro pagador con otro id (`src/payments/payments.service.ts`). Prueba nueva en `internal.api.spec.ts` (dos pagadores a la vez, ningún 5xx).
- **Clasificación:** **`PRODUCT_BUG`** (no `ENVIRONMENT`): la carga solo ensanchó la ventana de la carrera. Hay una observación menor sin tocar: con claves distintas, las peticiones que llegan antes de que el ganador inserte responden `201` y no `200`; todas con el MISMO intento.

**GAP (pay-vault):** `pay-vault` no tiene una prueba de N peticiones paralelas con la misma clave sobre `POST /capture_sessions`, `DELETE /tokens/{t}` ni `reveal` (el reveal no guarda su respuesta de idempotencia a propósito, porque guardaría el PAN: `vault.api.spec.ts` «el reveal NO guarda su respuesta…»). Existe la repetición secuencial con la misma clave (misma sesión) y el borrado idempotente. **De quién:** P3 (mío); no se escribió en esta tanda porque el coordinador reservó la máquina antes de poder correrla. Prueba a agregar: `Promise.all` de 10 `POST /capture_sessions` con la misma clave → una sola fila en `capture_sessions`.

## 5 · Autorización negativa — PASS, con GAP (clave revocada)

Ambos servicios son **internos**: la clave de API y su modo se resuelven en `pay-edge` (P1) y se revocan en `pay-merchants` (P5). Llegan `X-Service-Id`, `X-Merchant-Id` y `X-Pay-Mode` ya resueltos.

| Caso del gate | Resultado | Prueba |
|---|---|---|
| **Otro comercio** (BOLA) | GET, cancelar y reembolsar un cobro AJENO ⇒ 404 idéntico a uno inexistente; el listado solo trae los del comercio; un token de la bóveda de OTRO comercio no se puede ver, usar ni borrar (404 idéntico) | `intents.api.spec.ts:187,203`; `vault.api.spec.ts:64` |
| **Sin identidad / servicio no permitido** | cada ruta pública sin `X-Service-Id` o de otro servicio ⇒ 403; las internas solo pay-schedules; `reveal` solo pay-connectors (pay-payments ⇒ 403 sin dato) | `intents.api.spec.ts:256,262`; `vault.api.spec.ts:117,169` |
| **Sin comercio** | `X-Merchant-Id` ausente o mal formado ⇒ 401, sin tocar la base | `intents.api.spec.ts:268`; `vault.api.spec.ts:200` |
| **`test` contra `live`** (D-28) | sin `X-Pay-Mode` o inválido ⇒ 403 en TODA ruta (públicas e internas, GET de reembolsos incluidos); los datos de `test` y `live` no se mezclan (id e idempotencia incluyen el modo) | `ola2.tanda2b.spec.ts` §3; `ola2.contracts.spec.ts` §8 |
| **Comercio suspendido / desconocido** | 403 `merchant_suspended`; ante la duda no se cobra | `intents.api.spec.ts:150,160` |
| **Idempotency-Key / ids con forma de PAN** | 422 sin repetir el valor; id con mala forma ⇒ 404 sin tocar la base | `intents.api.spec.ts:113,212` |

**GAP — clave de API revocada:** no es verificable en P3 (P3 nunca ve la clave). Es de `pay-edge` (P1) y `pay-merchants` (P5), flujo E1/E7.

## 6 · Separación — PASS, con GAP menor

**Prueba nueva** (en cada servicio): `test/separation.spec.ts`, 10 casos con el rol REAL del Compose (`pay_payments`/`dev_only_payments`, `pay_vault`/`dev_only_vault`, escritos en la prueba a propósito para que un `DB_USER` de superusuario del entorno no la vuelva verde): el rol entra a su base; no es superusuario ni crea bases/roles ni se salta RLS; `CONNECT` solo sobre la base propia; **conectarse a cada una de las demás bases, a `pay_test` y a `postgres` da `42501`**; el rol de otro servicio tampoco entra aquí; **la aplicación completa (`AppModule`) arranca con ese rol** y `/health/ready` da 200; una consulta entre bases desde el pool de la aplicación falla (`0A000`). Control: la misma sonda SÍ detecta la conexión permitida.

Salida literal de `psql` con `dev_only_payments` y `dev_only_vault` (`FATAL: permission denied for database …`) y de `platform/scripts/check-db-separation.sh` (**168 comprobaciones correctas, 0 fallas**): [`evidencia/3c-separacion-psql.txt`](./evidencia/3c-separacion-psql.txt). Contenedor: la imagen de cada servicio arrancó con `DB_USER=pay_<svc>` y `/health/ready` respondió `database: up` (`evidencia/3c-docker-humo-pay-*.txt`).

**GAP menor (de P1) — `template1`:** en esta instancia el rol de servicio todavía abre `template1` (la prueba lo declara con `it.failing`, que FALLA cuando P1 lo cierre y entonces hay que quitarle el `.failing`). El script de plataforma ya trae `CHECK_TEMPLATE1=1`; una instancia creada antes del cambio necesita recrear el volumen.

## 7 · Datos sensibles — PASS, con GAP menor

**Script reproducible:** [`scripts/check-sensitive-data-p3.sh`](../../../../scripts/check-sensitive-data-p3.sh) (`--static`, `--self-test`). Salida literal: [`evidencia/3c-datos-sensibles.txt`](./evidencia/3c-datos-sensibles.txt) (**«datos sensibles: LIMPIO (0 fallas)»**) y [`3c-datos-sensibles-selftest.txt`](./evidencia/3c-datos-sensibles-selftest.txt) (el control negativo: las reglas detectan lo plantado).

- *Etapa estática* (grep sobre `src/` y `sql/`, 9 reglas en PASS): ningún `console.*`; ningún log vuelca cuerpos/DTO/`payer_name`/`legal_name`; ningún literal de 15–19 dígitos; pay-payments sin campos de tarjeta/CVV/titular; el SQL de pay-vault sin columnas de PAN/CVV/titular; la telemetría sin captura de valores; **`payer_name` y `legal_name` solo en los 8 archivos que los usan por diseño (D-29/D-33)** y nunca en el log de acceso, el filtro de errores, los serializadores ni los eventos; la ruta se enmascara en los tres lugares.
- *Etapa dinámica* (canarios; 40 pruebas en pay-payments y 44 en pay-vault, verdes):
  - `sensitive-data.spec.ts` (pay-payments): canarios `payer_name` y `legal_name` más un PAN, por un cobro exitoso, uno denegado por riesgo, riesgo caído (fail-closed), entradas inválidas y campos no declarados; se busca en **logs** (stdout/stderr), **respuestas** (también las de error), **eventos del outbox**, **las llamadas a pay-connectors y pay-ledger**, y **todas las filas de todas las tablas**. Resultado: 0 apariciones fuera de los dos lugares declarados (`merchant_replica.legal_name` y `payment_intents.payer_name` mientras el intento no es terminal; tras el terminal, 0 filas con nombre). Controles positivos: riesgo SÍ recibe los dos nombres (a propósito, D-29) y el detector grita sobre material con un canario.
  - `pan-leak.spec.ts` (ambos): PAN en cada campo posible ⇒ 422/404 sin repetirlo; ni tablas, ni outbox, ni logs, ni respuestas, ni llamadas a conectores (pay-payments); en pay-vault, ni tablas, ni logs ni respuestas fuera de `reveal` (CVV buscado como token).
  - `path-sensitive.spec.ts` (ambos, servicio real `dist/main.js`): **PAN, NIT y CI (con o sin complemento) en la ruta** no llegan al log de acceso, a `instance` ni a los spans que salen por OTLP (se levanta un colector y se busca en los bytes crudos).
- *Trazas reales:* spans de ambos servicios leídos desde **Jaeger** (`evidencia/3c-jaeger-trazas.txt`): `url.path`, `url.full`, `http.route` con `/payment_intents/:x` o `/tokens/:x`, `url.query = [redacted]`, y 0 apariciones del NIT, del PAN ni de la CI sintéticos. (La captura es anterior al último ajuste de `safeUrl`, que ahora conserva la plantilla de Express `:id` en `http.route`; ese ajuste lo cubre `path-sensitive.spec.ts` y la repetición de esta consulta contra Jaeger quedó pendiente.)

**Lo que la prueba descubrió y se corrigió:**
1. La **`url.query` de los spans** salía en claro (`documento=1023456028`): el exportador enmascaraba el path pero no la query, que la instrumentación http guarda en un atributo aparte (`evidencia/3c-spans-query-FALLA-PREVIA.txt`). Ahora `MaskingTraceExporter` la reemplaza por `[redacted]`.
2. `instance` y el log de acceso solo enmascaraban PAN con Luhn: un NIT o una CI en la URL se repetían. Ahora `safeUrl` (`src/log-safe.ts`) deja solo palabras de ruta e ids propios con prefijo conocido y al menos una letra; todo lo demás es `:x`.

**GAP menores (declarados, sin tocar):**
- Un segmento en minúsculas y sin dígitos (por ejemplo un nombre escrito como `juanperez` en la URL) pasa tal cual por `safeUrl`: el límite está documentado en el archivo.
- El **logger de Temporal** registra el error completo (`message` y pila) de una actividad que falla (`Activity failed { error: Error: Connection terminated unexpectedly … }`). Los errores de nuestras actividades no traen datos de personas, pero un mensaje de `pg` podría traer un valor de columna en `detail`. Propuesta P3-21.
- La `Idempotency-Key` se guarda 24 h (`@pay/idempotency`, P1): pay-payments y pay-vault rechazan una clave con forma de PAN antes de guardarla (`idempotencyKeyOf`, `keyOf`), pero el resto del texto de la clave se guarda tal cual.

## 8 · PCI — PASS

`docs/cumplimiento/pci-alcance.md` §3 «Clasificación por servicio»:

- línea 28: «| `pay-vault` | P3 | **CDE** | Guarda el PAN (tokeniza) y es el único que lo entrega (`reveal`). | `internal-vault-v1.yaml`; spike `docs/spikes/card-vault.md` (solo documental) |»
- línea 30: «| `pay-payments` | P3 | **Conectado al CDE / impacta la seguridad** | Nunca recibe el PAN (opera con `card_token`), pero abre sesiones de captura y es uno de los dos servicios con acceso a la red del CDE. | `internal-vault-v1.yaml` («`pay-payments` jamás recibe un número de tarjeta») |»

Respaldo de P3 a esa clasificación (gate 7): la API pública no tiene campo de tarjeta, un PAN en cualquier campo es 422 sin repetirse, el SQL de pay-vault no tiene columna de PAN/CVV/titular y el PAN solo sale por `reveal`, que solo llama pay-connectors. **Abierto y no es de P3:** el spike de la bóveda real (P3.H3.M1), la red aislada (P1.H4.M3) y la validación de un QSA.

## 9 · Deriva de esquema — PASS

Fuente de verdad (el `ddl.sql` del modelo, `af60b79`, vendorizado) ↔ base aplicada ↔ mapa del código (`schema-map.ts`; no hay ORM). `test/schema.drift.spec.ts` (pay-payments 7 pruebas, pay-vault 5) comprueba tabla ausente, columna ausente, columna obligatoria no mapeada, nulabilidad y tipo divergentes, tablas sin mapear, índices con nombre autogenerado y que todo `INSERT` del código cubre las columnas obligatorias. Va dentro de las suites completas del gate 1.

- `yarn sql:check` en cada servicio: `OK: sql/ddl.sql idéntico a …/SQL/pay/74_pay_payments/ddl.sql` y `…/79_pay_vault/ddl.sql` (`evidencia/3c-gates.txt`; sin el repo hermano: `SKIP` y exit 0, `3b-pay-payments-sql-check-sin-modelo.txt`).
- **ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18).**

## 10 · Observabilidad (traza OTel de E1 en Jaeger) — NO APLICA AÚN

Motivo: la traza de E1 de punta a punta exige el stack completo (P1/P3/P4/P2) corriendo con el endpoint OTLP. Lo que SÍ se verificó con Jaeger real: ambos servicios exportan spans (96 por servicio en la consulta, `evidencia/3c-jaeger-trazas.txt`), con el nombre de servicio `pay-payments`/`pay-vault`, rutas y query enmascaradas. No se verificó propagación de contexto entre servicios ni que el span de Temporal cuelgue de la petición.

## 11 · Fallos — PASS, con GAP

**a) Worker de Temporal matado en cada actividad (tanda 2g, vigente):** SIGKILL real con la orden en vuelo en `createCharge`, `resolveExpiry`, `holdRefund`, `finishRefund` y el asiento; señales duplicadas y reordenadas; tabla de 15 escenarios de dependencias. Un solo estado terminal en todos los casos: [`2g-kill-worker.md`](../../ola-2/P3/evidencia/2g-kill-worker.md), [`2g-fallos-p3.md`](../../ola-2/P3/evidencia/2g-fallos-p3.md). Regla 11 (resultado ambiguo no es fallo) probada en cada fila «ambiguo».

**b) Postgres corta la conexión (nuevo en 3c).** Defecto transversal hallado por P5/P4: un `pg.Pool` sin manejadores de `error` mata el proceso cuando Postgres corta una conexión. Corrección: `src/pool-guard.ts` (`guardPool`, copia de la de pay-connectors: `pool.on('error')` + `client.on('error')` en cada conexión nueva) y `src/pg-pool.ts` (`createPgPool`), único lugar donde nace un pool; también el del worker de Temporal. Los clientes que prestan `@pay/idempotency` y `@pay/outbox` salen de ese mismo pool. El aviso lleva solo el NOMBRE del error. Pruebas en tres niveles en cada servicio (`pg-pool.error.spec.ts`, proceso aparte con `pg_terminate_backend`):

| Nivel | Qué se corta | Observado |
|---|---|---|
| correcto | una conexión OCIOSA | proceso vivo, el pool repone, la siguiente consulta responde |
| límite | TODAS las ociosas (el pool llegó a 4) | proceso vivo, cuatro consultas simultáneas abren cuatro nuevas |
| límite | una conexión PRESTADA, en una transacción abierta entre dos sentencias | proceso vivo; la sentencia siguiente de esa transacción rechaza; el pool sirve consultas nuevas |
| inválido | en medio de una consulta (pool) y en medio de una sentencia dentro de una transacción | esa consulta rechaza con el error de `pg` (`57P01`); proceso vivo |
| log | cualquier corte | `PgPool` + nombre del error; ni mensaje de Postgres, ni SQL, ni SQLSTATE, ni cadena de conexión |
| **control negativo** | `new Pool` pelado / solo `pool.on('error')` | **el proceso MUERE** (la prueba detecta el defecto; el segundo prueba que la corrección del coordinador era necesaria) |

Servicio real: `dist/main.js` con todas sus conexiones ociosas cortadas sigue vivo y `/health/ready` vuelve a 200 (y **sin** el manejador muere: `evidencia/3c-pg-pool-control-negativo-sin-manejador.txt`).

Corte a mitad de una transacción de NEGOCIO, con el servicio real (`pg-pool.tx-cut.spec.ts`; el trigger de la prueba retrasa la escritura 6 s para cortar justo ahí):

| Operación | Observado |
|---|---|
| pay-payments · crear el intento | `500 internal_error` problem+json sin mensaje ni SQL; **nada a medias** (ni fila ni evento); reintentar con la MISMA clave ⇒ `201`, UN intento, UN `payment_intent.created`; repetirla ⇒ el mismo id |
| pay-payments · cerrar el cobro (`UPDATE … status = 'succeeded'`) | la actividad de Temporal falla y se reintenta; el intento termina `succeeded` UNA vez, **un asiento**, **un evento terminal**, 0 contradicciones (ambiguo no es fallo) |
| pay-vault · abrir una sesión de captura | `500 internal_error` sin mensaje; nada a medias; reintentar con la misma clave ⇒ `201`, UNA sesión |

Sin el guardia, el worker de Jest muere al cortar una conexión prestada (`Test suite failed to run — Unhandled error. (Error: Connection terminated unexpectedly`, `evidencia/3c-pg-pool-tx-control-negativo-sin-guard.txt`).

**GAP:** no se bajó Postgres ni NATS completos (la infraestructura es compartida con otros carriles); el corte de conexiones es el fallo de Postgres que sí se pudo inyectar sin afectarlos. Dueño: P1 (entorno de fallos aislado). El `crash` de `completeIntent` tras el commit sigue siendo simulado en proceso (un commit de una sola sentencia no tiene ventana para un SIGKILL, ver 2g).

## 12 · Carga (objetivo de T-01) — NO APLICA AÚN

Motivo: T-01 todavía no tiene un valor acordado ni un entorno de carga; medir «su parte» sin objetivo sería inventar una meta. Lo medible hoy sin inventar: las concurrencias del gate 4 (50 y 10 peticiones simultáneas con efecto único) y las 1000 peticiones del escenario de mandato bajo CPU saturada (0 errores tras el arreglo). **Qué lo destraba:** el valor de T-01 (dueño del producto) y un entorno de carga (P1).

## 13 · Sandbox (ola 4) — NO APLICA AÚN

Motivo: «sus flujos E2E pasan contra `pay-mockbank` y los tests de contrato del conector son idénticos para el simulador y el real» es del cierre de la ola 4. Hoy `pay-payments` se prueba contra un doble de conectores que valida `internal-connectors-v1.yaml`.

## + · Dockerfile (docker build de la imagen de producción) — PASS tras 3 correcciones

`docker build -f services/<svc>/Dockerfile --build-arg HUB=localhub -t <svc>-gate:p3 .` (contexto = raíz del repo, ya con `.dockerignore`). **No se subió ninguna imagen a ningún registro.** Salidas: [`3c-docker-build-pay-payments.txt`](./evidencia/3c-docker-build-pay-payments.txt), [`3c-docker-build-pay-vault.txt`](./evidencia/3c-docker-build-pay-vault.txt).

**Antes del cambio el build fallaba** (misma plantilla que los otros servicios) y se corrigió igual que `services/pay-ledger/Dockerfile`:
1. `yarn workspaces foreach -A … --from X` ⇒ inválido en Yarn 4.14.1. Ahora `-R … --from X`.
2. `yarn install --immutable` fallaba porque `yarn.lock` lista los 12 workspaces. Ahora `COPY services ./services` y, tras compilar, `find services … ! -name <svc> -exec rm -rf {} +`.
3. **Solo pay-payments — hallazgo nuevo:** con la base `node:22-alpine` la imagen construía bien y **no arrancaba**: `Error loading shared library ld-linux-x86-64.so.2 … @temporalio/core-bridge/releases/x86_64-unknown-linux-gnu/index.node`. El puente nativo de Temporal solo se distribuye para glibc. Corregido: `node:22-bookworm-slim` en las dos etapas (con un comentario que lo explica). pay-vault no usa Temporal y sigue en alpine.

Resultado: ambos builds `rc=0`. Arranque (`--network host`, rol `pay_<svc>` de su base, `PAY_MODE=sandbox`): `/health/live` ok, `/health/ready` `database: up`, proceso como usuario `node` (uid 1000, no root), la imagen lleva **solo** `/repo/services/pay-<svc>` (`evidencia/3c-docker-humo-pay-payments.txt`, `…-vault.txt`; pay-payments con el worker de Temporal embebido). El relé del outbox registra `42P01` porque la base de desarrollo `pay_<svc>` no tiene el esquema aplicado: aplicar el `ddl.sql` al arrancar es el contenedor de init de P1 (INTEGRACION.md §3).

**Nota de entorno del build:** la salida a internet pasa por un proxy que re-firma TLS, así que el build usó una imagen base local con la CA del proxy (`HUB=localhub`: `node:22-alpine` y `node:22-bookworm-slim` más `NODE_EXTRA_CA_CERTS`); no es parte del servicio y no se versionó. **Limpieza (`evidencia/3c-docker-limpieza.txt`):** imágenes `*-gate`, bases `localhub`, contenedores de humo y la caché de build borrados (`docker image rm`, `docker builder prune -f`); sin imágenes ni contenedores míos. **Incidente:** durante el build de pay-vault el disco compartido llegó al 98 % (dos builds seguidos con la caché del primero sin podar); se podó enseguida (74 % al final). Lección aplicada: un build por vez y `image rm` + `builder prune` después de cada uno.

**GAPs (de P1, ya propuestos por P2):** la imagen final lleva `devDependencies` y todo el `node_modules` (propuesta 21 de P2); la plantilla `platform/templates/service/Dockerfile` y los demás Dockerfiles que usen Temporal (o cualquier módulo nativo solo glibc) deben revisar la base alpine.

---

## Entorno y corridas descartadas (regla 80.4)

| Síntoma | Clase | Evidencia | Qué se hizo |
|---|---|---|---|
| `internal.api.spec` falló una vez en una corrida completa (2h) | **PRODUCT_BUG** | `code: '23505'` en el log; rojo determinista en `intents.insert.race.spec.ts`; 2/100 rondas antes y 0/100 después | arreglo del `INSERT` (gate 4) |
| `kill.spec` falló en 2g (conflicto de reembolso) | TEST_BUG | la prueba leía la contradicción antes de que el workflow la escalara | `waitFor` por condición, misma aserción |
| Build de pay-vault: `no space left on device` (disco compartido al 98 %) | ENVIRONMENT | `3c-docker-build-pay-vault.txt` de la primera corrida (sobrescrita); `3c-docker-limpieza.txt` | poda de imágenes y caché, reintento exitoso |
| `yarn lint` de la raíz dio exit 1 en 3b por dos errores de otros carriles (`pay-ledger`, `pay-mockbank`) | EXTERNAL (otro carril) | `3b-eslint-raiz.txt` | en 3c dio exit 0 (los arreglaron) |

No hay `skip`, ningún timeout subido y ningún reintento agregado. **La corrida 2 de `pay-payments` (3c) no se ejecutó**: durante la redacción de esta matriz el coordinador pidió la máquina quieta para probar el sistema completo; los procesos propios se cerraron (verificado por `/proc`, sin jest, sin `dist/main.js`, sin contenedores) y no se lanzó ninguna suite más.

## No cubierto (consolidado)

- Segunda corrida de la suite completa de `pay-payments` sobre el código final de 3c, y repetir la consulta a Jaeger con el `safeUrl` final.
- Idempotencia en paralelo de `pay-vault` (gate 4).
- Stack E1–E8 completo, propagación de trazas entre servicios, banco real, carga T-01, sandbox: filas 10, 12 y 13.
- Clave de API revocada (P1/P5); `template1` (P1).
- Caída de Postgres y NATS completos; la bóveda real (P3.H3.M1) y su despliegue aislado (P3.H3.M2).
- Aplicación del `ddl.sql` como rol dueño en una base real al arrancar el contenedor (P1).
