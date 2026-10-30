# Runbook: de sandbox a producción

> Estado: **borrador verificable**, escrito en la ola 4 (P1.H5.M5). Lo que está **demostrado** lleva su evidencia; lo que **no se pudo ejercitar** (porque depende de credenciales o de piezas que no existen) está marcado **BLOQUEADO**. Nada de este documento mueve dinero real ni sirve para operar sin visto bueno legal (T-03) ni cuenta recaudadora.
> Principio (D-26): pasar a producción es **cambiar configuración, no código**. El mismo `dist/` de cada servicio corre en sandbox y en `live`.

## 0 · Precondiciones que no son de software

| Qué | Estado | Quién |
|---|---|---|
| Cuenta recaudadora y visto bueno legal (T-03) | abierta | dueño del proyecto / legal |
| Documentación de API y ambiente de pruebas del Banco Mercantil (Q-01, Q-11, `docs/spikes/banco-mercantil.md`) | **no entregada**: no hay adaptador `mercantil_qr` ni `mercantil_card` | dueño del proyecto |
| Validación de un QSA del alcance PCI (`docs/cumplimiento/pci-alcance.md`) | abierta | cumplimiento |
| Volumen objetivo contra Coolify (T-01) | prueba de carga escrita, sin correr (`docs/trabajo/ola-3/P1/CARGA.md`) | P1 + dueño |

## 1 · La guardia de modo (ya demostrada)

`PAY_MODE` es **obligatorio, explícito y sin valor por defecto** en los 12 servicios; `sandbox` y `live` son los únicos valores (`prod`, `LIVE` o vacío NO arrancan: `e2e/flows/pay-mode-required.e2e.ts`). Bajo `live` **ningún servicio arranca con un doble**. Salida literal con el entorno de sandbox tal cual y `PAY_MODE=live` (`docs/trabajo/ola-2/P1/evidencia/live-guard-mensajes.txt`, prueba `e2e/flows/live-guard.e2e.ts`):

| Servicio | Se niega a arrancar con `live` si… (mensaje literal) |
|---|---|
| `pay-risk` | `PAY_MODE=live exige declarar WATCHMAN_LISTS=current (listas de sanciones vigentes)` |
| `pay-qr` | `PAY_MODE=live no admite un QR_ACCOUNT_GUID provisional o de sandbox: poné el GUID que asigna el banco o el regulador` |
| `pay-vault` | `PAY_MODE=live: VAULT_BACKEND=fake es un doble; pay-vault se niega a arrancar` |
| `pay-merchants` | `PAY_MODE=live no arranca con dobles ni interruptores de prueba: …` (hoy el almacén de KYC `fs`) |
| `pay-webhooks` | `WEBHOOKS_SANDBOX_TARGETS y WEBHOOKS_SANDBOX_CA_FILE no pueden usarse con PAY_MODE=live` y, además, `WEBHOOKS_ENGINE` obligatorio sin valor que arranque (ver §3) |
| `pay-connectors` | `PAY_MODE=live no admite conectores ni dobles de sandbox; quitá del entorno: …` (`MOCKBANK_URL`, `PAY_SECRET_CONNECTOR_MOCK_*`, `MOCK_PUMP_*`, `POLLER_*`) |
| `pay-payments` | `PAY_MODE=live: no se pudo verificar que pay-connectors no tiene conectores «mock» o «sandbox» …` |
| `pay-settlement` | `SETTLEMENT_TRANSFER_CONNECTOR=mock no puede correr con PAY_MODE=live` (y rechaza el modo B `acquirer`) |
| `pay-edge` | `PAY_MODE=live no admite servicios dueños en loopback (dobles locales); corregí: …` |
| `pay-mockbank` | **no existe en live**: `PAY_MODE=live: pay-mockbank es un banco simulado y no existe en producción; no arranca` |
| `pay-ledger`, `pay-schedules` | arrancan en `live` con el entorno de sandbox: no embeben un doble (su guardia cubre interruptores de prueba). `pay-ledger` exige un TigerBeetle real (`TB_ADDRESS`). |

