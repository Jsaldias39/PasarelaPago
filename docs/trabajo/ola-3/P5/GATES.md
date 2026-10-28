# Matriz de gates (PLAN-MAESTRO §7) — pay-merchants, pay-risk, pay-schedules

> **Peldaño:** `TESTED` para lo marcado PASS (Postgres, NATS y Watchman REALES del Compose; libro mayor, operadores y almacén de objetos son dobles declarados). Nada aquí es `VERIFIED` de punta a punta: el E2E lo corre P1 (el E5 de P5 espera en `e2e/pending/e5.e2e.ts`).
> **Fecha:** 2026-10-28 · **Modelo vendorizado:** `mantra-core-health-model`, rama `claude/adoring-allen-ly7r6f`, **commit `af60b79`** (el vigente al ejecutar estos gates). `node scripts/p5-vendor-model-sql.mjs --check` ⇒ los tres `ddl.sql` son idénticos al del modelo ([`3c-vendor-check.txt`](evidencia/3c-vendor-check.txt)): `pay-merchants` sha256 `94a8289568…`, `pay-risk` `f7b75f62ec…`, `pay-schedules` `1d8683c9f9…`. Si el modelo cambia, se re-vendoriza con ese script y se re-ejecutan las suites.
> **Cómo reproducir todo:** `node scripts/p5-gates.mjs <separation|sensitive|faults|drift|ddl-order|truncate|idem-pan>` (crea bases temporales `p5gate_*` con el rol `pay_<svc>` del Compose y un NATS privado en Docker; nunca toca las bases `pay_<svc>` ni los streams `PAY_*` compartidos) y `yarn test --maxWorkers=2` en cada servicio. Una suite jest a la vez.

## Resumen

| Gate | merchants | risk | schedules | Veredicto |
|---|---|---|---|---|
| 1 · Typecheck, lint, unitarios | PASS | PASS salvo latencia | PASS | **PASS** (+ GAP latencia → T-01) |
| 2 · Integración con base real | PASS | PASS | PASS | **PASS** |
| 3 · Contrato | PASS (proveedor) | PASS (proveedor) | PASS (proveedor) | **PASS parcial** · GAP: tests de consumidor generados (P1) |
| 4 · Idempotencia en paralelo | PASS | PASS | PASS | **PASS** |
| 5 · Autorización negativa | PASS | PASS | PASS | **PASS** |
| 6 · Separación | PASS | PASS | PASS | **PASS** |
| 7 · Datos sensibles | PASS | PASS | PASS | **PASS** · 2 GAP (clave de idempotencia con forma de PAN; segmento de ruta con forma de id) |
| 8 · PCI | PASS | PASS | PASS con corrección | **PASS** · GAP de redacción en `pci-alcance.md` (P1) |
| 9 · Deriva de esquema | PASS | PASS | PASS | **PASS** · GAP: nulabilidad contra el `.puml` es del modelo |
| 10 · Observabilidad (traza de E1 en Jaeger) | — | — | — | **NO APLICA AÚN** |
| 11 · Fallos | PASS | PASS | PASS | **PASS** (halló y corrigió 2 defectos) |
| 12 · Carga (T-01) | — | NO APLICA AÚN | — | **NO APLICA AÚN** |
| 13 · Sandbox E2E (ola 4) | — | — | — | **NO APLICA AÚN** |
| Dockerfile (imagen de producción) | PASS | PASS | PASS | **PASS** (halló y corrigió 2 defectos) · GAP: 8 Dockerfiles + plantilla de P1 con los mismos defectos |

## Hallazgos que estos gates destaparon (corregidos en mi carril)

