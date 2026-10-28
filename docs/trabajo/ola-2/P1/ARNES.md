# Arnés de integración real (ola 2, tandas 2b a 2h)

> Qué es: `e2e/` levanta los 11 servicios reales (`node dist/main.js`) contra la infraestructura de
> `platform/compose.yml` + un TigerBeetle privado, con `PAY_MODE=sandbox` y el conector `mock`, y
> ejecuta contra ellos el humo y los flujos e2e reales (E1, E2, E6 y los de claves, degradado, `PAY_MODE` y capa sandbox). Nada de dinero real, nada de datos reales:
> todos los secretos se generan sintéticos en cada corrida. Desde la tanda 2h puede sumar `pay-mockbank` (servicio 12, banco simulado de la capa sandbox, D-26).

Peldaño de evidencia: **VERIFIED** para el arnés y los flujos E1, E2, E6 y la capa sandbox (camino real, base real, NATS real, consola y
red revisadas); `VERIFIED_FUNCTIONAL_ONLY` no aplica (no hay superficie visual). No se afirma «sin regresiones»
más allá de lo que listan las salidas de `evidencia/`. **No es `REGRESSION_VERIFIED`**: E1/E2 son sensibles a la carga de la máquina
(ver § Estado de E1 y E2 en la tanda 2h) y el reporte de cierre lo consolida el coordinador.

## Cómo se usa

```bash
yarn e2e:up        # levanta el stack y deja la tabla de servicios; Ctrl+C lo apaga (`-- --mockbank`: suma pay-mockbank, la capa sandbox completa)
yarn e2e:down      # apaga lo que haya registrado en e2e/.run/state.json (por PID verificado)
yarn e2e:boot      # arranca, espera /health/ready de los 11 (de 12 con --mockbank), calienta el camino de riesgo y apaga
yarn e2e:smoke     # arranca, corre el humo (salud + internas + controles + borde) y apaga
yarn e2e           # jest: humo, degradado, E1, E2, E6, claves, PAY_MODE, live-guard, alta real, nombres sintéticos, capa sandbox y las pruebas del arnés (1 worker, 14 suites, 80 pruebas)
yarn e2e:typecheck # tsc del arnés
node --no-warnings e2e/cli.ts envprobe   # quita UNA variable por servicio y clasifica el arranque
```

Requisitos: la infra de Compose arriba (Postgres 54321, NATS 54222, Redis 54379, Temporal 54233, Watchman 54084), **al menos 1,8 GiB de disco libre**
(el TigerBeetle privado preasigna ~1,1 GiB; sin espacio el arnés se niega con un mensaje `ENTORNO: …` en vez de dejar un archivo a medias) y los `dist/` construidos (`yarn workspaces foreach … build`). Un solo stack a la vez: si existe
`e2e/.run/state.json` el arnés se niega a arrancar otro.

Lo que hace al arrancar (en este orden, sin esperas de tiempo fijo; todo espera por condición):

1. Comprueba la infra por TCP; asigna puertos libres (11 servicios + receptor HTTPS del comercio + TigerBeetle).
2. Borra los streams `PAY_*` y reinicia cada base: `DROP SCHEMA public CASCADE` + DDL de
   `contracts/packages/{outbox,idempotency}/sql` y de `services/<svc>/sql` aplicado con el rol del servicio
   (los servicios no aplican DDL al arrancar).
3. Formatea y arranca un **TigerBeetle privado** (binario cacheado en `e2e/.run/bin`, archivo de datos propio,
   `LEDGER_ID_NAMESPACE=<runId>`); no toca el TigerBeetle compartido de Compose, que flapea con otros agentes.
4. Arranca por olas de dependencias: `ledger, risk, qr, vault, merchants, webhooks` → (`mockbank`, si se pidió) → `connectors` →
   `payments` → `settlement, schedules` → `edge`; espera `GET /health/ready == 200` de cada uno y aborta la espera
   si el proceso muere (guarda la cola del log).