**Criterio de «la guardia funciona»:** con `PAY_MODE=live` y el conector `mock` configurado el sistema NO arranca (comando: `yarn jest --config e2e/jest.config.cjs --runInBand e2e/flows/live-guard.e2e.ts`; la prueba arranca los servicios contra la infraestructura de sandbox y exige los mensajes de arriba). Además `X-Pay-Mode` lo fija `pay-edge` desde el registro de la clave (D-28); un despliegue `live` solo atiende claves `live`.

## 2 · Lo que cambia, servicio por servicio

Notación: **SALE** = se quita del entorno; **CAMBIA** = mismo nombre, valor de producción; **NUEVO** = aparece. Los valores reales **los entrega OpenBao / Coolify, nunca un archivo del repo** (CLAUDE.md regla 6; `docs/trabajo/ola-2/P1/ARNES.md` § Matriz por servicio es la fuente de las variables obligatorias).

### 2.1 Común a los 12 (los 11 de producto)
| Variable | Sandbox (compose.mock.yml) | Producción |
|---|---|---|
| `PAY_MODE` | `sandbox` | **`live`** |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `postgres`, `5432`, `pay_<svc>`, `pay_<svc>`, `dev_only_<svc>` | instancia propia por servicio (o clúster con una base y un rol por servicio, sin permisos cruzados; `template1` sin `CONNECT`), contraseñas de OpenBao |
| `NATS_URL` | `nats://nats:4222` | clúster NATS JetStream de producción, con credenciales por servicio (propuesta P1-7) |
| `LOG_LEVEL` | `info` | `info` (sin datos personales en logs: gate de datos sensibles) |
| `IDEMPOTENCY_MASK_KEY` | sin definir (constante de desarrollo declarada en `@pay/idempotency`) | **NUEVO, obligatoria** en todo servicio que usa `@pay/idempotency` (los 11 salvo `pay-mockbank`, que no despliega en live): secreto de despliegue de **≥ 32 bytes** (`openssl rand -base64 48`), de OpenBao, **distinto de la clave de desarrollo** y, mientras no haya rotación escrita, **el mismo valor en todos los servicios** (pay-edge enmascara y los dueños vuelven a pasar la clave por el mismo filtro). Sin ella, o corta, el servicio no arranca (S-02). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | sin definir | colector de producción (los spans salen con la URL enmascarada: `@pay/idempotency` `maskSpanAttributes`) |
| Imagen | `pay-sandbox:local` (platform/Dockerfile.sandbox, todos los servicios, con `devDependencies`) | una imagen **por servicio** mínima (`Dockerfile` del servicio con `yarn workspaces focus --production`, propuesta 21 de P2) |