1. **Dockerfile no construía** (`services/pay-*/Dockerfile`): (a) copiaba solo su propio workspace y `yarn install --immutable` rechaza el lockfile recortado (`YN0028`); (b) `yarn workspaces foreach -A … --from` es una combinación inválida en Yarn 4.14.1. Corregido en los tres: `COPY . ./` con `Dockerfile.dockerignore` (deja pasar los `package.json` de los demás workspaces pero no su código) y `-R … --from`. Salida de antes: [`dockerfile-antes-del-arreglo.txt`](evidencia/dockerfile-antes-del-arreglo.txt).
2. **Un corte de conexión de Postgres mataba el proceso** (los tres servicios): el `Pool` de `pg` emite `error` por cada conexión ociosa cortada y sin manejador Node lo trata como excepción no capturada (`exit 1`). Corregido: `pool.on('error', …)` en `database.module.ts` (registra solo el nombre del error). Salida de antes: [`fallos-antes-del-arreglo.txt`](evidencia/fallos-antes-del-arreglo.txt).
3. **La ruta que escribe el cliente se reflejaba** en el log de acceso, en `instance` de los errores RFC 9457 y en los spans OTel (`url.path`, `url.full`, `http.target`): un PAN o un NIT en el path quedaban en los tres. Corregido con `src/log-safe.ts` (mismo criterio que `pay-mockbank`) en logs, `instance` y un exportador de trazas que enmascara antes de enviar.
4. **`pay-risk` arrancaba un relé de outbox sin tabla** (`42P01` en cada sondeo) cuando su base sale del modelo: el servicio no publica eventos y el `pay_risk` del modelo no tiene `outbox_events`. Se quitó `EventsModule` (código muerto). Prueba: [`3c-risk-sin-relay.txt`](evidencia/3c-risk-sin-relay.txt).
5. **Compatibilidad con el arnés e2e de P1**: `e2e/lib/infra.ts` aplica TODO `sql/*.sql` del servicio; `001_*.sql` + `ddl.sql` juntos fallaban (`relation "merchants" already exists`). Con el `001_*.sql` ya retirado se aplican limpios en los tres escenarios ([`3b-ddl-escenarios.txt`](evidencia/3b-ddl-escenarios.txt)).

## 1 · Typecheck, lint y unitarios — PASS

| Qué | Comando | Salida literal / archivo |
|---|---|---|
| Typecheck + build, 3 servicios | `yarn typecheck && yarn run build` (en cada `services/<svc>`) | 6 × `exit=0` — [`3c-typecheck-build.txt`](evidencia/3c-typecheck-build.txt) |
| Lint de mis servicios + `e2e/**` | `yarn eslint "services/pay-{merchants,risk,schedules}/**/*.ts" "e2e/**/*.ts"` | `exit=0` — [`3c-eslint-p5.txt`](evidencia/3c-eslint-p5.txt) |
| Lint de toda la raíz | `yarn lint` | `exit=0` — [`3c-eslint-raiz.txt`](evidencia/3c-eslint-raiz.txt) |
| Unitarias + integración, 2 corridas, `--maxWorkers=2`, una suite a la vez | `yarn test --maxWorkers=2` | **merchants** 19 suites / **209** verdes ×2 · **schedules** 14 suites / **200** verdes ×2 · **risk** ver abajo — [`3c-test-2-corridas.txt`](evidencia/3c-test-2-corridas.txt) |

**pay-risk — `ENVIRONMENT` declarado, no se maquilla como PASS.** En las 2 corridas completas fallan `test/latency.spec.ts` (3 y 5 pruebas) y, en la corrida 2, `watchman.spec.ts` y `contract-conformance.spec.ts` (2 y 1): el Watchman REAL es monohilo, la máquina tenía load average 15–18 en 4 vCPU (otros agentes) y `latency.spec.ts` lo satura en paralelo (screening con tope de 200 ms ⇒ `review` en vez de `allow`). Reproducción: el resto de pay-risk SIN `latency.spec.ts` da **15 suites / 223 pruebas verdes en 2 corridas consecutivas** y, aisladas, `watchman.spec.ts` + `contract-conformance.spec.ts` pasan 33/33 ×2 ([`3c-risk-aislado.txt`](evidencia/3c-risk-aislado.txt)). La latencia medida bajo esa carga, para el registro: 1 búsqueda p99 134 ms · 3 búsquedas p99 452 ms · 4 clientes p99 528 ms · servicio solo p99 249 ms. **GAP** (de P5 + infra): prueba de carga en runner dedicado — ver gate 12.

## 2 · Integración contra base real — PASS

Las pruebas de integración usan `createIsolatedDatabase` (Postgres REAL del Compose, esquema por contexto) y el DDL vendorizado; ninguna mockea el ORM ni `pg`.

```
$ grep -rn "jest.mock\|jest.unstable_mockModule" services/pay-merchants/test services/pay-risk/test services/pay-schedules/test
(sin resultados)
```