5. **Calienta el camino de riesgo** (`lib/warmup.ts`, por condición): evalúa en `pay-risk` peticiones sintéticas hasta tener 3 seguidas con `screened: true` y
   `allow`, con tope de 90 s; informa `LISTO` o `NO LLEGÓ A LA RACHA` y la prueba corre igual (no se oculta un entorno saturado). Ver § Estado de E1 y E2.
6. Al apagar: SIGTERM y luego SIGKILL **por PID** (verificando `/proc/<pid>/cwd`), borra el archivo de datos de
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

1. **Alta del primer comercio** — **resuelto en lo esencial (2h)**; queda un paso doble. `pay-merchants` ya tiene su autenticador de operador (JWT RS256 con
   `OPERATOR_TOKEN_*`) y el arnés da de alta por la API real del back-office (`lib/seed.ts`, `onboardMerchant`; `flows/onboarding.e2e.ts`): crea el comercio, sube los 6
   documentos de KYC, aprueba, publica/acepta contrato, publica tarifario y activa; los eventos (con `legal_name`, D-33) salen del propio servicio por outbox, validados
   contra el AsyncAPI. La siembra directa en la base quedó como respaldo declarado (`seedMerchant(stack, { mode: 'sql' })`, DOBLE). **Único paso doble:** la PRIMERA
   clave `sk_test_` se pide a `POST /api_keys` de `pay-merchants` con la identidad de `pay-edge` y el `X-Merchant-Id` del comercio, porque el borde exige una clave para llegar a esa
   ruta y no hay otro camino para la primera. Pregunta abierta para P5 + P1: ¿quién emite la primera clave de un comercio recién activado (el back-office con su propia ruta)?
2. **Los pagos se denegaban siempre** — **resuelto (2h)**. P3 manda el nombre del comercio y el del pagador (`payer_name`, D-29) y P5 publica `legal_name`; con nombres sintéticos que
   no puntúan en Watchman (`flows/synthetic-names.e2e.ts` lo comprueba contra el Watchman real) el intento llega a `succeeded` (E1/E2). Persisten dos defectos de producto que
   aparecen cuando la evaluación de riesgo tarda más que su presupuesto: ver hallazgos 9 y 10.
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

9. **Un 409 `idempotency_request_in_progress` de `pay-risk` mata el intento** — PRODUCT_BUG de **P3** (`pay-payments`). `services/pay-payments/src/temporal/activities.ts:170`
   (`assessRisk`): `if (isRejection(error)) throw ApplicationFailure.nonRetryable('… RiskRejected')`. La llamada a `pay-risk` tiene `RISK_TIMEOUT_MS=300` (`src/config.ts:138`) y
   `HttpClient` reintenta una vez con la MISMA clave (`<pi>:risk`, `src/clients/risk.client.ts`). Si la primera evaluación sigue viva en `pay-risk`, el reintento recibe `409 idempotency_request_in_progress`
   (`contracts/packages/idempotency/src/index.ts:133`), que es «todavía no sé», y `pay-payments` lo toma como rechazo definitivo: el workflow termina `Workflow failed`
   y el intento queda **`processing` para siempre** (ni `failed` ni `succeeded`; el comercio nunca recibe un evento). Contradice `CLAUDE.md` regla 11 (un resultado ambiguo no es un fallo: se
   reintenta con la misma clave). Visto de verdad en E1 (`pay-payments.log`: `Activity failed … 409 idempotency_request_in_progress`, `Workflow failed`; intento `pi_1a72d49b631fe6c9e1824b6b` en
   `processing` 60 s, `evidencia/2h-e1-e2-tests.txt`). **Reproductor determinista:** `e2e/pending/risk-timeout.e2e.ts` (`RISK_TIMEOUT_MS=40`; `yarn e2e:pending`) — falla HOY dejando intentos en
   `processing` (`evidencia/2h-risk-timeout-reproductor-run1.txt`, `…-log.txt`). Arreglo propuesto: tratar 409 `idempotency_request_in_progress` como reintentable (con la misma clave) y que un workflow que
   muere deje el intento en un estado terminal con razón (hoy queda huérfano). **El arnés NO lo corrige** (carpeta de otro carril); solo evita que lo dispare la latencia del entorno (ver § Estado de E1 y E2).
