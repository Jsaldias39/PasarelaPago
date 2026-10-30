> **AVANCE (matriz de gates): 9 / 13 gates de PLAN-MAESTRO §7 en PASS (4 de ellos con un GAP declarado y con dueño) · 1 GAP · 3 `NO APLICA AÚN`** — más las filas extra (Dockerfile PASS; hallazgos transversales de P5 PASS/GAP). Peldaño: **`TESTED`**; `E1/E2` y la capa sandbox corrieron con la máquina compartida y saturada, así que el cierre `REGRESSION_VERIFIED` queda para una corrida en máquina quieta (ver «Entorno»).

# Matriz de gates P1 — `pay-edge` y `pay-webhooks` (ola 3)

- Fecha: 2026-10-28 · Rama: `claude/adoring-allen-ly7r6f` · **Sin commit** (lo hace el coordinador).
- Fuente de los gates: [`docs/plan/PLAN-MAESTRO.md` §7](../../../plan/PLAN-MAESTRO.md). Cada fila es **PASS** (comando + salida literal en `evidencia/`), **GAP** (qué falta y de quién es) o **NO APLICA AÚN** (con el motivo). Formato igual al de [P2](../P2/GATES.md).
- Documentos de esta tanda: [`DOCKERFILE.md`](./DOCKERFILE.md) (causa y patrón), [`BIBLIOTECA-SEGURIDAD.md`](./BIBLIOTECA-SEGURIDAD.md) (núcleo compartido y adopción). Arnés y E1/E2: [`../../ola-2/P1/ARNES.md`](../../ola-2/P1/ARNES.md).
- Cómo se corrió: una suite jest a la vez, `--maxWorkers=2`; Postgres/NATS/Redis del Compose y, en el e2e, los 11 servicios reales con TigerBeetle propio. Evidencia nueva de esta tanda: [`evidencia/`](./evidencia/) (esta carpeta); la de la tanda 2h: `../../ola-2/P1/evidencia/2h-*`.

## Resumen

| # | Gate (§7) | Veredicto | Una línea |
|---|---|---|---|
| 1 | Typecheck, lint y unitarios | **PASS** | typecheck/build/lint raíz en 0; pay-edge 406/406 y pay-webhooks 411/411 ×2 |
| 2 | Integración contra base real | **PASS** | Postgres, Redis y NATS reales; dobles declarados solo para los dueños aguas abajo |
| 3 | Contrato | **PASS** con **GAP** de alcance | el humo valida contra el OpenAPI público cada operación contra el borde real (20/20); eventos contra AsyncAPI; los cuerpos de petición no se generan |
| 4 | Idempotencia en paralelo | **PASS** con **GAP** menor | alta de endpoint ×10 y entrega ×3 workers ⇒ un efecto; rotar/borrar en paralelo no probado |
| 5 | Autorización negativa | **PASS** | otro comercio, sin clave, clave **revocada ⇒ 401**, `test` contra `live`, suspendido 403 / cerrado 401 |
| 6 | Separación | **PASS** con **GAP** (aplicar `template1` en la instancia compartida) | rol propio por servicio; `REVOKE` de `template1` escrito y probado en un Postgres aparte |
| 7 | Datos sensibles | **PASS** con **GAP** menores | grep estático limpio; PAN en ruta/query/spans/clave/log: probado; E2E de spans reales sin hacer |
| 8 | PCI | **PASS** | `pci-alcance.md` líneas 31–32; línea 37 (`pay-schedules`) corregida |
| 9 | Deriva de esquema | **GAP** | mismas tablas que el modelo, pero sin vendorización ni `drift.spec` como P2 |
| 10 | Observabilidad (Jaeger) | **NO APLICA AÚN** | |
| 11 | Fallos | **PASS** | corte de Postgres (ocioso y prestado), receptor caído (E6), degradados |
| 12 | Carga (T-01) | **NO APLICA AÚN** | |
| 13 | Sandbox (ola 4) | **NO APLICA AÚN** (con adelanto) | `flows/sandbox-mockbank.e2e.ts` |
| + | Dockerfile (`docker build` de producción) | **PASS** | pay-edge y pay-webhooks construidos, arrancados y borrados; plantilla corregida |
| + | `pg.Pool` (ocioso **y** prestado) | **PASS** | `guardPool` compartido + prueba con `pg_terminate_backend` |
| + | Rutas/spans con PAN, NIT, CI | **PASS** | `safeUrl` y `maskSpanAttributes` compartidos, todos los atributos de OTel |
| + | `Idempotency-Key` con forma de PAN | **PASS** | se guarda y reenvía como `masked-<sha256>`; no se rechaza |
| + | E1/E2 | **PASS en la suite**, **intermitentes bajo carga** | ver ARNES.md § Estado de E1 y E2 |