Dobles declarados (regla 65): libro mayor (`pay-schedules/test/doubles/ledger.double.ts`), verificador de operadores (`pay-merchants/test/doubles/operator-auth.double.ts`), almacén de objetos de KYC (`FsObjectStore` [DEV]). El Watchman de `pay-risk` es el REAL (listas estáticas de 2019, solo sandbox), salvo en `intent-grouping.spec.ts`, que usa un doble de Watchman declarado. Los gates por script (`p5-gates.mjs`) arrancan el `dist/main.js` real de cada servicio contra Postgres real.

## 3 · Contrato — PASS parcial

- **Proveedor (hecho):** cada respuesta de `pay-merchants` se valida contra `public-v1.yaml` / `internal-merchants-v1.yaml` (`verified(...)`), cada evento contra `merchants-schedules.yaml` sin sustituciones (`eventsOf` valida el sobre completo), `pay-risk/test/contract-conformance.spec.ts` (8) comprueba rutas montadas = operaciones del contrato y cada campo de `AssessmentCreate`/`RuleSetCreate`/`Assessment`, y `pay-schedules` valida mandatos y eventos igual. Contra el proveedor REAL en proceso, no contra un mock.
- **GAP (P1, `@pay/testing`):** «tests de consumidor **generados** desde OpenAPI/AsyncAPI». `@pay/testing` ofrece validadores (`loadContract`, `loadEventContract`) pero no un generador de casos de consumidor; lo que hay son pruebas escritas a mano. Quién: P1.

## 4 · Idempotencia en paralelo — PASS

| Servicio | Mutación | Prueba (todas contra Postgres real) |
|---|---|---|
| merchants | `POST /merchants` misma clave ×10 / claves distintas mismo NIT ×10 | `idempotency-parallel.spec.ts` — un comercio, un `merchant.created` |
| merchants | activar ×10 | `merchants-state.spec.ts` |
| merchants | suspender ×10, cerrar ×10 | `idempotency-parallel.spec.ts` — un efecto, el resto 409 |
| merchants | aceptar contrato ×10, revisión KYC ×10, subir documento ×5 (append-only por diseño), rotar ×5 misma clave, revocar comprometida ×5 | `idempotency-parallel.spec.ts` |
| merchants | claves ×5/×8, revocar ×5, versiones de tarifa ×5, versión de contrato ×10, cierre con claves a la vez | `api-keys`, `fees`, `legal-contract`, `merchant-close-keys` |
| risk | `POST /assessments` misma clave ×5; 12 intentos simultáneos tope 3; evaluaciones del mismo intento ×5 | `assessments.spec.ts`, `intent-grouping.spec.ts` |
| risk | `POST /rule_sets` ×5 | `rule-sets.spec.ts` |
| schedules | `POST /mandates` ×5, cancelar ×5, ejecutor corrido dos veces, evento duplicado ×5 | `mandates.spec.ts`, `executor.spec.ts`, `replica.spec.ts` |

Las pruebas nuevas de esta tanda: `pay-merchants/test/idempotency-parallel.spec.ts` (9). **GAP declarado:** subir un documento de KYC no es idempotente por diseño (no lleva clave; 5 a la vez = 5 documentos distintos, ninguno se pierde).

## 5 · Autorización negativa — PASS

| Caso | merchants | risk | schedules |
|---|---|---|---|
| Otro comercio (404 igual que inexistente) | `api-keys.spec` «otro comercio no ve, no rota ni revoca mis claves: 404» · `GET /merchants/me` no expone a otro | n/a (la API es entre servicios) | `mandates.spec` «otro comercio no ve ni cancela mis mandatos: 404» |
| Sin clave / sin credencial | `operator-credential.spec` «SIN credencial ⇒ 401 y no se crea nada» (41 pruebas del JWT) | `rule-sets.spec` 401 sin credencial / `op-hacker`; 403 sin `X-Service-Id` | `mandates.spec` solo `pay-edge`; sin `X-Merchant-Id` o mal formado ⇒ 403 |
| Servicio ajeno | `authz.spec` (matriz de rutas × servicio) | `assessments.spec` «solo pay-payments … otro servicio es 403» | idem |
| Rol insuficiente | `authz.spec`, `operator-credential.spec` | `rule-sets.spec` 403 `op-norole`/`op-other` | n/a |
| Clave revocada | `api-keys`/`merchant-close-keys`: revocada no rota (409), cerrado no crea ni rota (403); el rechazo de la clave revocada en la API pública es de `pay-edge` (P1, `key-lifecycle.e2e`) | n/a | n/a |
| `test` contra `live` | `api-keys` «una clave test no crea claves live … 403», «no lista, rota ni revoca las del otro: 404» | n/a | `mandates.spec` «los mandatos de test y de live no se mezclan: 404»; sin `X-Pay-Mode` válido ⇒ 403 en todas las rutas |