### 2.2 Por servicio
| Servicio | SALE | CAMBIA | NUEVO / exigido en live |
|---|---|---|---|
| `pay-edge` | — | `REDIS_URL` (Redis de producción), `UPSTREAM_PAY_*_URL` (nombres internos, **no loopback**), `RATE_LIMIT_*` (valores de negocio) | **`TRUST_PROXY_HOPS` declarado (sin valor por defecto en live, S-06)**: `0` si el borde da la cara sin proxy; si hay Traefik/Coolify o un balanceador delante, el número EXACTO de proxies de confianza (con 0 detrás de un proxy toda la clientela comparte IP y 30 autenticaciones fallidas por minuto devuelven 429 a todos; con más saltos que los reales, `X-Forwarded-For` se falsea y el límite por IP no sirve). Se comprueba con una petición real: la IP que ve el borde tiene que ser la del cliente. Claves `sk_live_` (solo las crea `pay-merchants`; el modo lo fija el registro de la clave) |
| `pay-payments` | — | `RISK_URL`, `CONNECTORS_URL`, `LEDGER_URL`, `VAULT_URL`, `TEMPORAL_ADDRESS` (Temporal de producción), `TEMPORAL_TASK_QUEUE`; `RISK_TIMEOUT_MS` según el p99 real de `pay-risk` | `RISK_FAIL_CLOSED_THRESHOLD_MINOR` y `RISK_ALLOW_BELOW_THRESHOLD` decididos por cumplimiento (Q-08) |
| `pay-connectors` | **`MOCKBANK_URL`**, **`PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET`**, `MOCK_PUMP_INTERVAL_MS`, `POLLER_INTERVAL_MS`, `POLLER_MIN_AGE_MS` (si no se usan los valores operativos), `MOCKBANK_TIMEOUT_MS` | `PAY_QR_URL` | `BANK_TRANSFER_BANK_NAME`, `BANK_TRANSFER_ACCOUNT_HOLDER`, `BANK_TRANSFER_ACCOUNT_NUMBER` (**los tres o ninguno**; con el rótulo `SANDBOX` no arranca; sin la cuenta real T-03 no se inventan). Credenciales del conector real `PAY_SECRET_CONNECTOR_MERCANTIL_*` (**BLOQUEADO**: no existe adaptador, Q-01/Q-11) |
| `pay-ledger` | `LEDGER_ID_NAMESPACE=sandbox` | `TB_ADDRESS`, `TB_CLUSTER_ID` (clúster TigerBeetle de producción; el de sandbox es de un solo nodo y SOLO de desarrollo), `TB_TIMEOUT_MS` | respaldo y restauración probados del clúster TigerBeetle |
| `pay-risk` | — | `WATCHMAN_URL` (Watchman con listas VIGENTES, no `v2-static` de 2019), `SANCTIONS_DENY_SCORE`/`SANCTIONS_REVIEW_SCORE` (los fija cumplimiento), `PAYER_HASH_KEY` (secreto real), `SCREENING_TIMEOUT_MS` | **`WATCHMAN_LISTS=current`** (obligatorio en live) |
| `pay-qr` | — | **`QR_ACCOUNT_GUID`** (el que asigna el banco o el regulador; `e2e.sandbox.guid` no arranca) | — |
| `pay-vault` | **`VAULT_BACKEND=fake`** | — | un respaldo real de custodia de tarjeta (`hyperswitch-card-vault` o el PSP): **BLOQUEADO**, no existe otro `VAULT_BACKEND` que `fake`. Instancia de Postgres y OpenBao **propias** del CDE (`pci-alcance.md`) |
| `pay-merchants` | `KYC_STORE_DIR` (sistema de archivos) | `OPERATOR_TOKEN_PUBLIC_KEY`, `OPERATOR_TOKEN_ISSUER`, `OPERATOR_TOKEN_AUDIENCE` (la identidad **real** del back-office, no la clave sintética de `platform/.sandbox`) | un almacén de objetos de KYC real (**BLOQUEADO**: hoy solo existe `fs`, que la guardia rechaza en live) |
| `pay-webhooks` | **`WEBHOOKS_SANDBOX_TARGETS`**, **`WEBHOOKS_SANDBOX_CA_FILE`**, `WEBHOOKS_POLL_INTERVAL_MS`/`WEBHOOKS_RETRY_*` de prueba | `WEBHOOKS_SECRET_KEK` (clave real de sellado, de OpenBao) | **`WEBHOOKS_ENGINE=svix`** (obligatorio en live) — **BLOQUEADO**: `SvixEngine` no está implementado y `inprocess` es un doble; hasta entonces `pay-webhooks` no corre en live |
| `pay-settlement` | **`SETTLEMENT_TRANSFER_CONNECTOR=mock`** | `LEDGER_URL`, `CONNECTORS_URL`, `OPERATOR_TOKEN_PUBLIC_KEY`/`_ISSUER`/`_AUDIENCE` (reales), `SETTLEMENT_*` (corte, huso, T+N) | `SETTLEMENT_TRANSFER_CONNECTOR=bank_transfer` (o `mercantil_qr`/`mercantil_card` cuando existan), `SETTLEMENT_STATEMENT_FORMATS`; `SETTLEMENT_MODE=bank` (el modo B `acquirer` es un doble y no corre en live) |
| `pay-schedules` | — | `LEDGER_URL`, `RETRY_DELAYS_SECONDS` | — |
| `pay-mockbank` | **el servicio entero** (no se despliega en producción) | — | — |