---

## 1 · Typecheck, lint y unitarios — PASS

Salida literal: [`evidencia/3a-gates.txt`](./evidencia/3a-gates.txt).

```text
(cd contracts/packages/idempotency && yarn typecheck)   exit=0     (yarn build exit=0)
(cd services/pay-edge && yarn typecheck)                exit=0     (yarn build exit=0)
(cd services/pay-webhooks && yarn typecheck)            exit=0     (yarn build exit=0)
yarn e2e:typecheck                                      exit=0
yarn lint   (raíz, todo el repo)                        exit=0
yarn eslint de lo mío (idempotency, edge, webhooks, platform, e2e)   exit=0
yarn contracts:lint exit=0 · yarn contracts:events exit=0
```

| Paquete | Corrida | Suites | Pruebas |
|---|---|---|---|
| `@pay/idempotency` | 1 y 2 | 4/4 | **129/129** y **129/129** |
| `pay-edge` | 1 y 2 (`--maxWorkers=2`) | 15/15 | **406/406** y **406/406** |
| `pay-webhooks` | 1 y 2 (`--maxWorkers=2`) | 13/13 | **411/411** y **411/411** |

Pruebas **nuevas** de esta tanda: `pool-error.spec.ts` (edge, webhooks, plantilla), `telemetry.spec.ts` (ídem), `idempotency-key-pan.spec.ts` (edge, webhooks), ampliaciones de `log-safe.spec.ts`, y en la librería `card-number.spec.ts`, `url-mask.spec.ts`, `pool-guard.spec.ts`; e2e: `flows/pool-error.e2e.ts`, `flows/sandbox-mockbank.e2e.ts`.
**Intermitencia observada, sin causa demostrada:** `pay-webhooks` falló 1 prueba en 2 de ~17 corridas completas (la 1.ª: «CORRECTO: una clave legítima…» de mi propio spec, atribuible a una clave hexadecimal marcada como PAN **antes** de pasar a enmascarar en vez de rechazar; la 2.ª: `e6.spec` «sobre inválido», que pasa 4/4 en aislamiento y 5/5 en la suite entera). Sospecha ENVIRONMENT (NATS compartido con otros agentes); **no se pudo capturar el mensaje**. Ver «Riesgos».

## 2 · Integración contra base real — PASS

- `pay-edge`: arranque real contra su Postgres (rol `pay_edge`), su Redis y NATS reales (`replica.spec.ts` 14 casos D-32 con NATS, Postgres y Redis reales). Los dueños aguas abajo (pay-payments, pay-merchants…) son **dobles HTTP declarados** (`test/doubles/`); la integración con los servicios REALES la hace el e2e (humo 20/20 por el borde real, E1/E2, E6, claves).
- `pay-webhooks`: Postgres real (rol `pay_webhooks`), NATS JetStream real (`e6.spec.ts`), receptor HTTPS local; el motor de entrega propio es un **doble declarado de Svix** (ARNES.md).
- Sin ORM en ninguno de los dos (pg directo): no hay ORM que mockear.
- **No cubierto:** Svix real (no existe `SvixEngine`); dinero real y banco real.

