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

Arranque medido en la corrida de humo (`evidencia/e2e-smoke.txt`); variables de `evidencia/e2e-envprobe-2d.txt` (re-corrida de la tanda 2d)
(se quitó UNA variable a la vez de un entorno que sí arranca y se clasificó: `falla_rapido` = el proceso muere,
`vivo_no_sano` = vive pero `/health/ready` ≠ 200, `arranca` = tiene valor por defecto o es opcional).

| Servicio (carril) | ¿Arranca? | Listo en | Sin estas variables NO arranca (`falla_rapido`) | Con valor por defecto u opcionales (`arranca`) | Quién corrige lo que falta |
|---|---|---|---|---|---|
| `pay-ledger` (P2) | Sí | 4223 ms | `DB_*`, `PAY_MODE`, `TB_ADDRESS` | `LEDGER_ID_NAMESPACE`, `LOG_LEVEL`, `NATS_URL`, `TB_CLUSTER_ID` | ninguno (la guardia de `live` se ocupa de dobles del motor; con TigerBeetle real arranca en live, ver § PAY_MODE) |
| `pay-risk` (P5) | Sí | 4103 ms | `DB_*`, `PAYER_HASH_KEY`, `PAY_MODE`, `SANCTIONS_DENY_SCORE`, `SANCTIONS_REVIEW_SCORE`, `WATCHMAN_URL` | `LOG_LEVEL`, `NATS_URL` | P3+P5: con `payments` el intento termina `risk_denied` (hallazgo 2) |
| `pay-qr` (P4) | Sí | 2954 ms | `DB_*`, `PAY_MODE`, `QR_ACCOUNT_GUID` | `LOG_LEVEL`, `NATS_URL` | ninguno |
| `pay-vault` (P3) | Sí | 3398 ms | `DB_*`, `PAY_MODE`, `VAULT_BACKEND` | `LOG_LEVEL`, `NATS_URL` | ninguno |
| `pay-merchants` (P5) | Sí | 3859 ms | `DB_*`, `PAY_MODE` | `KYC_STORE_DIR`, `LOG_LEVEL`, `NATS_URL` | P5: no hay forma de dar de alta al primer comercio (hallazgo 1) |
| `pay-webhooks` (P1) | Sí | 2008 ms | `DB_*`, `PAY_MODE`, `WEBHOOKS_SECRET_KEK` | `LOG_LEVEL`, `NATS_URL`, `WEBHOOKS_POLL_INTERVAL_MS`, `WEBHOOKS_RETRY_JITTER_PERCENT`, `WEBHOOKS_SANDBOX_CA_FILE`, `WEBHOOKS_SANDBOX_TARGETS` | P1 (`WEBHOOKS_ENGINE`: en live no arranca, ver § PAY_MODE) |
| `pay-connectors` (P4) | Sí | 1540 ms | `DB_*`, `PAY_MODE` | `BANK_TRANSFER_ACCOUNT_HOLDER`, `BANK_TRANSFER_ACCOUNT_NUMBER`, `BANK_TRANSFER_BANK_NAME`, `LOG_LEVEL`, `NATS_URL`, `PAY_QR_URL`, `PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET`, `POLLER_INTERVAL_MS`, `POLLER_MIN_AGE_MS` | ninguno (los `BANK_TRANSFER_*` ya son opcionales; `POLLER_*` fijados por el arnés) |
| `pay-payments` (P3) | Sí | 3991 ms | `DB_*`, `CONNECTORS_URL`, `LEDGER_URL`, `PAY_MODE`, `RISK_URL` | `LOG_LEVEL`, `NATS_URL`, `RISK_ALLOW_BELOW_THRESHOLD`, `RISK_FAIL_CLOSED_THRESHOLD_MINOR`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_RUN_WORKER`, `TEMPORAL_TASK_QUEUE`, `VAULT_URL` | P3: errores de apagado de Temporal (hallazgo 3); `VAULT_URL` no figura en `.env.example` |
| `pay-settlement` (P2) | Sí | 1699 ms | `DB_*`, `CONNECTORS_URL`, `LEDGER_URL`, `OPERATOR_TOKEN_AUDIENCE`, `OPERATOR_TOKEN_ISSUER`, `OPERATOR_TOKEN_PUBLIC_KEY`, `PAY_MODE` | `LOG_LEVEL`, `NATS_URL`, `SETTLEMENT_MODE`, `SETTLEMENT_TRANSFER_CONNECTOR` | ninguno |
| `pay-schedules` (P5) | Sí | 1717 ms | `DB_*`, `LEDGER_URL`, `PAY_MODE`, `RETRY_DELAYS_SECONDS` | `LOG_LEVEL`, `NATS_URL` | P5: sin cliente de `pay-payments` (hallazgo 4) |
| `pay-edge` (P1) | Sí | 1268 ms | `DB_*`, `PAY_MODE`, `REDIS_URL`, `UPSTREAM_PAY_LEDGER_URL`, `UPSTREAM_PAY_MERCHANTS_URL`, `UPSTREAM_PAY_PAYMENTS_URL`, `UPSTREAM_PAY_SCHEDULES_URL`, `UPSTREAM_PAY_SETTLEMENT_URL`, `UPSTREAM_PAY_WEBHOOKS_URL` | `LOG_LEVEL`, `NATS_URL`, `RATE_LIMIT_PREFIX` | ninguno |

Notas de lectura: `DB_PORT` (en `DB_*` de la columna 4 aparece junto a las demás: sin ella el servicio cae a 5432, que no es la base del arnés ⇒ `vivo_no_sano` o `falla_rapido`; es un efecto del entorno de la prueba, no un defecto). **`PAY_MODE` es obligatorio en los 11** (ya no hay filas con valor por defecto). `NATS_URL` y `LOG_LEVEL` tienen valor por
defecto en todos.

**Ajustes del entorno del arnés (propuesta de P4):** `POLLER_MIN_AGE_MS=1000` y `POLLER_INTERVAL_MS=500` en `pay-connectors` (en `e2e/lib/services.ts`): la consulta de estado de los
cobros pendientes (callback perdido) corre en segundos y no a los 15/30 s por defecto. Efecto en las pruebas: el poller puede revelar un cobro «…05» antes que la consulta explícita; `connector-callbacks.e2e.ts`
ya no afirma que siga pendiente y afirma lo que importa (sin callback, un solo evento). `pay-payments` además usa `STATUS_INQUIRY_MS=1000` solo en E2.

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
5. **`PAY_MODE` (2d)** — resuelto en lo esencial; queda una nota de lectura.
   - **Explícito en los 11, sin valor por defecto ni tolerancia a variantes:** `e2e/flows/pay-mode-required.e2e.ts` arranca los 11 con el modo ausente, vacío, `prod` y `LIVE`; ninguno queda sano
     (`evidencia/e2e-full-2d.txt`). La re-corrida de variables (`e2e-envprobe-2d.txt`) confirma que quitar `PAY_MODE` mata el proceso en los 11.
   - **Bajo `live` con el entorno de sandbox del arnés** (`flows/live-guard.e2e.ts`; mensajes literales en `evidencia/live-guard-mensajes.txt`): se niegan a arrancar y nombran `PAY_MODE=live`
     **9 de 11 — `pay-vault`, `pay-merchants`, `pay-webhooks`, `pay-connectors`, `pay-payments`, `pay-settlement`, `pay-edge`, `pay-qr`, `pay-risk`** — más `pay-schedules` cuando se le pone `DISABLE_BACKGROUND_JOBS=1`.
   - **`pay-webhooks` (2d):** el motor de entrega propio (`InProcessEngine`) es un doble de Svix. `WEBHOOKS_ENGINE=inprocess|svix`: en sandbox es opcional (por defecto `inprocess`); bajo `live` es obligatorio y **no hay valor que arranque**:
     sin declarar ⇒ «exige declarar WEBHOOKS_ENGINE»; `inprocess` ⇒ «es el doble de Svix»; `svix` (en cualquier modo) ⇒ «el motor real no está implementado». Probado en configuración (`health.spec`) y arrancando el proceso (`live-guard`).
     Consecuencia: hasta que exista `SvixEngine`, `pay-webhooks` no puede correr en live.
   - **Por qué arrancan en live `pay-ledger` y `pay-schedules` (única diferencia con el pedido «10 de 11»):** ninguno recibe un doble en el entorno del arnés. `pay-ledger` usa un TigerBeetle REAL
     (privado por corrida) y su guardia (`assertDeploymentSafe`) solo rechaza motores que no se declaren reales; `pay-schedules` no embebe ningún doble (su libro mayor es `pay-ledger` por HTTP) y su guardia cubre
     interruptores de prueba (`DISABLE_BACKGROUND_JOBS=1`, probado). Por eso, medido con el entorno de sandbox tal cual, se niegan 9 de 11; con el interruptor de pruebas puesto, 10 de 11; solo `pay-ledger` arranca en live
     de forma legítima. Si se quisiera que `pay-schedules` se negara con el entorno de sandbox tal cual, el arnés tendría que inyectarle un interruptor de pruebas que hoy no usa (decisión de P5/coordinador).
6. **`pay-edge`: aviso `LegacyRouteConverter`** — **resuelto** (P1). Venía del comodín `*` por defecto de `nestjs-pino` combinado con el prefijo `/v1`
   («Unsupported route path: /v1/*»); se declara `forRoutes: [{ path: '{*path}' }]`. Comprobado: el arranque ya no emite el aviso. La plantilla no tiene prefijo, no se ve afectada.
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

## D-32 — claves de un comercio cerrado (2c)

`pay-merchants` ya publica `merchant.closed` y un `api_key.revoked` por clave viva al cerrar; suspender solo publica `merchant.suspended`.
`pay-edge` (cambio de esta tanda): `closed` ⇒ **401** (clave revocada, indistinguible de una inexistente); `suspended` ⇒ **403 `merchant_suspended`** (reactivable);
`merchant.closed` además revoca en la réplica todas las claves que conoce del comercio y gana aunque llegue con un instante anterior (cerrado es terminal);
una clave que llegue DESPUÉS del cierre tampoco sirve. El comportamiento anterior (cerrado ⇒ 403) cambió por decisión del dueño: la aserción de
`test/authz.spec.ts` se dividió en suspendido (403, reactivable) y cerrado (401), sin quitar ninguna comprobación.
Pruebas en tres niveles — correcto / límite / inválido: `services/pay-edge/test/replica.spec.ts` § D-32 (NATS, Postgres y Redis reales, 14 casos) y
`e2e/flows/key-lifecycle.e2e.ts` (6 casos con procesos reales; la acción del operador es un [DOBLE] que hace lo mismo que `MerchantsService`). Tiempos medidos: ver `evidencia/`.

## Pendientes (`yarn e2e:pending`, fuera de la suite por defecto)

| Archivo | Qué prueba | Qué lo bloquea hoy | Quién | Se pasa a `flows/` cuando |
|---|---|---|---|---|
| `e2e/pending/e1.e2e.ts` | E1: alta (siembra [DOBLE]) → `sk_test_` → cobro QR de Bs 100 → callback del conector `mock` → `succeeded` → ledger con 97,00 en `merchant:X:pending` y 3,00 en `platform:fees`, débitos = créditos, `GET /v1/balance` y un `payment_intent.succeeded` al comercio | D-29/D-30: el intento termina `failed` con `risk_denied` (medido: `last_error.code = risk_denied`); `pay-payments` no manda el nombre del comercio a `pay-risk` y `pay-risk` contesta `review` (`screening_not_provided`) | P3 + P5 (2c) | el intento llega a `succeeded` |
| `e2e/pending/e2.e2e.ts` | E2 por la API pública: callback duplicado (…03), fuera de orden (…04) y perdido que resuelve la consulta de estado (…05, `STATUS_INQUIRY_MS=1000`): un solo `succeeded`, un solo asiento | el mismo `risk_denied` | P3 + P5 (2c) | ídem |

**Mover E1/E2 a la suite por defecto (un solo cambio mecánico, sin editar contenido):**

```bash
git mv e2e/pending/e1.e2e.ts e2e/flows/e1.e2e.ts
git mv e2e/pending/e2.e2e.ts e2e/flows/e2.e2e.ts      # o: git mv e2e/pending/*.e2e.ts e2e/flows/
```

Las rutas relativas (`../lib/…`, `../stack.ts`) son iguales en `pending/` y en `flows/`, y `e2e/tsconfig.json` ya tipa las dos carpetas. `yarn e2e` recoge `flows/**/*.e2e.ts` sin tocar nada.
`yarn e2e:pending` ya corre con `--passWithNoTests`: con la carpeta vacía termina en 0 («No tests found, exiting with code 0», comprobado). Comprobado también copiando un archivo a `flows/` (jest lo lista y `tsc` pasa).
Los encabezados de ambos archivos dicen cuándo y cómo moverlos; después del `git mv` se puede borrar ese párrafo si se quiere.
Condición para moverlos: que el intento llegue a `succeeded` (P3: nombre del comercio en el cribado y `payer_name`; P5: `legal_name` en los eventos y `screening_not_provided`). Correr `yarn e2e:pending` antes de mover.

Lo que ya está probado hoy, contra los servicios REALES, de los mismos flujos (dentro de la suite por defecto):
`flows/ledger-capture.e2e.ts` (el asiento exacto que manda `recordLedger`: 97,00/3,00, partida doble, idempotencia, `insufficient_funds`, 403 por identidad/modo/matriz) y
`flows/connector-callbacks.e2e.ts` (…00, …03, …04, …05 y callback sin firma, hasta el evento del bus, un solo evento por cobro). Lo que NO está probado es el tramo del medio
(`pay-payments` consume el evento, asienta en el ledger y cierra el intento) porque hoy el riesgo lo deniega antes.
Una suposición sin verificar en E1/E2: que el intento exponga `succeeded_at` y que `GET /v1/balance` muestre `pending_minor = net_minor` (están en el contrato público; no se vieron correr).

## No cubierto

- Svix real (el motor de entrega es el propio, declarado DOBLE de Svix).
- Dinero real, cuenta recaudadora, conector bancario real (modo B es un doble; T-03).
- Cobro exitoso de punta a punta (hallazgo 2; E1/E2 escritos, en `e2e/pending/`) y las rutas de `schedules → payments` (hallazgo 4).
- El onboarding real del comercio (hallazgo 1).
- Aislamiento de red del `pay-vault` (P1.H4.M3, ola 3).
- Carga/concurrencia: el arnés corre con 1 worker.
- Cross-browser / visual: no aplica.

## Riesgos residuales

- El TigerBeetle privado preasigna ~1,2 GB en `e2e/.run/<runId>/`; se borra al apagar, pero un `kill -9` del
  proceso del arnés lo deja (se limpia con `yarn e2e:down` o `rm` del directorio).
- `pg`, `nats`, `yaml` y `@types/pg` quedaron declarados en `devDependencies` del `package.json` raíz (mismos rangos que los servicios, así que no
  hay resoluciones nuevas). **`yarn.lock` NO se actualizó** (pedido del coordinador: solo cuando avise que no hay otros agentes): hasta entonces
  `yarn install --immutable` fallaría por el lock desactualizado. Falta correr `yarn install` y revisar que el diff del lock solo toque el bloque del workspace raíz.
