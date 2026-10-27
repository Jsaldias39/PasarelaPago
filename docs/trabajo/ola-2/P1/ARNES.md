# Arnés de integración real (ola 2, tanda 2b)

> Qué es: `e2e/` levanta los 11 servicios reales (`node dist/main.js`) contra la infraestructura de
> `platform/compose.yml` + un TigerBeetle privado, con `PAY_MODE=sandbox` y el conector `mock`, y
> ejecuta contra ellos el humo y el primer flujo e2e real (E6). Nada de dinero real, nada de datos reales:
> todos los secretos se generan sintéticos en cada corrida.

Peldaño de evidencia: **VERIFIED** para el arnés y el flujo E6 (camino real, base real, NATS real, consola y
red revisadas); `VERIFIED_FUNCTIONAL_ONLY` no aplica (no hay superficie visual). No se afirma «sin regresiones»
más allá de lo que listan las salidas de `evidencia/`.

## Cómo se usa

```bash
yarn e2e:up        # levanta el stack y deja la tabla de servicios; Ctrl+C lo apaga
yarn e2e:down      # apaga lo que haya registrado en e2e/.run/state.json (por PID verificado)
yarn e2e:boot      # arranca, espera /health/ready de los 11 y apaga
yarn e2e:smoke     # arranca, corre el humo (salud + internas + controles + borde) y apaga
yarn e2e           # jest: humo, degradado, E6 y las pruebas unitarias del arnés (1 worker)
yarn e2e:typecheck # tsc del arnés
node --no-warnings e2e/cli.ts envprobe   # quita UNA variable por servicio y clasifica el arranque
```

Requisitos: la infra de Compose arriba (Postgres 54321, NATS 54222, Redis 54379, Temporal 54233, Watchman 54084)
y los `dist/` construidos (`yarn workspaces foreach … build`). Un solo stack a la vez: si existe
`e2e/.run/state.json` el arnés se niega a arrancar otro.

Lo que hace al arrancar (en este orden, sin esperas de tiempo fijo; todo espera por condición):

1. Comprueba la infra por TCP; asigna puertos libres (11 servicios + receptor HTTPS del comercio + TigerBeetle).
2. Borra los streams `PAY_*` y reinicia cada base: `DROP SCHEMA public CASCADE` + DDL de
   `contracts/packages/{outbox,idempotency}/sql` y de `services/<svc>/sql` aplicado con el rol del servicio
   (los servicios no aplican DDL al arrancar).
3. Formatea y arranca un **TigerBeetle privado** (binario cacheado en `e2e/.run/bin`, archivo de datos propio,
   `LEDGER_ID_NAMESPACE=<runId>`); no toca el TigerBeetle compartido de Compose, que flapea con otros agentes.
4. Arranca por olas de dependencias: `ledger, risk, qr, vault, merchants, webhooks` → `connectors` →
   `payments` → `settlement, schedules` → `edge`; espera `GET /health/ready == 200` de cada uno y aborta la espera
   si el proceso muere (guarda la cola del log).
5. Al apagar: SIGTERM y luego SIGKILL **por PID** (verificando `/proc/<pid>/cwd`), borra el archivo de datos de
   TigerBeetle, reinicia las bases y borra los streams. Informa `leftoverPids`.

## Matriz por servicio

Arranque medido en la corrida de humo (`evidencia/e2e-smoke.txt`); variables de `evidencia/e2e-envprobe.txt`
(se quitó UNA variable a la vez de un entorno que sí arranca y se clasificó: `falla_rapido` = el proceso muere,
`vivo_no_sano` = vive pero `/health/ready` ≠ 200, `arranca` = tiene valor por defecto o es opcional).