## 6 · Separación — PASS

Con el rol `pay_<svc>` / `dev_only_<svc>` del Compose: cada servicio arranca (`/health/ready` 200), todas sus sesiones usan su rol (no superusuario, sin `CREATEDB`/`CREATEROLE`) y ese rol recibe `permission denied for database` en las **13** bases ajenas (11 servicios + `postgres` + `pay_test`); el rol de otro servicio tampoco entra a la suya. Matriz completa del Compose: `platform/scripts/check-db-separation.sh` ⇒ `separación: 168 comprobaciones correctas, 0 fallas`.

```
## pay-schedules (rol pay_schedules, contraseña dev_only_schedules del Compose)
PASS  pay-schedules arrancó y GET /health/ready == 200 con el rol pay_schedules (base temporal p5gate_schedules_…, dueño pay_schedules)
     rol efectivo: {"usuario":"pay_schedules","superusuario":false,"crea_bases":false,"crea_roles":false}
     sesiones del proceso en pg_stat_activity: [{"usename":"pay_schedules","datname":"p5gate_schedules_…","sesiones":2}]
     pay_schedules contra 13 bases ajenas: 13 × «permission denied for database»
```

Salida completa: [`separacion.txt`](evidencia/separacion.txt) (16 PASS, 0 FAIL). Nota: el servicio corre sobre una base temporal propiedad de su rol (no sobre `pay_<svc>`, que usa el arnés de P1); las bases `pay_<svc>` se verifican con la matriz de solo lectura.

## 7 · Datos sensibles — PASS (con 2 GAP)

`node scripts/p5-gates.mjs sensitive` ([`datos-sensibles.txt`](evidencia/datos-sensibles.txt), 32 PASS, 0 FAIL). Método: se arranca el proceso real de cada servicio con OTel exportando a Jaeger, se le mandan datos CENTINELA (razón social, nombre de fantasía, NIT, contenido de un documento, nombre del pagador, un PAN de prueba `4111111111111111` como huella del pagador, otro dentro de un archivo, `cvv`, `card_number`), se provocan 4–6 errores por servicio (campos extra, duplicados, tipo inválido, 401/403/404, JSON truncado, **rutas con la razón social y el PAN en el path**) y se busca cada centinela —más un detector de PAN (marca + Luhn) y de rótulos CVV— en: log del proceso, trazas de Jaeger, outbox + mensajes publicados en JetStream, cuerpos de error y, en `pay-risk`, toda la base.

| Servicio | logs | trazas | eventos | errores | base |
|---|---|---|---|---|---|
| pay-merchants | 0 | 0 | solo `merchant.created` lleva la razón social (D-33, permitido y exigido); NIT/fantasía/documento: 0 | 0 | — |
| pay-risk (razón social del comercio y **nombre del pagador** del cribado) | 0 | 0 | no emite | 0 | 0 (no se guarda ningún nombre ni el PAN de la huella: solo su HMAC) |
| pay-schedules | 0 | 0 | 0 (la descripción del mandato, dato del comercio, no sale) | 0 | — |

**GAP 1 — `Idempotency-Key` con forma de PAN** ([`sonda-idempotency-key-pan.txt`](evidencia/sonda-idempotency-key-pan.txt), `node scripts/p5-gates.mjs idem-pan`): no llega a logs ni respuestas, pero **persiste en claro** en `idempotency_keys` (los tres) y en `risk_assessments.request_key`. Es la misma observación que P2 hizo en `pay-settlement`; `pay-ledger` la resolvió guardando un hash. Dueño de `idempotency_keys`: `contracts/packages/idempotency` (P1); propuesta: guardar `sha256(clave)`; en `pay-risk`, hacer lo mismo con `request_key` (cambio solo de código, la columna sigue siendo `text`) cuando la librería lo haga, porque arreglar solo una tabla no cierra el hueco.
**GAP 2 — límite del enmascarado de rutas:** un segmento de ruta con forma de id (minúsculas, guion bajo, sin 6 dígitos seguidos, p. ej. `md_razoncentinelaurl`) no se distingue de un id y se conserva en el log y en `instance`; un nombre con mayúsculas, espacios o un PAN sí se enmascara. Declarado y probado en `url-privacy.spec.ts` («LÍMITE DECLARADO»). Mitigación real: `pay-edge` rechaza el PAN antes de reenviar, y las rutas de estos servicios no son públicas.