## 3 · Contrato — PASS, con GAP de alcance

| Qué | Dónde | Qué prueba |
|---|---|---|
| **Test de consumidor generado desde el OpenAPI público, contra el borde REAL** | `e2e/lib/smoke.ts` (grupo `borde`) | cada operación de `public-v1.yaml` se invoca contra `pay-edge` con una `sk_test_` real y **su respuesta (estado y cuerpo) se valida contra el contrato** con `loadContract`; un estado o una forma no declarados ⇒ veredicto `CONTRATO_ROTO`. **20/20** (el humo corre dentro de `yarn e2e` — `flows/smoke.e2e.ts`, en verde en `evidencia/e2e-full-3a.txt` — y suelto con `node e2e/cli.ts smoke` ⇒ «borde: 20/20 OK», salida de consola no guardada en archivo) |
| Control negativo del instrumento | `e2e/lib/smoke.spec.ts` (3.º describe) | el validador acepta un `problem+json` declarado y rechaza una forma ajena, un estado no declarado y una operación inexistente |
| Cada respuesta HTTP de las pruebas del servicio contra el OpenAPI | `h.contract.assertResponse(...)` (`@pay/testing`) en `payer-name.spec`, `routes.spec`, `authz.spec`, `endpoints.spec`… | forma de respuestas, incluidos los `problem+json` |
| Eventos contra el AsyncAPI | `flows/e6.e2e.ts`, `flows/onboarding.e2e.ts`, `webhooks/test/payload-policy.spec` | el sobre y el payload que sale al bus o al comercio |
| Cada ruta de `routes.ts` ↔ contrato y viceversa | `pay-edge/test/routes.spec.ts`, `contract-mandate.spec.ts` | contrato ↔ implementación en los dos sentidos |
| `yarn contracts:lint` / `contracts:events` | raíz | exit 0 (`evidencia/3a-gates.txt`) |

**GAP (P1):** el generador **no arma cuerpos de petición válidos desde el esquema**: el humo manda `{}` o ids de relleno, así que las respuestas 2xx de la mayoría de las operaciones públicas se validan en las pruebas del servicio (`assertResponse`) y no en el recorrido real; y no hay un *generador de clientes*. Qué lo cierra: derivar un cuerpo mínimo válido de cada `requestBody` (ejemplo o esquema) en `smoke.ts` y exigir 2xx donde el flujo lo permita. Dueño: P1.

## 4 · Idempotencia en paralelo — PASS, con GAP menor

`pay-edge` **no guarda claves**: las reenvía (ya enmascaradas si parecen PAN) y la idempotencia ocurre en el dueño; sus mutaciones propias son ninguna. `pay-webhooks` sí:

| Mutación | Misma clave ×N | Prueba |
|---|---|---|
| `POST /webhook_endpoints` | **10 simultáneas ⇒ UN endpoint**, ninguna escribe dos veces | `endpoints.spec.ts:113` |
| Entrega (worker) | 3 `runOnce()` a la vez ⇒ una sola entrega por evento (`SELECT … FOR UPDATE SKIP LOCKED`) | `delivery.spec.ts:365` |
| Evento de entrada duplicado (inbox) | el mismo evento ×N ⇒ un procesado | `e6.spec.ts` («duplicados») |
| Clave con forma de PAN | la repetición con la MISMA clave devuelve el MISMO endpoint | `idempotency-key-pan.spec.ts` (webhooks) |

**GAP menor (P1):** `POST /webhook_endpoints/{id}/rotate_secret` y `DELETE /webhook_endpoints/{id}` no tienen prueba **en paralelo** (sí secuencial: `endpoints.spec`). Dueño: P1; agregar dos casos con `Promise.all` de 10.