10. **Una latencia de Watchman convierte a un comercio limpio en `risk_denied` de forma permanente** — PRODUCT_BUG de diseño de **P5** (`pay-risk`) combinado con D-30. `services/pay-risk/src/screening/watchman.screener.ts:45`
    cribra con `AbortSignal.timeout(200)` (tope configurable 250); un `TimeoutError` marca la parte como `unavailable` (`src/rules/engine.ts:72` → `screening_unavailable`, que está en `REVIEW_CODES`, línea 45), D-30 trata
    `review` como `deny`, y la decisión queda guardada bajo la clave de idempotencia (la repetición devuelve lo mismo). Resultado: un intento de un comercio SIN coincidencias termina `failed/risk_denied`
    por una lentitud pasajera de Watchman, sin posibilidad de reintentar. Mismo criterio de la regla 11 (una indisponibilidad del cribado es ambigua, no una condena). Visto en E1/E2 con la máquina cargada
    (`evidencia/2h-e1-e2-repeat.txt`; en `pay-risk.log`: `Watchman no pudo cribar` / `TimeoutError`). Opciones para P5/P3: no persistir como decisión un `screening_unavailable` (devolver 503 reintentable) o definir la cola de revisión de D-30.
11. **Ruido `Evento descartado … campo inválido: refund_id` en `pay-payments`** — observación para **P3/P4**. En el log de un stack recién creado (sin ningún reembolso) `pay-payments` descarta decenas de eventos
    `kind: refund` sin `refund_id` válido (`src/events/handlers.ts:29,57`). No afecta a E1/E2, pero indica que llegan eventos al bus compartido desde fuera del stack (otras pruebas en la misma NATS) o que
    algún productor emite `refund_id: null` (ver `contracts/asyncapi/connectors.yaml`, `refund_id` opcional). El arnés borra los streams `PAY_*` al empezar pero no puede aislar un NATS compartido.
12. **`p2-bank.ts` (P2) todavía no usa `pay-mockbank`** — P2. `payerTransfersToBank` sigue lanzando. Con esta tanda E8 puede pedir `startStack({ mockbank: true })` y depositar con
    `POST {pay-mockbank}/sandbox/payer/transfer-in` (ver § Capa sandbox).