**Cierre del fallo de `url-privacy.spec.ts` de pay-schedules (y pay-risk)** — causa demostrada en [`3c-url-privacy-causa.txt`](evidencia/3c-url-privacy-causa.txt): mi vector «nombre en un id» estaba en minúsculas (forma de id) y la prueba prometía más de lo que el diseño garantiza; la segunda prueba falló por contaminación del `ctx.logs` compartido. No era una regresión del enmascarado. Vector pasado a mayúsculas y límite declarado con su propia prueba: 5/5 en ambos servicios, y verde en las corridas finales (merchants 209 ×2, schedules 200 ×2).

## 8 · PCI — PASS

`docs/cumplimiento/pci-alcance.md`, §3 «Clasificación por servicio», citado literal:

- L35 — `| pay-merchants | P5 | **Fuera de alcance** | Datos del comercio (KYC), no del pagador. api_key.created lleva solo el hash y last4 de la clave de API, que **no** es un dato de tarjeta. | contracts/asyncapi/merchants-schedules.yaml |`
- L36 — `| pay-risk | P5 | **Fuera de alcance** | Reglas y cribado de sanciones sobre el comercio y el pagador; sin tarjeta. **Provisoria**: confirmar que las señales de riesgo por tarjeta usan solo el token o el BIN, nunca el PAN. | pregunta C en §6 |`
- L37 — `| pay-schedules | P5 | **Fuera de alcance** | Mandatos y pagos programados sobre montos y referencias; el medio de pago es un card_token. | merchants-schedules.yaml |`

Evidencia que respalda las tres clasificaciones: el esquema (`src/schema-map.ts` de cada servicio) no tiene ninguna columna de tarjeta; el gate 7 mete un PAN de prueba como huella del pagador, dentro de un archivo y en una ruta y no aparece en logs, trazas, eventos, errores ni (en `pay-risk`) en la base. **Para cerrar la «provisoria» de `pay-risk` (pregunta C):** las señales de riesgo usan `method` (enum `qr|card|bank_transfer|wallet`) y `payer_hash` (HMAC de una huella opaca); nunca el PAN. **GAP de redacción (dueño P1, documento suyo):** L37 dice que «el medio de pago es un `card_token`»; los mandatos de `pay-schedules` no tienen medio de pago de tarjeta (pagan con el saldo AloVida vía el libro mayor). Texto propuesto: «Mandatos y pagos programados sobre montos y referencias; paga con saldo AloVida (libro mayor), sin medio de pago de tarjeta.» La clasificación (fuera de alcance) no cambia.

## 9 · Deriva de esquema — PASS