| Servicio (carril) | ¿Arranca? | Listo en | Variables sin las que NO arranca (`falla_rapido`) | Con valor por defecto / opcionales (`arranca`) | Quién corrige lo que falta |
|---|---|---|---|---|---|
| `pay-ledger` (P2) | Sí | 4223 ms | `DB_*`, `TB_ADDRESS` | `TB_CLUSTER_ID`, `LEDGER_ID_NAMESPACE`, `PAY_MODE` | P2: **no lee `PAY_MODE`** (solo valida el modo de la clave); sin guardia de despliegue |
| `pay-risk` (P5) | Sí | 4103 ms | `DB_*`, `WATCHMAN_URL`, `PAYER_HASH_KEY`, `SANCTIONS_DENY_SCORE`, `SANCTIONS_REVIEW_SCORE` | `PAY_MODE` | P5: no lee `PAY_MODE`; con `payments` las decisiones `review` se tratan como `deny` (ver hallazgo 2) |
| `pay-qr` (P4) | Sí | 2954 ms | `DB_*`, `PAY_MODE`, `QR_ACCOUNT_GUID` | — | ninguno |
| `pay-vault` (P3) | Sí | 3398 ms | `DB_*`, `VAULT_BACKEND` | `PAY_MODE` (por defecto `sandbox`; `fake` se niega con `live`) | ninguno |
| `pay-merchants` (P5) | Sí | 3859 ms | `DB_*` | `KYC_STORE_DIR`, `PAY_MODE` | P5: **no hay forma de dar de alta al primer comercio** (hallazgo 1); no lee `PAY_MODE` |
| `pay-webhooks` (P1) | Sí | 2008 ms | `DB_*`, `PAY_MODE`, `WEBHOOKS_SECRET_KEK` | `WEBHOOKS_POLL_INTERVAL_MS`, `WEBHOOKS_RETRY_JITTER_PERCENT`, `WEBHOOKS_SANDBOX_TARGETS`, `WEBHOOKS_SANDBOX_CA_FILE` | P1 (resuelto en esta tanda: prefijo `/v1` y destinos sandbox) |
| `pay-connectors` (P4) | Sí | 1540 ms | `DB_*`, `PAY_MODE`, `BANK_TRANSFER_ACCOUNT_HOLDER`, `BANK_TRANSFER_ACCOUNT_NUMBER`, `BANK_TRANSFER_BANK_NAME` | `PAY_QR_URL`, `PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET` | P4: los tres `BANK_TRANSFER_*` son obligatorios aun con el conector `mock` (documentar en `.env.example`) |
| `pay-payments` (P3) | Sí | 3991 ms | `DB_*`, `RISK_URL`, `CONNECTORS_URL`, `LEDGER_URL` | `VAULT_URL`, `TEMPORAL_*`, `RISK_*`, `PAY_MODE` | P3: `VAULT_URL` falta en `.env.example`; no lee `PAY_MODE`; errores de apagado (hallazgo 3) |
| `pay-settlement` (P2) | Sí | 1699 ms | `DB_*`, `LEDGER_URL`, `CONNECTORS_URL`, `OPERATOR_TOKEN_ISSUER`, `OPERATOR_TOKEN_AUDIENCE`, `OPERATOR_TOKEN_PUBLIC_KEY` | `SETTLEMENT_MODE`, `SETTLEMENT_TRANSFER_CONNECTOR`, `PAY_MODE` (por defecto `sandbox`) | ninguno |
| `pay-schedules` (P5) | Sí | 1717 ms | `DB_*`, `LEDGER_URL`, `RETRY_DELAYS_SECONDS` | `PAY_MODE` | P5: no tiene cliente de `pay-payments` (hallazgo 4); no lee `PAY_MODE` |
| `pay-edge` (P1) | Sí | 1268 ms | `DB_*`, `PAY_MODE`, `REDIS_URL`, seis `UPSTREAM_PAY_*_URL` | `RATE_LIMIT_PREFIX` | P1: `LegacyRouteConverter` avisa en el arranque (hallazgo 6) |

Notas de lectura: `DB_PORT` figura `vivo_no_sano` en todos porque el puerto por defecto (5432) existe pero no es la
base del arnés; es un efecto del entorno de la prueba y no un defecto. `NATS_URL` y `LOG_LEVEL` tienen valor por
defecto en todos.

## Humo (`yarn e2e:smoke`)

Última corrida registrada: **salud 22/22 · internas 52/52 · controles negativos 7/7 · borde 20/20, sin fallas**
(`evidencia/e2e-smoke.txt`; la corrida final completa (34 pruebas, 4 suites) está en `evidencia/e2e-full.txt` y los gates de cierre en `evidencia/gates-2b.txt`).

- **Internas:** cada operación declarada en los contratos que un servicio consume de otro
  (`payments→ledger/connectors/risk/vault`, `settlement→ledger/connectors`, `schedules→ledger/payments/settlement`,
  `connectors→vault/qr`, `payments→settlement`) se invoca con `X-Service-Id` del consumidor y `X-Pay-Mode`.
  Clasificación: 401/403 → `FALLA_IDENTIDAD`; ≥500 → `FALLA_5XX`; 404 en una operación sin parámetros de ruta →
  `RUTA_AUSENTE`; sin respuesta → `INALCANZABLE`. Un 404 en una operación con identificador se acepta (el recurso
  no existe; es ambiguo por diseño y la existencia de la ruta la cubre cada contrato).
- **Controles negativos:** un `X-Service-Id` ajeno debe recibir 403.
- **Borde:** las operaciones públicas se invocan con una llave `sk_test_` real creada por `pay-merchants`.

## Hallazgos (no corregidos en carpetas ajenas)

1. **`pay-merchants` no puede dar de alta al primer comercio** — P5 / identidad del operador.
   El autenticador de operador es `DenyAllOperatorAuthenticator` y no hay configuración que lo cambie. El arnés lo
   resuelve con una **siembra sandbox declarada como DOBLE del onboarding**: inserta comercio, KYC, contrato, tarifa
   y `api_keys` en `pay_merchants` y publica los eventos `merchant.created`, `merchant.activated`,
   `fee_schedule.published` y `api_key.created` por el outbox real; el relay de merchants los envía y la réplica del
   borde aprende la llave. Lo que falta verificar contra lo real: el alta por la API de operador, cuando exista.