13. **[RESUELTO en ola 3 por P4: `refunds.service.ts` (`provenUnsent`); reproductor en `e2e/flows/e3-fallo-definitivo.e2e.ts`; propuesta #17 de P3 opcional]** **Un fallo DEFINITIVO del conector (`502 connector_unavailable`) nunca se reconoce de punta a punta en un reembolso** — PRODUCT_BUG de **P3** (`pay-payments`, `src/clients/http.ts` `HttpClient.request`) con una pieza de diseño de **P4**
    (`pay-connectors`, `src/core/refunds.service.ts` `send`). Con el banco caído, el conector responde `502 connector_unavailable` con su cuerpo exacto (sin efecto garantizado). `HttpClient.request` reintenta TODO error de la dependencia, también ese 502,
    a los 50 ms y con la misma `Idempotency-Key`; el conector reabre el reembolso pero NO baja `may_have_reached_provider` (monótona a propósito), así que el segundo envío con el banco aún caído ya es AMBIGUO (500). `definitive502` ve el último error (500),
    no el 502: el workflow lo trata como ambiguo (regla 11) y NO anula la retención. Resultado medido: el reembolso queda `pending` con la retención viva mientras el banco esté caído (60 s en la prueba) y termina `succeeded` con UNA ejecución cuando vuelve.
    Es seguro en dinero, pero el camino `failed` + retención anulada que describe `RefundWorkflow` es hoy inalcanzable por esta causa. Riesgo no probado: si la caída dura más que `REFUND_HOLD_SECONDS` (7 días) la retención vence, el banco ejecutaría igual y `postHold` sobre una retención vencida fallaría.
    Evidencia: `evidencia/e3-hallazgo-fallo-definitivo.txt` (en `pay-connectors.log`, 502 y 72 ms después 500 con la misma clave), `evidencia/e3-pendiente-corrida.txt`. El contrato del conector SÍ se comprueba y pasa en `flows/e3.e2e.ts` (1ª orden 502, repetirla 500, vuelto el banco una sola ejecución).
    **Reproductor determinista:** `e2e/pending/e3-fallo-definitivo.e2e.ts` (`yarn e2e:pending`). Arreglo propuesto: que `HttpClient` no reintente un 5xx con cuerpo problem+json de error DEFINITIVO declarado (o que el conector devuelva el mismo 502 al repetir mientras la marca solo la haya puesto una orden sin efecto).
14. **[RESUELTO en ola 3 por P4: `dto.ts` (`VAULT_TOKEN`/`cardTokenLooksLikePan`); reproductor en `e2e/flows/e7-token-mockbank.e2e.ts`]** **`pay-mockbank` rechaza (422) un `card_token` legítimo con 12 dígitos decimales seguidos** — PRODUCT_BUG de **P4** (sandbox). `src/sandbox/dto.ts` `parseCardAuthorization`: `PAN_LIKE = /(?:\d[ -]?){12,19}/` sin anclar. Un token de la bóveda (`tok_` + 24 hexadecimales) tiene esa racha en el 1,99 % de los casos
    (3981 de 200000, `evidencia/e7-hallazgo-token-mockbank.txt`): ≈2 de cada 100 autorizaciones de tarjeta válidas fallan. Visto de verdad en la primera corrida de E7. **Reproductor:** `e2e/pending/e7-token-mockbank.e2e.ts`. E7 lo esquiva (descarta ese token y captura otra tarjeta) y lo declara.
15. **El tramo de tarjeta no está cableado de punta a punta** — observación para **P3/P4**. (a) `pay-connectors` no llama a la bóveda (`reveal`) ni usa el `card_token`: el conector `mock` lo ignora y responde `redirect_to_card_form` con una URL `sandbox.invalid`; los endpoints `card-authorizations` de `pay-mockbank` no los llama nadie.
    (b) `pay-payments` acepta cualquier `tok_…` aunque la bóveda no lo conozca (medido: 201 `requires_action` con un token inexistente). (c) `pay-vault` solo tiene el backend `fake` y ninguna ruta HTTP por la que un pagador entregue la tarjeta (`completeCapture` existe solo dentro del proceso).
    E7 lo suple con dobles declarados (campos alojados del PSP como precarga en el proceso de la bóveda; la prueba hace de `pay-connectors` para `reveal` y la autorización/captura en el banco simulado). Queda abierto cuando exista el backend real (D-17).

16. **Ola 4 — paridad y siembra** — P1. (a) `yarn test:parity` salía con exit 1 por dos causas del instrumento, no del producto: los 23 `todo` declarados contaban como diferencia y el caso «expired» aparecía con título distinto (sufijo « — NO APLICA…») sobre HTTP. `comparePair` ahora ignora el sufijo al emparejar, exige que cada NO APLICA esté DECLARADO (`DECLARED_NOT_APPLICABLE`: par, lado, prueba, motivo, referencia) y trata un `failed`, un estado distinto o un NO APLICA sin declarar como DIFERENCIA (`lib/parity.spec.ts`: rojo con la lógica vieja 10 de 21, verde 21 de 21; `evidencia/parity-spec-rojo-logica-vieja.txt`, `parity-spec-verde.txt`). (b) La siembra contra el stack real halló dos defectos propios, ya corregidos: `business_ref` de apertura inválido para el ledger (422) y 401 en la primera consulta con una clave recién creada (el borde la aprende por NATS). Ambos pasaban en la prueba unitaria porque las dependencias estaban inyectadas.

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

## Estado de E1 y E2 (tanda 2h)

**E1 y E2 están en la suite por defecto (`e2e/flows/e1.e2e.ts`, `e2e/flows/e2.e2e.ts`) y pasan con los 11 servicios reales** — sin debilitar aserciones (comparado con la versión de `e2e/pending/` de la tanda 2d:
solo se AGREGARON comprobaciones: el nombre del pagador no vuelve en ninguna respuesta ni en lo que sale al comercio, `ledger_transfer_id`/`fee_minor`/`net_minor` del evento entregado, y un control negativo
con una razón social de las listas OFAC que debe terminar `failed/risk_denied` sin asientos). Alta por la API real; cobro por la API pública con `payer_name`; cribado con Watchman real; callback del conector
`mock`; `pay-payments` asienta en `pay-ledger` (TigerBeetle real): 97,00 en `merchant:X:pending`, 3,00 en `platform:fees`, débitos = créditos = 100,00, `GET /v1/balance` con `pending_minor = 9700`, y un
`payment_intent.succeeded` al comercio (validado además contra el AsyncAPI en E6).

- Suite completa `yarn e2e`: **14 suites, 80 pruebas en verde** (`evidencia/2h-e2e-full-run2.txt`, `2h-e2e-full-run4.txt`; la corrida 1, `2h-e2e-full-run1.txt`, fue 13 suites / 76 pruebas antes de agregar la capa sandbox).
  Nombres de las pruebas de E1/E2 con su resultado: `evidencia/2h-e1-e2-tests.txt`.
- **Honestidad sobre la estabilidad: E1/E2 NO son deterministas en esta máquina.** Corrí solo E1+E2 varias veces seguidas con la máquina compartida cargada (load average 10 a 18 en 4 núcleos, con jest/tsc de otros agentes):
  sin ajustes fallaron 3 de 5 corridas (`evidencia/2h-e1-e2-repeat.txt`); con el calentamiento fallaron 3 de 6 (`…-repeat-conwarmup.txt`); con el calentamiento + los ajustes de entorno de abajo pasaron
  **7 de 8** y la octava no llegó a ejecutarse por disco lleno (`ENOSPC`, ENVIRONMENT; `evidencia/2h-e1-e2-repeat-final.txt`). Los dos modos de fallo observados son los hallazgos 9 (`processing` para siempre) y 10
  (`risk_denied` de un comercio limpio); ambos arrancan en una evaluación de riesgo lenta. Clasificación: **ENVIRONMENT** el disparador (CPU compartida; Watchman p50 30 a 100 ms y p90 65 a 383 ms,
  `evidencia/2h-watchman-latencia.txt`; primera evaluación en frío 280 a 312 ms, `evidencia/2h-risk-primera-evaluacion.txt`) y **PRODUCT_BUG de P3 y P5** el efecto permanente. No se reintentan pruebas, no se
  suben los tiempos de espera de las pruebas ni se debilita ninguna aserción.
- **Qué hace el arnés para reducir el disparador (declarado, y NO arregla los defectos):**
  1. Calentamiento por condición del camino de riesgo (`lib/warmup.ts`, ver arriba).
  2. `SCREENING_TIMEOUT_MS=250` en `pay-risk` (el tope que admite su configuración; por defecto 200).
  3. `RISK_TIMEOUT_MS=2000` en `pay-payments` (por defecto 300): evita el reintento con `409` mientras la primera evaluación sigue viva. Es un ajuste de entorno, como los `POLLER_*` de P4; el
     reproductor `e2e/pending/risk-timeout.e2e.ts` lo vuelve a poner en 40 ms y muestra que el defecto de producto sigue ahí.
  4. Rechazo claro (`ENTORNO: no hay espacio…`) si hay menos de 1,8 GiB libres, y borrado del archivo de datos de un `format` interrumpido.
- Qué falta para que sean deterministas: que P3 haga reintentable el 409 y deje terminal al intento cuando el workflow muere (hallazgo 9), y que P5 no persista un `screening_unavailable` como veredicto (hallazgo 10); o una máquina
  que no se comparta con otras suites.

## Capa sandbox con `pay-mockbank` (propuesta #8 de P4, 2h)

`startStack({ mockbank: true })` o `yarn e2e:up|boot|smoke -- --mockbank` lanzan `pay-mockbank` (puerto libre, base `pay_mockbank` con su DDL, `PAY_MODE=sandbox`, secreto sintético compartido con `pay-connectors`,
callbacks a `…/callbacks/mock`, `PAY_QR_URL`) **antes** que `pay-connectors`, y le dan a este `MOCKBANK_URL`: el conector `mock` y la cuenta de transferencias hablan con el banco por HTTP en vez de usar su banco en memoria.
Por defecto NO se lanza (E1/E2 y el resto corren con el banco en memoria). `flows/sandbox-mockbank.e2e.ts` (4 pruebas, correcto/límite/inválido): el banco arranca sano y TODA respuesta suya lleva
`X-Pay-Mode: sandbox` (también el 403); identidad ajena y modo `live` o ausente ⇒ 403; un cobro de Bs 100,00 termina `succeeded` con 97,00/3,00 en el ledger real y una línea de crédito en el extracto de `collections`;
el escenario `…01` (rechazado) termina `failed/payment_declined` sin asientos y el `…03` (duplicado) deja UN asiento y UNA línea. Arranque medido: 1384 ms (`evidencia/2h-boot-mockbank.txt`).
**Dobles declarados:** `pay-mockbank` es un banco simulado (Q-01, Q-11 siguen abiertas) y no se presenta como el banco real. No cubierto: el depósito del pagador para `bank_transfer` (E8; ver hallazgo 12) y la conciliación de
transferencias contra el extracto del banco simulado.

## Pendientes (`yarn e2e:pending`, fuera de la suite por defecto)

| Archivo | Qué prueba | Qué lo bloquea hoy | Quién | Se pasa a `flows/` cuando |
|---|---|---|---|---|
| `e2e/pending/risk-timeout.e2e.ts` | REPRODUCTOR del hallazgo 9: cuatro cobros con `RISK_TIMEOUT_MS=40`; esperado `succeeded` | Falla HOY: el intento queda `processing` (409 tratado como rechazo definitivo) | P3 (con P5) | `assessRisk` reintente el 409 con la misma clave |
| _(ninguno más)_ | E4, E5 y E8 ya están en `e2e/flows/` y pasan (E4 y E8 de P2/P4: 14/14 con pay-mockbank; E5 de P5: 6/6) | — | — | — |

`yarn e2e:pending` corre con `--passWithNoTests`. E1 y E2 ya NO están acá: se movieron a `flows/` y pasan (§ Estado de E1 y E2). Una suposición que quedó verificada: el intento expone `succeeded_at` y `GET /v1/balance` muestra
`pending_minor = net_minor` (E1 lo afirma y pasa).

## Tanda 3a (ola 3) — cambios del arnés

- `yarn e2e` ahora tiene **15 suites / 83 pruebas** (se sumó `flows/pool-error.e2e.ts`: se cortan con `pg_terminate_backend` todas las sesiones de pay-edge y pay-webhooks con los procesos reales y siguen vivos).
- El humo (`e2e/lib/smoke.ts`, grupo `borde`) **valida cada respuesta contra `public-v1.yaml`** (`loadContract`) y marca `CONTRATO_ROTO` si el estado o la forma no están declarados; `smoke.spec.ts` prueba que el validador detecta incumplimientos.
- Última corrida completa (máquina compartida y saturada): `Test Suites: 1 failed, 14 passed, 15 total · Tests: 2 failed, 81 passed, 83 total`; la suite que falla es `sandbox-mockbank` por `pay-ledger: timeout` ⇒ `circuit_open` (ENVIRONMENT): `docs/trabajo/ola-3/P1/evidencia/e2e-full-3a-clasificacion.txt`. E1 y E2 pasaron en esa corrida.
- Matriz de gates y el resto: `docs/trabajo/ola-3/P1/GATES.md`.

## Tanda 4a (ola 4) — candado del stack y capa sandbox

- **Candado atómico** `e2e/.run/stack.lock` (`e2e/lib/lock.ts`): se adquiere con `link(2)` ANTES de tocar bases, NATS o puertos (lo toman `startStack`, `e2e:down` y `e2e:envprobe`); un candado huérfano (pid muerto o reutilizado) se reclama y se avisa; quien pierde falla con «stack en uso por runId X pid Y desde HH:MM» sin haber hecho nada. Se libera en `stopStack`, al salir y ante SIGINT/SIGTERM. Un `state.json` huérfano se limpia solo al ganar el candado. Pruebas: `e2e/lib/lock.spec.ts` (16, sin stack real) y, con procesos reales, `flows/degraded.e2e.ts` (el segundo stack falla con `StackBusyError` y verifica el runId y el pid del dueño). Evidencia: `docs/trabajo/ola-3/P1/evidencia/candado-stack.txt` y `lock-intermitencia.txt`.
- **Capa sandbox**: `platform/compose.mock.yml` + `platform/Dockerfile.sandbox` (UNA imagen, 12 contenedores), `yarn sandbox:secrets`, `yarn seed:sandbox`, `yarn test:parity`, `yarn load` (ver `docs/trabajo/ola-3/P1/CARGA.md`) y `docs/runbooks/sandbox-a-produccion.md`. **Decisión sobre `RECONCILE_INTERVAL_MS` (propuesta de P2):** NO va en el entorno por defecto del arnés. El valor por defecto del conector (5 min) es el operativo y los flujos que no dependen del extracto no tienen por qué pagar un barrido por segundo; solo E8 descubre el depósito al conciliar el extracto, y lo fija él mismo con `envOverrides: { 'pay-connectors': { RECONCILE_INTERVAL_MS: '1000' } }`, visible en la prueba que lo necesita (mismo criterio que `STATUS_INQUIRY_MS` en E2). Si un tercer flujo lo necesita, se promueve a opción del arnés.
- Verificado solo con `docker compose config`, typecheck, eslint y pruebas unitarias; **la capa Compose no se corrió contra un stack**. `yarn load:harness` SÍ corrió (un humo de 1 minuto con el stack del arnés + pay-mockbank, ver CARGA.md § 8).

## No cubierto

- Svix real (el motor de entrega es el propio, declarado DOBLE de Svix).
- Dinero real, cuenta recaudadora, conector bancario real (modo B es un doble; T-03).
- Las rutas de `schedules → payments` (hallazgo 4) y la emisión de la primera clave `sk_test_` por un camino de operador (hallazgo 1: único paso doble del alta).
- E4, E5 y E8 (carril P2/P4) no se re-corrieron en la tanda 2h; el depósito del pagador en `pay-mockbank` para `bank_transfer` (hallazgo 12).
- E1/E2 bajo carga sostenida: no son deterministas en una máquina saturada (§ Estado de E1 y E2); la corrida 8 de la repetición final no se ejecutó por disco lleno.
- Aislamiento de red del `pay-vault` (P1.H4.M3, ola 3).
- Carga/concurrencia: el arnés corre con 1 worker.
- Cross-browser / visual: no aplica.

## Riesgos residuales

- El TigerBeetle privado preasigna ~1,2 GB en `e2e/.run/<runId>/`; se borra al apagar, pero un `kill -9` del
  proceso del arnés lo deja (se limpia con `yarn e2e:down` o `rm` del directorio).
- `pg`, `nats`, `yaml` y `@types/pg` quedaron declarados en `devDependencies` del `package.json` raíz (mismos rangos que los servicios, así que no
  hay resoluciones nuevas). **`yarn.lock` NO se actualizó** (pedido del coordinador: solo cuando avise que no hay otros agentes): hasta entonces
  `yarn install --immutable` fallaría por el lock desactualizado. Falta correr `yarn install` y revisar que el diff del lock solo toque el bloque del workspace raíz.