## 5 · Autorización negativa — PASS

La autoridad es la API (CLAUDE.md): la UI no cuenta. Matriz (todo contra el borde con Postgres/Redis reales y dueños doblados; lo de claves, además contra procesos reales):

| Caso del gate | Resultado | Prueba |
|---|---|---|
| **Otro comercio** (IDOR/BOLA) | el recurso de otro comercio da **404 `resource_not_found`** (no 403: no confirma que existe) y el dueño lo ve; vale para intents y reembolsos; `?merchant_id=` ⇒ 422 y no llega al dueño; no se usa la clave de otro aunque se conozca el `key_id` | `authz.spec.ts:138, 154, 198, 205` |
| **Sin clave** | 401 con `WWW-Authenticate`, `problem+json` válido contra el contrato y nada llega a los dueños; clave desconocida y secreto equivocado dan la MISMA respuesta (no se filtra qué claves existen) | `authz.spec.ts:26, 60` |
| **Clave revocada ⇒ 401** | `revoked_at` vencido ⇒ 401 igual que una desconocida; una revocación FUTURA todavía sirve; una clave sin hash replicado solo con la revocación NO autentica | `authz.spec.ts:74, 83` |
| **Clave revocada, con procesos reales** | `merchant.closed` ⇒ 401 indistinguible de una clave inexistente en < 5 s; suspendido ⇒ 403 `merchant_suspended` y reactivar restaura; si solo llega `merchant.closed` (sin la revocación por clave) la clave deja de servir; cerrado es terminal; no toca claves de otro comercio | `e2e/flows/key-lifecycle.e2e.ts` (6 casos; en verde en `evidencia/e2e-full-3a.txt`, `Test Suites: … 14 passed`) |
| **`test` contra `live`** (D-28) | reescribir el prefijo `sk_test_`→`sk_live_` ⇒ 401; clave live en borde sandbox ⇒ 401; el borde live rechaza claves test; el `X-Pay-Mode` reenviado es EXACTAMENTE el modo del registro de la clave; las cabeceras `X-Merchant-Id`/`X-Service-Id`/`X-Pay-Mode` del cliente no llegan | `authz.spec.ts:89, 97, 167, 187, 220` |
| **Abuso** | 429 + `Retry-After` por fallos, por clave y por IP; un cuerpo enorme sin autenticar se rechaza sin leerlo | `authz.spec.ts:236–288`, `rate-limiter.spec.ts` |
| **`pay-webhooks` (interno)** | sin `X-Service-Id` válido ⇒ 403; sin `X-Merchant-Id` ⇒ 401; el endpoint de otro comercio ⇒ 404; destinos peligrosos ⇒ 422 (SSRF: `169.254.169.254`, loopback, privados, mixtos) | `endpoints.spec.ts` (matriz de autorización negativa), `ssrf.spec.ts` |

P2 marcó la «clave revocada ⇒ 401» como GAP de P1: **queda cerrada** con las filas 3 y 4 (unitario + procesos reales).

## 6 · Separación — PASS, con GAP (aplicar `template1` en la instancia compartida)

- Cada servicio corre con SU rol y SU base: `pay-edge` (`pay_edge`/`dev_only_edge`) y `pay-webhooks` (`pay_webhooks`/`dev_only_webhooks`) en `test/env.ts`, en el arnés (`lib/services.ts`) y **dentro de sus contenedores** (`evidencia/docker-imagen-pay-edge.txt`, `…-pay-webhooks.txt`: `/health/ready` `database: up` con ese rol).
- `platform/scripts/check-db-separation.sh` (12 roles × 14 bases): **168 comprobaciones correctas, 0 fallas** sobre la instancia compartida (salida de P2: `../P2/evidencia/3a-separacion-psql.txt`).
- **`template1` (gap de P2/P1) — escrito y probado:** `platform/postgres/init-databases.sh` ahora hace `REVOKE ALL ON DATABASE template1 FROM PUBLIC` y, por rol, `REVOKE ALL ON DATABASE template1 FROM pay_<svc>`; `check-db-separation.sh` suma la comprobación con `CHECK_TEMPLATE1=1`. Prueba contra un **Postgres aparte** (`:54399`, contenedor borrado), salida literal en [`evidencia/template1-revoke.txt`](./evidencia/template1-revoke.txt):