### 2.3 Infraestructura (platform/compose.yml no es producción)
- Postgres, NATS, Redis, Temporal, TigerBeetle, Jaeger y Watchman del Compose son **de desarrollo** (sin autenticación, `fsync=off`, puertos locales). En producción: instancias gestionadas, TLS, credenciales por servicio, y el Postgres + OpenBao del CDE separados.
- Watchman: `moov/watchman:v2-static` trae las listas OFAC de 2019 congeladas; **solo sandbox**. En producción, listas vigentes (`docs/spikes/watchman.md`).
- Secretos: nada de `dev_only_*`, `whsec_…` de ejemplo ni claves de `platform/.sandbox/`. Un secreto expuesto se **rota**, no se borra del historial.

## 3 · Lo que NO se puede hacer todavía (BLOQUEADO)

| Bloqueo | Por qué | Qué lo destraba | De quién |
|---|---|---|---|
| Conectores del Banco Mercantil | el banco no entregó documentación ni ambiente de pruebas | Q-01/Q-11 | dueño del proyecto |
| Paridad mock/real | la suite de contrato de P4 solo tiene el enlace simulado; los reales figuran BLOQUEADOS en `yarn test:parity` | adaptador real + credenciales | P4 |
| `pay-webhooks` en live | `SvixEngine` no existe | implementarlo (P1) y desplegar Svix | P1 |
| `pay-vault` en live | solo existe el doble `fake` | respaldo real de custodia | P3 |
| `pay-merchants` en live | solo existe el almacén de KYC `fs` | almacén de objetos | P5 |
| Cobro real | cuenta recaudadora y visto bueno legal (T-03) | legal | dueño |

## 4 · Orden sugerido del paso (cuando los bloqueos estén resueltos)
1. Provisionar infraestructura de producción y secretos (OpenBao/Coolify). Verificar el aislamiento de red del `pay-vault`.
2. Aplicar el esquema desde el modelo (D-18: `.puml` → `SQL/` → base → ORM), **nunca** con DDL suelto; verificación de deriva en verde.
3. Desplegar con `PAY_MODE=live` **servicio por servicio**, de adentro hacia afuera: `pay-ledger`, `pay-risk`, `pay-qr`, `pay-vault`, `pay-merchants`, `pay-webhooks`, `pay-connectors`, `pay-payments`, `pay-settlement`, `pay-schedules`, `pay-edge`. Cada uno debe quedar `ready` (`GET /health/ready` 200). Si uno se niega con un mensaje de la tabla de §1, es la guardia: corregí la configuración, no el código.
4. Crear la primera clave `sk_live_` de un comercio de prueba **con datos de prueba** y un importe mínimo acordado con legal; verificar `UI → request → response → persistencia → recarga → UI` (una respuesta 200 o un toast no prueban nada).
5. Conciliar el primer día con el extracto real del banco antes de abrir a más comercios.
6. Plan de reversa: retirar la clave `sk_live_` (revocación ⇒ 401 en el borde, probado en `flows/key-lifecycle.e2e.ts`) y suspender el comercio; los asientos del ledger se corrigen con asientos inversos, nunca con `UPDATE`/`DELETE`.

## 5 · Cómo se comprueba que este documento no miente
- Variables obligatorias por servicio: `node --no-warnings e2e/cli.ts envprobe` (quita UNA variable por servicio y clasifica el arranque; salida: `docs/trabajo/ola-2/P1/evidencia/e2e-envprobe-2d.txt`).
- Guardia de modo: `e2e/flows/pay-mode-required.e2e.ts` y `e2e/flows/live-guard.e2e.ts`.
- Capa sandbox completa: `platform/compose.mock.yml` + `yarn seed:sandbox` + `yarn test:parity` (ver el encabezado de `platform/compose.mock.yml`).

## 6 · Lo que `live` exige desde la ola 5 (verificado)