2. **Los pagos siempre se deniegan** — P3 + P5. `pay-payments` no envía el bloque de *screening* y trata `review`
   como `deny`; `pay-risk` responde `review` con `screening_not_provided`. Con el arnés, toda intención llega a
   `denied`. El flujo E6 no necesita pagos exitosos (los eventos de intento denegado también se entregan), pero el
   flujo feliz de cobro no es ejercitable hasta que P3 y P5 acuerden el contrato (¿quién arma el *screening*?).
3. **Apagado de `pay-payments`** — P3. Al recibir SIGTERM registra `IllegalStateError: Not running` (worker de
   Temporal que se apaga dos veces). No afecta el cierre del proceso, sí ensucia el log.
4. **`pay-schedules` no tiene cliente de `pay-payments`** — P5/P3. El plan de llamadas del contrato lo declara;
   el humo lo ejercita directo contra `pay-payments`, pero el servicio no lo consume todavía.
5. **`PAY_MODE` se maneja distinto en cada servicio** — cada carril; la política de guardia la fija P1.
   Exigen valor explícito: `connectors`, `edge`, `qr`, `webhooks`. Por defecto `sandbox` y rechazan `live` con
   dobles: `settlement`, `vault`. **No lo leen:** `ledger`, `merchants`, `payments`, `risk`, `schedules`. Propuesta
   (decisión pendiente de P1/coordinador): que los 11 lo exijan explícito y se nieguen a arrancar con dobles
   declarados bajo `live`.
6. **`pay-edge`: advertencia `LegacyRouteConverter`** en el arranque — P1 (mía; es de la plantilla de rutas de Nest,
   no afecta al comportamiento).
7. **`.env.example` inconsistentes** — P3/P5: valores por defecto de URL distintos entre `payments` y `schedules`,
   y `VAULT_URL` ausente en el de `payments`. El arnés no depende de ellos (construye el entorno desde cero).
8. **Reintentos benignos de arranque** en `schedules` y `webhooks` mientras la base/NATS terminan de estar listos.

## Cambios que esta tanda hizo en `pay-webhooks` (servicio de P1)

- Se quitó el prefijo global `/v1`: el borde reenvía rutas **sin** prefijo y el servicio respondía 404 (hallazgo real
  del arnés, invisible en los tests unitarios que añadían el prefijo ellos mismos).
- `WEBHOOKS_SANDBOX_TARGETS=127.0.0.1:<puerto>[,…]` y `WEBHOOKS_SANDBOX_CA_FILE`: permiten, **solo en sandbox**, que
  la guardia anti-SSRF acepte destinos de bucle local exactos (siguen exigiéndose HTTPS y sin credenciales; con
  `PAY_MODE=live` la configuración se niega a arrancar). Sin esto el comercio de prueba local sería inalcanzable.
  El resto de la guardia sigue bloqueando `127.0.0.1:9` y `169.254.169.254` (probado en E6).

## Flujo E6 (`e2e/flows/e6.e2e.ts`)

Con la API real del borde y una llave `sk_test_`: se registran dos endpoints de comercio (uno que cae, otro
sano); cuatro intenciones de pago generan eventos; el receptor permanece caído hasta observar ≥ 8 fallos; los
8 eventos se entregan **exactamente una vez** tras los reintentos (21 llegadas para 8 eventos); un endpoint que
responde 410 queda `disabled` con motivo `gone_410`, y una quinta intención solo llega al endpoint sano. Las firmas
Standard Webhooks v1 se verifican en el receptor. Salida literal: `evidencia/e6-e2e.txt`.

## No cubierto

- Svix real (el motor de entrega es el propio, declarado DOBLE de Svix).
- Dinero real, cuenta recaudadora, conector bancario real (modo B es un doble; T-03).
- Cobro exitoso de punta a punta (hallazgo 2) y las rutas de `schedules → payments` (hallazgo 4).
- El onboarding real del comercio (hallazgo 1).
- Aislamiento de red del `pay-vault` (P1.H4.M3, ola 3).
- Carga/concurrencia: el arnés corre con 1 worker.
- Cross-browser / visual: no aplica.

## Riesgos residuales

- El TigerBeetle privado preasigna ~1,2 GB en `e2e/.run/<runId>/`; se borra al apagar, pero un `kill -9` del
  proceso del arnés lo deja (se limpia con `yarn e2e:down` o `rm` del directorio).
- `pg`, `nats` y `yaml` los importa el arnés desde el `node_modules` raíz (hoisted); no están declarados en el
  `package.json` raíz. Declararlos es un cambio de dependencias que queda como decisión para el coordinador.