```text
A. init ANTERIOR:  psql -U pay_ledger -d template1  ⇒ «ENTRÓ a template1 como pay_ledger»;  CHECK_TEMPLATE1=1 ⇒ «separación: 168 comprobaciones correctas, 12 fallas»
B. init NUEVO:     psql -U pay_ledger -d template1  ⇒ «FATAL: permission denied for database "template1" … User does not have CONNECT privilege.»
                   CHECK_TEMPLATE1=1 ⇒ «separación: 180 comprobaciones correctas, 0 fallas»;  el superusuario sigue creando y borrando bases (CREATE DATABASE / DROP DATABASE)
```

**GAP (coordinador / P1):** el Postgres **compartido** del Compose se creó antes del cambio (`init-databases.sh` solo corre al inicializar el volumen) y **no se tocó** (no se reinició ni se aplicó el `REVOKE` a mano: la regla 97.1.3 prohíbe el DDL suelto y, además, la prueba `it.failing` de P2 en `separation.spec` falla cuando el hueco se cierra). Para aplicarlo: recrear el volumen (`docker compose -f platform/compose.yml down -v && up -d`) cuando nadie esté corriendo, o ejecutar el mismo `REVOKE` una sola vez y actualizar el `it.failing` de P2 en el mismo cambio.

## 7 · Datos sensibles — PASS, con GAP menores

- **Estático** (grep sobre `src/` de edge, webhooks, plantilla y núcleo): sin `console.*`, sin literal de PAN (la única coincidencia es un comentario con el PAN de prueba), sin captura de valores en telemetría, sin `logger` con cuerpos/cabeceras/payload (los 2 resultados de webhooks registran ids, tipo y razón). [`evidencia/datos-sensibles-estatico.txt`](./evidencia/datos-sensibles-estatico.txt).
- **Dinámico:** PAN/NIT/CI en la ruta, la query, `instance`, spans y la `Idempotency-Key`; el PAN no se repite en respuestas ni logs:

| Superficie | Prueba |
|---|---|
| Cuerpo con PAN no atraviesa el borde (422 `card_number_detected`), sin repetirlo ni registrarlo; el núcleo detecta separadores raros, otras escrituras, caracteres invisibles, 13/19 exactos | `pan-guard.spec.ts` (con el núcleo compartido), `card-number.spec.ts` |
| `payer_name` (D-29/D-33) nunca en respuestas ni logs (nivel de log `trace`) | `payer-name.spec.ts` (11) |
| Ruta/`instance`/log de acceso | `log-safe.spec.ts`, `url-mask.spec.ts` (≈ 50 casos: PAN, NIT, CI, prefijos, separadores, 100 KB) |
| **Spans**: TODOS los atributos `url.*`/`http.*` de OTel, ruta y query, con PAN/NIT/CI | `url-mask.spec.ts` («recorre TODOS los atributos…»), `telemetry.spec.ts` (edge, webhooks, plantilla) |
| `Idempotency-Key` con forma de PAN: se guarda como `masked-<sha256>`; el edge la reenvía ya enmascarada; ni un dígito del PAN en la base, cabeceras, respuesta ni logs | `card-number.spec.ts` (almacén, Postgres real), `idempotency-key-pan.spec.ts` (edge y webhooks) |
| Webhooks: política de payload «solo ids, estados e importes» (un evento con tarjeta/correo/teléfono se rechaza) | `payload-policy.spec.ts` |