- **`pay-connectors`:** `SECRET_PROVIDER=openbao` (con `env` no arranca), `OPENBAO_ADDR` https y credenciales (`OPENBAO_TOKEN` o AppRole `OPENBAO_ROLE_ID` + `OPENBAO_SECRET_ID`; en producción AppRole, el token estático no se renueva). Ruta `<mount>/data/<prefijo>/<modo>/CONNECTOR_<CODIGO>_<NOMBRE>`. Más: `docs/trabajo/ola-5/P4/evidencia/`.
- **`pay-webhooks`:** `WEBHOOKS_ENGINE=svix` (con `inprocess` no arranca), `WEBHOOKS_SVIX_URL` https, `WEBHOOKS_SVIX_AUTH_TOKEN` (JWT) y **`WEBHOOKS_SVIX_NAMESPACE`** (obligatorio en live, distinto de `sandbox`, p. ej. `prod-bo`; es el dueño de los endpoints que este despliegue crea en Svix y lo único que el reconciliador se atreve a tocar: nunca compartas un mismo valor entre dos despliegues que usan el mismo Svix; los endpoints anteriores a la marca no se tocan jamás). Un endpoint propio sin fila local se **DESHABILITA** (reversible), no se borra: ver §7.2. Opcionales con defecto seguro: `WEBHOOKS_SVIX_ORPHAN_ACTION=disable` (`delete` es irreversible —el secreto del comercio se pierde— y en live exige además `WEBHOOKS_SVIX_ORPHAN_DELETE_ACK=irreversible`), `WEBHOOKS_SVIX_MAX_ORPHAN_DELETES=5` (solo rige con `delete`: si una pasada ve más huérfanos no borra ninguno, los deshabilita y avisa; `GET /health/ready` → `delivery_engine.orphan_guard.cap_trips` > 0 indica que el freno actuó: revisar a mano, no subir el tope) y `WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS=60`. En el servidor Svix: fijar `SVIX_MAIN_SECRET` **antes** de guardar la primera clave (no se puede cambiar después; sin él las claves de firma quedan sin cifrar en su base), `SVIX_JWT_SECRET` desde OpenBao, un proxy de salida (`SVIX_PROXY_ADDR`) sin ruta a la red interna, y las tres perillas de prueba (`SVIX_WHITELIST_NAMES`, `SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION`, `SVIX_RETRY_SCHEDULE` corto) **cerradas**. Más: `docs/trabajo/ola-5/P1/INFORME.md`.
- **Imágenes:** en este entorno ghcr.io (TigerBeetle) y Docker Hub no sirven; `mirror.gcr.io` sirve OpenBao y Svix (`HUB=mirror.gcr.io`).
- **`pay-edge` y todos los que usan `@pay/idempotency` (revisión de seguridad S-02, S-06):** `IDEMPOTENCY_MASK_KEY` (≥ 32 bytes, secreto de despliegue, no la constante de desarrollo) y, en `pay-edge`, `TRUST_PROXY_HOPS` explícito. Sin ellos el servicio no arranca. Rotar `IDEMPOTENCY_MASK_KEY` cambia el valor guardado de una `Idempotency-Key` con forma de PAN: las filas vencen a las 24 h, así que solo se puede duplicar, dentro de esa ventana, el reintento de un comercio que pegó un PAN como clave (caso anómalo).
- **`pay-connectors` / OpenBao (S-08, S-09, S-10, S-18):** `OPENBAO_ADDR` no puede ser loopback, `OPENBAO_TOKEN` no puede empezar por `dev-only-` y `NODE_TLS_REJECT_UNAUTHORIZED=0` no puede estar en el entorno; `OPENBAO_CACHE_TTL_MS` ≤ 300 000 (5 min) y `OPENBAO_ROTATION_WINDOW_MS` ≤ 604 800 000 (7 días), en cualquier modo. Un código de conector no puede ser prefijo de otro delimitado por `_` (`mercantil` / `mercantil_qr`): el registro lo rechaza al arrancar. Un valor de secreto mal formado en OpenBao se descarta (el callback da 401, no 500) y no anula al bueno de un par de rotación; **para cerrar la ventana ante una filtración, borrá la versión N-1 en OpenBao** (la ventana solo se acorta así). Pendientes de la revisión: `docs/trabajo/ola-5/integracion/revision/PENDIENTES-SEGURIDAD.md`.

## 7 · Procedimientos de la re-revisión de dinero (ola 5, F-B1, F-B2, F-D1)