| Qué | Cómo | Resultado |
|---|---|---|
| Modelo → servicio | `node scripts/p5-vendor-model-sql.mjs --check` (no falla si el repo hermano no está) | 3 × idéntico a `SQL/pay/{73,76,77}_*/ddl.sql` del commit `af60b79` |
| SQL vendorizado ↔ base ↔ mapa del código | `test/drift.spec.ts` + `src/schema-map.ts` + `test/support/drift.ts` en cada servicio | **14/14 en los tres** (sin deriva; aplicar el DDL dos veces no cambia nada) |
| Controles negativos por mutación (regla 97.2) | mutaciones DDL dentro de una transacción que se revierte | detecta: columna ausente, tabla ausente, columna obligatoria no mapeada, columna opcional no mapeada, **nulabilidad divergente en los dos sentidos**, tipo divergente, tabla sin mapear, índice con nombre generado |
| Código → mapa | extracción estática de los `INSERT`/`UPDATE … SET`/`FROM` literales de `src/` | solo nombra tablas y columnas del mapa (con control negativo del extractor) |
| Código → base (independiente de los mapas) | `node scripts/p5-gates.mjs drift` ([`deriva-sql-codigo.txt`](evidencia/deriva-sql-codigo.txt)) | 3 × 0 hallazgos |
| Aplicación limpia por el rol dueño, ×2 y en los tres órdenes que usan tests/arnés | `node scripts/p5-gates.mjs ddl-order` ([`3b-ddl-escenarios.txt`](evidencia/3b-ddl-escenarios.txt)) | 9 PASS |
| TRUNCATE en tablas inmutables de `pay_merchants` (modelo `af60b79`) | `node scripts/p5-gates.mjs truncate` con el ROL DE LA APLICACIÓN no superusuario ([`3c-truncate-rol-aplicacion.txt`](evidencia/3c-truncate-rol-aplicacion.txt)) + `test/merchants-truncate.spec.ts` (3) | `TRUNCATE` rechazado en `contract_versions`, `contract_acceptances`, `fee_schedule_versions` y `fee_schedule_channels` («la tabla … es inmutable (TRUNCATE)»); `UPDATE`/`DELETE` con una fila también; `api_keys` (no inmutable) sigue pudiéndose vaciar. Ningún `reset()` de mis tests usa `TRUNCATE` (los únicos `TRUNCATE` son aserciones de rechazo) |
| Los 18 puntos del alta legal (P5.H1.M1) | `test/alta-legal-18-puntos.spec.ts` (5) | 23 renglones del registro 3.1: 9 en `pay-merchants` (incl. los 6 PDF = el `CHECK` de la base y el KYC; el tipo societario = la lista cerrada de 8) y 14 por `directory_tenant_ref`. Ninguno sin mapear; no hizo falta abrir un issue |

**GAP (del modelo, no de P5):** la nulabilidad contra el `.puml` mismo la compara el comparador de catálogos del agente del modelo (12/12, `INTEGRACION.md` §6); aquí se verifica contra el SQL generado que se vendoriza y contra lo que el código asume. **«ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18)»**.

## 10 · Observabilidad — NO APLICA AÚN

Motivo: el gate pide la traza OTel **de E1 de punta a punta** en Jaeger; E1 (alta → clave → cobro QR → callback → ledger) cruza `pay-edge`, `pay-payments`, `pay-connectors` y `pay-ledger`, y E1 hoy no llega a `succeeded` en el arnés (`e2e/pending/e1.e2e.ts`, lo corre P1). Lo que sí se verificó de P5: los tres servicios exportan spans OTLP a Jaeger (182 / 125 / 199 spans en la corrida del gate 7) y sus spans no llevan datos sensibles. Qué lo destraba: E1 en verde (P3 + P5 ya hicieron su parte del cribado) y que P1 propague `traceparent` por el borde.

## 11 · Fallos — PASS

`node scripts/p5-gates.mjs faults` ⇒ [`fallos.txt`](evidencia/fallos.txt) (29 PASS, 0 FAIL). Cada experimento tiene hipótesis, inyección y observación:

| # | Experimento | Observado |
|---|---|---|
| F1 | `pay-risk` con el Watchman inalcanzable | 201 `review`/`screening_unavailable`, `screened=false`, nunca `allow`; sigue `ready` |
| F2 | Se cortan las conexiones de Postgres de **cada** servicio en caliente (`pg_terminate_backend`) | **Antes:** el proceso moría (`exit 1`). **Ahora:** vivo, la siguiente petición reconecta, `/health/ready` vuelve a 200; en `pay-risk` la misma clave repetida da 200 y queda un solo rastro |
| F3 | `pay-merchants` con NATS detenido y luego restablecido | el alta responde 201; `merchant.created` queda pendiente en el outbox; al volver NATS se publica y el stream tiene exactamente 1 mensaje |
| F4 | `pay-schedules` con el libro mayor respondiendo 500 (resultado ambiguo, regla 11) | 3 reintentos con la MISMA `Idempotency-Key`; al agotar la política `failed`/`ledger_unavailable`/a revisión, sin asiento; **jamás** se llamó a `/void`; un solo aviso |
| F5 | `pay-schedules` muerto con SIGKILL y reiniciado sobre la misma base | el pago programado sobrevive (una fila) en estado `due`, sin ejecutarse sin asiento |

**No cubierto:** caída de Redis/Temporal (no los usan estos servicios), pérdida de red parcial hacia NATS durante la publicación, disco lleno.