**GAP menores:** (1) los spans se prueban **en el exportador**, no inspeccionando los que llegan a Jaeger (gate 10); P4/P3 tienen un `sensitive-data-scan.mjs` que lee lo exportado y no se adoptó acá. (2) `pay-webhooks/src/events/payload-policy.ts` tiene su **propia** detección de tarjeta (no usa `containsCardNumber`); consolidar es mecánico (BIBLIOTECA-SEGURIDAD.md). (3) Costo del núcleo: ≈ 1 de cada 500 claves hexadecimales de 32 caracteres se marca como PAN (por eso la clave se **enmascara**, no se rechaza); un cuerpo con un identificador así sigue siendo rechazado por el pan-guard del borde (costo ya documentado en `pci-alcance.md`).

## 8 · PCI — PASS

`docs/cumplimiento/pci-alcance.md` §3 «Clasificación por servicio» (dueño: P1):

- línea 31: `pay-edge` — **Fuera de alcance, con controles que lo sostienen** (sin campo de tarjeta en la API; pan-guard antes de reenviar; sin ruta de red a `pay-vault`, a demostrar en P1.H4.M3).
- línea 32: `pay-webhooks` — **Fuera de alcance** (payload «solo ids, estados e importes»; sin acceso al CDE).
- **Corregida en esta tanda (pedido de P5):** línea 37, `pay-schedules`: decía que su medio de pago era un `card_token`; **no tiene medio de tarjeta** (ni en `merchants-schedules.yaml` ni en `services/pay-schedules/src`; búsqueda de `card_token`, `payment_method`, `cardToken` sin resultados; opera con holds y asientos en `pay-ledger`). Sigue fuera de alcance.
- **Abierto (no es de código):** el aislamiento de red de `pay-vault` (P1.H4.M3, ola 3 de plataforma) y la validación de un QSA.

## 9 · Deriva de esquema — GAP

Fuente de verdad (D-18): el modelo (`mantra-core-health-model` `SQL/pay/71_pay_edge/ddl.sql` y `80_pay_webhooks/ddl.sql`). P1 **no** vendoriza ese DDL ni tiene `drift.spec`: los servicios aplican `sql/001_edge.sql` / `001_webhooks.sql` escritos a mano (los usa el arnés y las pruebas). Comprobación hecha (solo tablas, [`evidencia/deriva-tablas.txt`](./evidencia/deriva-tablas.txt)): **mismas tablas** que el modelo (`api_key_replica`, `inbox_events`, `merchant_replica`; y `inbox_events`, `webhook_deliveries`, `webhook_delivery_attempts`, `webhook_endpoints`, `webhook_secrets`, más `idempotency_keys` que sale de `@pay/idempotency/sql`). **No** se comparó columna por columna, nulabilidad ni índices.
**Qué lo cierra (P1):** ampliar `scripts/vendor-model-sql.sh` (hoy `ledger=72`, `settlement=78`) a 71 y 80, reemplazar los `001_*.sql` por `ddl.sql` y portar `drift.spec.ts` de P2 con un `schema-map.ts` de edge y webhooks. No se hizo en esta tanda por alcance (las dos tareas pedidas por el coordinador y los hallazgos de P5 ocuparon la tanda).

## 10 · Observabilidad (traza OTel de E1 en Jaeger) — NO APLICA AÚN

Motivo: la traza de E1 de punta a punta exige correr el stack con `OTEL_EXPORTER_OTLP_ENDPOINT` apuntando a Jaeger (healthy en el Compose) e inspeccionar spans reales, y esta tanda se hizo con la máquina saturada y luego con la máquina reservada por el coordinador. Lo que sí existe: `telemetry.ts` en edge, webhooks y plantilla con instrumentación http/express/nest/pg, **solo activa** con el endpoint, ahora con enmascarado de spans compartido y probado; el borde continúa o abre `traceparent` (`edge.pipeline.ts`, probado en `proxy.spec.ts`). Se activa con E1 (ola 3).