Todo lo de esta sección se ejercitó contra Postgres, NATS 2.10 y svix-server 1.104.0 reales; la evidencia está en `docs/trabajo/ola-5/P1/evidencia/fb-*.txt`.

### 7.1 Guardianes de solo-agregar en una base ya desplegada (F-D1)

`platform/scripts/sandbox-migrate.mjs` no toca una base que ya tiene tablas, así que una base creada antes de ola 5 puede carecer de los triggers `<tabla>_immutable` y `<tabla>_no_truncate`. Cada servicio con tablas de solo-agregar lo informa en `GET /health/ready` → **`checks.append_only_guards: { ok, missing[] }`** (mismo nombre y forma en todos; `pay-webhooks`: `webhook_delivery_attempts_immutable` y `webhook_delivery_attempts_no_truncate`).

- Sandbox: el servicio sigue listo con `ok:false` visible y un aviso `append_only_guards_missing` en el log (una vez por cambio de estado).
- `PAY_MODE=live`: `ok:false` ⇒ **503** (no listo). No se despliega a producción con un guardián ausente.
- **Reaplicar** (idempotente: `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, y `CREATE OR REPLACE FUNCTION forbid_mutation()`): ejecutar el `sql/ddl.sql` vendorizado del servicio contra su base con el rol dueño de las tablas, p. ej. `psql "$DATABASE_URL" -f services/pay-webhooks/sql/ddl.sql`. Es seguro sobre una base con datos: las demás sentencias son `CREATE … IF NOT EXISTS`/`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` (que revalida las filas). Después, `GET /health/ready` → `ok:true` sin reiniciar el servicio. Probado: `services/pay-webhooks/test/append-only-guards.spec.ts` (base creada con el DDL anterior ⇒ `ok:false`; reaplicar ⇒ `ok:true`).
- Un trigger apagado con `ALTER TABLE … DISABLE TRIGGER` cuenta como ausente (`tgenabled` distinto de `O`/`A`), y uno con el nombre esperado pero otra función u otro evento, también.

**Los otros cuatro servicios (`pay-ledger`, `pay-settlement`, `pay-vault`, `pay-connectors`) — qué comprueban y cómo se aplica sin sorpresas**

| Servicio | Tablas con guardián (`<tabla>_immutable` + `<tabla>_no_truncate`) | `missing` de una base vieja |
|---|---|---|
| `pay-ledger` | `ledger_transactions`, `ledger_legs`, `ledger_statement_lines`, `ledger_rejections` | los 8 |
| `pay-settlement` | `settlement_audit` | 2 |
| `pay-vault` | `reveal_audit` | 2 |
| `pay-connectors` | `connector_callback_events`, `connector_api_attempts` | 4 (las tablas de estado `connector_charges|transfers|refunds` tienen su `_no_truncate` desde antes y no entran en este informe) |

1. **Antes de aplicar**, mirar qué falta: `curl -s http://<servicio>/health/ready | jq .checks.append_only_guards`, o directamente en la base: `SELECT c.relname, t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND (t.tgname LIKE '%\_immutable' OR t.tgname LIKE '%\_no\_truncate') ORDER BY 1, 2;` (`tgenabled` debe ser `O`).
2. **Qué aplicar.** Recomendado: **solo el bloque de guardianes** del `sql/ddl.sql` (la función `forbid_mutation()` y los `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`), en **una transacción**. `CREATE TRIGGER` toma `SHARE ROW EXCLUSIVE` unos milisegundos y NO recorre la tabla. Con el rol dueño de las tablas:
   ```bash
   DDL=services/pay-ledger/sql/ddl.sql   # o pay-settlement | pay-vault | pay-connectors
   { echo 'BEGIN;'
     sed -n '/^CREATE OR REPLACE FUNCTION forbid_mutation/,/^\$\$;/p' "$DDL"
     grep -E '^(DROP TRIGGER IF EXISTS "[a-z_]+_(immutable|no_truncate)"|CREATE TRIGGER [a-z_]+_(immutable|no_truncate) )' "$DDL"
     echo 'COMMIT;'; } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
   ```
   Alternativa: reaplicar el `sql/ddl.sql` completo (`psql … -f`): también es idempotente (probado dos veces seguidas sobre una base creada con el DDL viejo), pero sus `ALTER TABLE … ADD CONSTRAINT` toman `ACCESS EXCLUSIVE` y revalidan todas las filas: en una tabla grande bloquea lecturas y escrituras lo que dure el escaneo.
3. **Ventana.** Nunca con el servicio recibiendo tráfico sin ventana acordada: aun el bloque mínimo espera el bloqueo de cualquier transacción abierta sobre esas tablas y, mientras espera, encola a las demás. Hacerlo con `SET lock_timeout = '3s'` antes del `BEGIN` y reintentar si vence; con el despliegue en `live`, dentro de la ventana de mantenimiento y con el servicio fuera de rotación (la readiness ya lo mantiene fuera mientras falte el guardián).
4. **Después de aplicar**, `GET /health/ready` → `checks.append_only_guards: { "ok": true, "missing": [] }` y 200, sin reiniciar el servicio (la consulta se hace en cada sondeo). Sin ese resultado no se da el despliegue por bueno.
5. Probado con las bases creadas con el DDL anterior a ola 5 (`git show b6f398c~:services/<svc>/sql/ddl.sql`): en `live` readiness **503** con los `missing` de la tabla de arriba; en sandbox **200** con `ok:false`; tras aplicar el bloque (y tras el `ddl.sql` completo, dos veces) **200** con `ok:true`. Salida literal: `docs/trabajo/ola-5/P2/evidencia/FD1-ddl-viejo-prueba.txt`. Suites: `services/pay-{ledger,settlement,vault,connectors}/test/append-only-guards.readiness.spec.ts`.

### 7.2 Endpoint de Svix deshabilitado por el reconciliador (F-B1)

Tras restaurar la base de `pay-webhooks` a un punto anterior, los endpoints que los comercios dieron de alta **después** de ese punto siguen en Svix (con la marca `pay_owner`) pero ya no tienen fila local: el reconciliador los ve como huérfanos. Desde ola 5 los **deshabilita** (`PATCH disabled:true`, reversible) pasada la gracia, con un log `alert: true` por endpoint y `GET /health/ready` → `delivery_engine.orphan_guard` (`action`, `disabled_total`, `held_disabled`). El endpoint, su URL y su secreto siguen en Svix: **no se perdió nada**. El borrado (`WEBHOOKS_SVIX_ORPHAN_ACTION=delete`) es opt-in, irreversible, y bajo `live` exige `WEBHOOKS_SVIX_ORPHAN_DELETE_ACK=irreversible`.

Cómo se reactiva uno que es legítimo (probado: `services/pay-webhooks/test/svix/svix-reconciler-orphan-action.spec.ts`):

1. **Confirmar que es legítimo**: `GET /api/v1/app/<mc_…>/endpoint` en Svix; el endpoint lleva `metadata.pay_owner = <su namespace>` y `disabled: true`; la URL es la del comercio.
2. **Liberarlo y reactivarlo en UN solo `PATCH`** (Svix **reemplaza** los metadatos, por eso se reenvía `pay_owner`):
   ```bash
   curl -sS -X PATCH "$SVIX_URL/api/v1/app/<mc_…>/endpoint/<we_…>" -H "Authorization: Bearer $SVIX_TOKEN" -H 'Content-Type: application/json' \
     -d '{"disabled": false, "metadata": {"pay_owner": "<WEBHOOKS_SVIX_NAMESPACE>", "pay_orphan_review": "released"}}'
   ```
   La marca `pay_orphan_review=released` hace que el reconciliador lo ignore (`orphansReleased`) mientras se re-adopta. **Sin ella, un `disabled:false` suelto se vuelve a deshabilitar en la siguiente pasada** (probado). Desde este paso la entrega queda restablecida: el siguiente evento del comercio llega al endpoint, firmado con el secreto que el comercio ya tenía.
3. **Re-adoptar**: volver a insertar su fila para que el servicio lo gestione (rotar, listar, borrar). Las columnas salen del propio endpoint de Svix (`url`, `eventTypes`) y de la clave (`whsec_` ⇒ `v1`, `whpk_` ⇒ `v1a`): `INSERT INTO webhook_endpoints (id, merchant_id, url, enabled_events, signature_scheme) VALUES ('<we_…>', '<mc_…>', '<url>', ARRAY['<tipo>', …], 'v1');` (el `id` es el `uid` del endpoint en Svix). Con la fila presente, el reconciliador lo trata como a cualquier endpoint; la marca `released` queda inofensiva.
4. **Lo que NO se recupera solo**: los eventos del comercio publicados mientras el endpoint estuvo deshabilitado **no** se entregan después. Svix no encola mensajes para un endpoint deshabilitado (medido: `GET …/msg/<id>/endpoint` vacío) y `POST …/endpoint/<id>/recover` sobre uno deshabilitado responde 202 pero lo deja deshabilitado. Tras reactivarlo, un mensaje concreto se reenvía con `POST …/msg/<msg_…|eventId>/endpoint/<we_…>/resend` (202, probado), siempre que Svix tenga el mensaje; si el servicio no lo publicó (la tabla local no conocía el endpoint, DT-31) hay que re-publicar el evento desde su stream de NATS.
5. **Si era un alta revertida de verdad** (no hay comercio que lo reclame), se borra a mano: `DELETE $SVIX_URL/api/v1/app/<mc_…>/endpoint/<we_…>`.

Limitación (F-B4): el reconciliador solo recorre los comercios con **al menos un endpoint local**. Los huérfanos de un comercio sin ninguno no se miran y siguen vivos, recibiendo eventos de ese comercio; tras una restauración que deje a un comercio sin filas, listar sus aplicaciones en Svix y deshabilitar o borrar a mano. Limitación (F-B5): dos despliegues con el MISMO `WEBHOOKS_SVIX_NAMESPACE` sobre un Svix compartido (p. ej. una copia de producción en staging que conserva el valor) no se distinguen; solo se impide `live == sandbox`. **Cambiar el namespace al clonar un entorno** es obligatorio; una marca por despliegue (id del clúster de base) lo cerraría y no está hecha.

### 7.3 Consumidores NATS sin tope de entregas (F-B2)

Medido contra nats-server 2.10.29: con `max_deliver: N` el mensaje deja de entregarse al consumidor tras N entregas, **queda en el stream**, el consumidor lo da por no pendiente (`num_ack_pending: 0`, `ack_floor` atrás) y solo sale un aviso `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumidor>` que nadie escuchaba. Los consumidores de `pay-webhooks`, `pay-payments`, `pay-settlement`, `pay-edge` y `pay-schedules` pasaron a **`max_deliver: -1`** con espera creciente fijada por el código (2 s, 4 s, … tope 5 min según `deliveryCount`). Los eventos definitivamente inservibles se siguen descartando con `term`; un evento que lleva ≥ 10 entregas fallidas deja un log `alert: true` con `delivery_count`.

- **Migración de un durable existente**: al arrancar, cada servicio compara y, si el durable tiene la configuración vieja, lo actualiza (`consumers.update`; no mueve la posición del consumidor) y lo registra (`Consumidor migrado a entrega sin tope`). No hace falta recrear nada. (`consumers.add` sobre un durable con otra configuración falla con `consumer already exists` 10148: por eso se mira antes.)
- **Eventos que YA se habían varado** con el tope anterior no se reviven al subir el tope. Si el log de la migración dice `possibly_stranded` (el `ack_floor` atrás sin pendientes), reprocesar: parar el servicio, `nats consumer rm <STREAM> <durable>` y volver a arrancarlo; el durable se recrea con `deliver_policy: all` y reproduce el stream entero. Es seguro porque todos estos consumidores son idempotentes (inbox por `(consumidor, evento)`), pero el volumen depende de la retención del stream.
- `backoff` del servidor **no se usa**: se midió que, con `backoff` configurado, `nak(retardo)` solo vale para la primera reentrega (las siguientes esperan los intervalos del `backoff`) y un `nak()` sin retardo reentrega en caliente (14 529 entregas en 4 s).