## 12 · Carga (T-01, `pay-risk` p99) — NO APLICA AÚN

Motivo: T-01 es la prueba a 2× el volumen objetivo en un runner **dedicado** (ola 3 de P1/infra); esta máquina está compartida (load average 15–18 en 4 vCPU) y el Watchman local es monohilo (satura con > 4 clientes), así que una medición aquí sería ENVIRONMENT, no una cifra. La medición informativa de arriba (p99 134 ms con 1 búsqueda; 452 ms con 3; 528 ms con 4 clientes; servicio solo 249 ms bajo carga ajena) muestra el margen y los cuellos: `entity_type` del pagador (una búsqueda en vez de dos, PR-11) y escalar Watchman. P5.H2.M4 sigue `A MEDIAS`. Qué lo destraba: runner dedicado + Watchman escalado o cacheado. Dueño: P1/infra + P5.

## 13 · Sandbox E2E (ola 4) — NO APLICA AÚN

Motivo: es de la ola 4 y exige `pay-mockbank` con los flujos E1–E8. La parte de P5 (E5) está escrita y tipada en `e2e/pending/e5.e2e.ts` (+ `docs/trabajo/ola-2/P5/FLUJO-E5.md`); la corre P1.

## Dockerfile (imagen de producción de cada servicio) — PASS

`docker build -f services/<svc>/Dockerfile --build-arg HUB=p5gate.local -t p5gate-<svc>:local .` (sin registro: nada se publica; `HUB=p5gate.local` es `node:22-alpine` + la CA del proxy de ESTE entorno, para que `yarn install` valide TLS sin desactivarlo; el Dockerfile de producción no depende de eso). Al terminar se borran las imágenes y la base de build.

```
pay-merchants  exit=0  imagen 990931855 B  usuario=node  cmd=[node dist/main.js]  expose=3107
pay-risk       exit=0  imagen 990672403 B  usuario=node  cmd=[node dist/main.js]  expose=3108
pay-schedules  exit=0  imagen 990754718 B  usuario=node  cmd=[node dist/main.js]  expose=3109
docker run (sin variables) ⇒ Error: Falta la variable de entorno PAY_MODE (sandbox | live)  · exit=1   (los tres)
uid=1000(node)  (los tres)        sin imágenes p5gate restantes
```

Salida completa: [`dockerfile.txt`](evidencia/dockerfile.txt) (+ los `.log` de cada build). Una primera pasada falló por `ENOSPC` (disco compartido al 93 %): ENVIRONMENT, se liberó la caché de build sin uso y se repitió.
**GAP (peso de la imagen):** ~990 MB por servicio, porque la imagen final copia todo `/repo` con `node_modules` de todos los workspaces y las devDependencies. Mejora propuesta (no hecha): `yarn workspaces focus --production <svc>` en la etapa final. Dueño: P1 (plantilla).
**GAP (P1):** los 8 `Dockerfile` restantes y `platform/templates/*/Dockerfile` tienen los dos defectos del hallazgo 1 (`-A … --from` inválido y contexto recortado).

## GAP consolidado (qué falta y de quién)

| GAP | De quién |
|---|---|
| Tests de consumidor generados desde OpenAPI/AsyncAPI (gate 3) | P1 (`@pay/testing`) |
| `idempotency_keys` guarda la clave en claro (PAN-shaped); luego `risk_assessments.request_key` | P1 (`contracts/packages/idempotency`) → P5 |
| `pci-alcance.md` L37 dice «card_token» para `pay-schedules`; cerrar la «provisoria» de `pay-risk` (pregunta C) con la evidencia de arriba | P1 (dueño del documento) |
| Dockerfile: 8 servicios + plantilla con los dos defectos; imagen de ~990 MB | P1 |
| Carga T-01 de `pay-risk` (runner dedicado) y p99 < 300 ms | P1/infra + P5 (P5.H2.M4 `A MEDIAS`) |
| Traza de E1 en Jaeger; sandbox E2E (ola 4); E5 real por el stack | P1, P3, P4 |
| Spike Watchman con listas vigentes y umbrales (P5.H2.M1) | Cumplimiento (Q-12) + infra — `BLOQUEADO` externo |
| Límite del enmascarado de rutas (segmento con forma de id) | P5 (declarado; sin plan de cambio) |
| Nulabilidad contra el `.puml` | agente del modelo (hecha allí) |