## 11 · Fallos — PASS

| Experimento | Observado | Prueba |
|---|---|---|
| **Postgres corta una conexión OCIOSA** (`pg_terminate_backend`), una o todas a la vez | sin `uncaughtException`, el pool se repone, la siguiente consulta funciona, al log solo el nombre del error | `pool-error.spec.ts` (edge, webhooks, plantilla), `evidencia/3a-gates.txt` |
| **Postgres corta una conexión PRESTADA** en medio de una transacción | el proceso no muere; quien la usaba recibe el rechazo (corrección del coordinador: `pool.on('error')` NO alcanza) | ídem; **control negativo en proceso real** en `pool-guard.spec.ts` (sin `guardPool` el proceso muere; con él termina bien) y `evidencia/pool-error-control-negativo.txt` |
| **Procesos reales** (`node dist/main.js`): se cortan TODAS las sesiones de pay-edge y pay-webhooks | mismo PID, `/health/ready` 200 de nuevo (la versión previa del `dist` murió: «último valor: 0») | `e2e/flows/pool-error.e2e.ts` (2 casos, en verde en `evidencia/e2e-full-3a.txt`) |
| **Receptor del comercio caído** y endpoints que responden 410 (E6) | 8 eventos entregados **exactamente una vez** tras los reintentos (21 llegadas), 410 ⇒ `disabled gone_410`, sin 3.er intento | `flows/e6.e2e.ts`, `webhooks/test/e6.spec.ts`, `delivery.spec.ts` |
| **Dependencias degradadas / `PAY_MODE` / live-guard** | arranques sin una dependencia, con `PAY_MODE` ausente o en `live` con dobles: se niegan o quedan degradados con motivo | `flows/degraded.e2e.ts`, `pay-mode-required.e2e.ts`, `live-guard.e2e.ts` |
| **Sin NATS** | pay-edge responde `/health/ready` 200 con `replica.subscribed:false` y no se tumba | `health.spec.ts` (edge) y `evidencia/docker-imagen-pay-edge.txt` (NATS a un puerto muerto) |

**Límite honesto:** el cierre de una conexión del pool de **MikroORM** (plantilla) no se prueba por separado; ver BIBLIOTECA-SEGURIDAD.md.

## 12 · Carga (objetivo de T-01) — NO APLICA AÚN

Motivo: T-01 no tiene valor acordado ni entorno de carga; medir «su parte» sería inventar la meta. Medible hoy sin inventar: `rate-limiter.spec.ts` (100 peticiones simultáneas contra el límite) y el humo. **Qué lo destraba:** el valor de T-01 (dueño del producto) y un entorno de carga (P1).

## 13 · Sandbox (ola 4) — NO APLICA AÚN, con adelanto

El cierre es de la ola 4. Adelanto: `e2e/flows/sandbox-mockbank.e2e.ts` (4 pruebas) levanta `pay-mockbank` como servicio 12 y un cobro de Bs 100,00 termina `succeeded` con 97,00/3,00 en el ledger real; `…01` falla sin asientos, `…03` deja un asiento. **4/4 en dos corridas de la tanda 2h** (`../../ola-2/P1/evidencia/2h-mockbank-run1.txt`, `2h-e2e-full-run4.txt`) y **2 de 4 fallaron** en la última corrida con la máquina saturada: [`evidencia/e2e-full-3a-clasificacion.txt`](./evidencia/e2e-full-3a-clasificacion.txt) (`pay-ledger: timeout` y luego `circuit_open`; ENVIRONMENT). Falta la paridad “mismos tests de contrato para el simulador y el real”: depende de P4 y de credenciales (Q-01).

## + · Dockerfile (`docker build` de producción) — PASS

