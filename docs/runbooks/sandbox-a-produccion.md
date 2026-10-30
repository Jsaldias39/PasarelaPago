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
- **`pay-webhooks`:** `WEBHOOKS_ENGINE=svix` (con `inprocess` no arranca), `WEBHOOKS_SVIX_URL` https, `WEBHOOKS_SVIX_AUTH_TOKEN` (JWT) y **`WEBHOOKS_SVIX_NAMESPACE`** (obligatorio en live, distinto de `sandbox`, p. ej. `prod-bo`; es el dueño de los endpoints que este despliegue crea en Svix y lo único que el reconciliador se atreve a borrar: nunca compartas un mismo valor entre dos despliegues que usan el mismo Svix; los endpoints anteriores a la marca no se borran jamás). Opcionales con defecto seguro: `WEBHOOKS_SVIX_MAX_ORPHAN_DELETES=5` (si una pasada ve más huérfanos no borra ninguno y avisa; tras restaurar la base de `pay-webhooks`, `GET /health/ready` → `delivery_engine.orphan_guard.cap_trips` > 0 indica que el freno actuó: revisar a mano, no subir el tope) y `WEBHOOKS_SVIX_CLOCK_MARGIN_SECONDS=60`. En el servidor Svix: fijar `SVIX_MAIN_SECRET` **antes** de guardar la primera clave (no se puede cambiar después; sin él las claves de firma quedan sin cifrar en su base), `SVIX_JWT_SECRET` desde OpenBao, un proxy de salida (`SVIX_PROXY_ADDR`) sin ruta a la red interna, y las tres perillas de prueba (`SVIX_WHITELIST_NAMES`, `SVIX_DANGEROUS_DISABLE_TLS_VERIFICATION`, `SVIX_RETRY_SCHEDULE` corto) **cerradas**. Más: `docs/trabajo/ola-5/P1/INFORME.md`.
- **Imágenes:** en este entorno ghcr.io (TigerBeetle) y Docker Hub no sirven; `mirror.gcr.io` sirve OpenBao y Svix (`HUB=mirror.gcr.io`).
- **`pay-edge` y todos los que usan `@pay/idempotency` (revisión de seguridad S-02, S-06):** `IDEMPOTENCY_MASK_KEY` (≥ 32 bytes, secreto de despliegue, no la constante de desarrollo) y, en `pay-edge`, `TRUST_PROXY_HOPS` explícito. Sin ellos el servicio no arranca. Rotar `IDEMPOTENCY_MASK_KEY` cambia el valor guardado de una `Idempotency-Key` con forma de PAN: las filas vencen a las 24 h, así que solo se puede duplicar, dentro de esa ventana, el reintento de un comercio que pegó un PAN como clave (caso anómalo).
- **`pay-connectors` / OpenBao (S-08, S-09, S-10, S-18):** `OPENBAO_ADDR` no puede ser loopback, `OPENBAO_TOKEN` no puede empezar por `dev-only-` y `NODE_TLS_REJECT_UNAUTHORIZED=0` no puede estar en el entorno; `OPENBAO_CACHE_TTL_MS` ≤ 300 000 (5 min) y `OPENBAO_ROTATION_WINDOW_MS` ≤ 604 800 000 (7 días), en cualquier modo. Un código de conector no puede ser prefijo de otro delimitado por `_` (`mercantil` / `mercantil_qr`): el registro lo rechaza al arrancar. Un valor de secreto mal formado en OpenBao se descarta (el callback da 401, no 500) y no anula al bueno de un par de rotación; **para cerrar la ventana ante una filtración, borrá la versión N-1 en OpenBao** (la ventana solo se acorta así). Pendientes de la revisión: `docs/trabajo/ola-5/integracion/revision/PENDIENTES-SEGURIDAD.md`.