Detalle, causa y patrón para los demás carriles: [`DOCKERFILE.md`](./DOCKERFILE.md). Resumen: `-A … --from` ⇒ `-R … --from`; copiar todos los servicios para que el árbol coincida con `yarn.lock` y borrar los demás tras compilar; `.dockerignore` (contexto de 2 GB a 3,5 MB). `docker build` de `pay-edge` y `pay-webhooks`: **exit 0** ([`evidencia/dockerbuild-pay-edge.txt`](./evidencia/dockerbuild-pay-edge.txt), [`…pay-webhooks.txt`](./evidencia/dockerbuild-pay-webhooks.txt)); ambos arrancan como usuario `node` y responden `/health/ready` 200 con `database: up` ([`docker-imagen-pay-edge.txt`](./evidencia/docker-imagen-pay-edge.txt), [`…webhooks`](./evidencia/docker-imagen-pay-webhooks.txt)); imágenes borradas ([`docker-limpieza.txt`](./evidencia/docker-limpieza.txt)). Ninguna se subió a un registro.

## + · Hallazgos transversales de P5 (ola 3)

| Hallazgo | Veredicto | Qué se hizo / dónde |
|---|---|---|
| `pg.Pool` sin manejador tumba el proceso (ocioso **y** prestado) | **PASS** | `guardPool` en `@pay/idempotency`, usado por edge, webhooks y plantilla; pruebas con `pg_terminate_backend` y control negativo |
| Segmentos de ruta con forma de PAN/NIT/CI llegan a logs, `instance`, spans | **PASS** | `safeUrl` y `maskSpanAttributes` compartidos; lista única de atributos (`url.path/full/original/query`, `http.target/url/route/path/query`…) probada atributo por atributo |
| Gate Contrato «tests de consumidor desde OpenAPI/AsyncAPI» | **PASS con GAP** | gate 3 |
| `pci-alcance.md` L37 (`pay-schedules` con `card_token`) | **PASS** | corregida (gate 8) |
| `idempotency_keys` guarda en claro una clave con forma de PAN | **PASS** | `safeIdempotencyKey`: `masked-<sha256>`; ni rechazo ni PAN guardado |
| Revisión de seguridad automática (MEDIUM): lista de atributos de URL desigual entre servicios | **PASS en P1**; adopción de los demás pendiente | BIBLIOTECA-SEGURIDAD.md § «Quién ya lo usa» |
| Revisión de seguridad automática (MEDIUM): separadores `+ : ; | , * # ~` esquivan Luhn | **PASS** | el núcleo trata todo carácter no alfanumérico como separador; 28 separadores probados |

## Entorno y riesgos

- **Máquina compartida y saturada** (load average 10 a 18 en 4 núcleos con suites de otros agentes) durante casi toda la tanda; luego el coordinador la reservó. Efectos medidos: E1/E2 intermitentes sin ajustes (ARNES.md § Estado de E1 y E2), y 2 de 4 pruebas de la capa sandbox en la última corrida. Disco al límite varias veces (`ENOSPC`: el arnés ahora se niega con un mensaje claro por debajo de 1,8 GiB libres).
- **Pendiente de una corrida en máquina quieta** (el coordinador pidió no lanzar suites): `yarn e2e` completo ×2 y la repetición de E1/E2. Últimas salidas literales: `evidencia/e2e-full-3a.txt` (`Test Suites: 1 failed, 14 passed, 15 total · Tests: 2 failed, 81 passed, 83 total`; la suite que falla es la capa sandbox, por `pay-ledger: timeout`) y, antes, `../../ola-2/P1/evidencia/2h-e2e-full-run4.txt` (`14 passed · 80 passed`).
- **No se tocó** el Postgres compartido, ni el Compose en marcha; `docker builder prune -f` borró caché de build ajena (solo caché).
- **No cubierto:** Jaeger/trazas reales; carga; Svix real; pool interno de MikroORM por separado; deriva columna por columna de edge/webhooks; adopción por los otros 10 servicios.
