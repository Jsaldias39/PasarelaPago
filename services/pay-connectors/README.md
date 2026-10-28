# pay-connectors (P4)

Un adaptador por proveedor detrás de **una sola interfaz** (`Connector`), ruteo por reglas versionadas, recepción de callbacks
auténticos, consulta de estado cuando el callback no llega, extractos para conciliar y transferencias salientes. Puerto 3103.
Contrato: `contracts/openapi/internal-connectors-v1.yaml`; eventos: `contracts/asyncapi/connectors.yaml`.

- **Base propia:** `pay_connectors`. **El esquema es el del MODELO** (D-18): `sql/ddl.sql` es la copia vendorizada de `mantra-core-health-model/SQL/pay/70_pay_connectors/ddl.sql`
  (generado de los `.puml`; incluye las tablas técnicas de idempotencia, outbox e inbox). No se edita a mano: `scripts/vendor-ddl.sh` la copia y `scripts/vendor-ddl.sh --check`
  la compara (sin el repo hermano, avisa y sale con 0). **Deriva (97.2):** `src/schema-map.ts` es el mapa de tablas/columnas/tipos/nulabilidad que el CÓDIGO usa (los servicios usan `pg`
  directo, sin ORM) y `test/drift.spec.ts` lo compara con la base que sale del `ddl.sql`, con controles negativos. Los registros de dinero (`connector_charges/transfers/refunds`) rechazan
  `TRUNCATE` y `send_claims` no decrece (`test/money-guards.spec.ts`); por eso `reset()` de las pruebas usa `DELETE` en orden de FK.
- **Modo:** `PAY_MODE=sandbox|live`, obligatorio y sin valor por defecto. En `live` el simulador `mock` **no se carga**
  (`ConnectorRegistry` lo rechaza) y no hay conectores del Mercantil todavía: el servicio arranca sin adaptadores, `GET /connectors/health`
  devuelve `[]` y todo cobro responde `502 connector_unavailable`. Nunca se mueve dinero real (T-03).
- **Lo que NO existe:** los adaptadores `mercantil_qr` y `mercantil_card` (P4.H2.M3/M4): el banco no publica su documentación
  (`docs/spikes/banco-mercantil.md`). Todo lo probado contra un banco es contra el **simulador [DOBLE]**; ningún resultado se presenta como del banco real.

## Mapa

| Pieza | Dónde |
|---|---|
| Interfaz `Connector` y errores (`Unavailable` = no se envió, `Timeout`/`Ambiguous` = pudo ejecutarse, `Rejected` = el proveedor dijo que no) | `src/domain/connector.ts` |
| Registro + guardia de modo | `src/domain/registry.ts` |
| Máquina de callbacks (`aplicar \| duplicado \| obsoleto \| contradiccion`) | `src/domain/callback-machine.ts` (procedencia en el archivo) |
| Política de endpoint (red de origen, activo, ventana) | `src/domain/endpoint-policy.ts` (procedencia en el archivo) |
| Ruteo declarativo | `src/domain/routing.ts` + `routing_rule_sets` |
| Secretos (`SecretProvider`, [DEV] por entorno, un espacio por conector) | `src/domain/secrets.ts` |
| Simulador [DOBLE] | `src/connectors/mock/` |
| Transferencia bancaria + conciliación | `src/connectors/bank-transfer/`, `src/core/statements.service.ts` |
| Cobros, reembolsos (`POST /charges/{id}/refunds`, `GET /refunds/{id}`), transferencias | `src/core/{charges,refunds,transfers}.service.ts` |
| Callbacks / poller / salud | `src/core/{callbacks,poller,health}.service.ts` |

## Reglas que el código hace cumplir

1. **Un resultado ambiguo no es un fallo** (CLAUDE.md regla 11). Antes de cada llamada que puede mover dinero se marca «pudo llegar»
   (`ambiguous` en cobros, `may_have_reached_provider` en reembolsos y transferencias). Un timeout, un corte o un 5xx de proxy dejan
   la fila y la marca; un `Unavailable` o rechazo **posterior a un intento ambiguo** se eleva a ambiguo (`ProviderGateway.callIdempotent`).
   Solo la **primera** llamada que falla con `Unavailable` prueba «no se envió» (`502 connector_unavailable`). No hay conmutación a otro
   conector después de un intento ambiguo. Los registros de dinero no se borran.
1b. **Un envío a la vez por transacción de dinero.** `withSendLock` (candado de sesión de Postgres con sondeo, en un pool dedicado `LOCK_POOL`, para que N envíos distintos no agoten el pool de datos) serializa los envíos de un mismo cobro, reembolso o transferencia; el que espera vuelve a leer el estado y no llama de nuevo si ya quedó resuelto. El flag «pudo llegar» se lee y marca en una sola sentencia, es monótono (trigger `connector_money_flags_monotone`) y el «no se envió» exige ser el único reclamo (`send_claims`).
2. **Referencia determinista y estable hacia el proveedor:** el id del cobro (`ch_…`), del reembolso (`cr_…`) y `business_ref:attempt`
   de la transferencia. Reintentar presenta siempre la misma.
3. **Un callback sin autenticar no tiene efecto:** firma, red de origen, ventana o secreto ausente ⇒ `401`, nada se guarda ni se publica.
   Cuerpo ilegible pero firmado ⇒ `400`. Deduplicación por `(connector, provider_event_id)`; un hecho que choca con un estado terminal
   queda como `contradiction` para conciliación humana y no se sobrescribe.
4. **Sin credenciales ni datos del pagador** en logs, eventos, errores ni base: los logs solo llevan `id`, método, ruta enmascarada
   (`src/log-safe.ts`) y estado; la descripción y el token de tarjeta no se persisten; los errores no repiten lo que mandó el cliente.
5. **Denegado por defecto:** `ServiceIdentityGuard` + `@AllowedServices`; solo `/health/*` y `POST /callbacks/{connectorId}` son públicos.

## Simulador `mock` — escenarios deterministas por los CENTAVOS del importe

| Centavos | Escenario | Qué hace |
|---|---|---|
| `00` | aprobado | el callback `captured` llega enseguida |
| `01` | rechazado | `failed` síncrono con `card_declined` |
| `02` | demorado | el callback llega a los 5 s (`delayMs`) |
| `03` | callback duplicado | el mismo callback ×3, mismo id de evento |
| `04` | fuera de orden | `captured` y después `authorized` |
| `05` | callback perdido | nunca llega; solo la consulta de estado revela `captured` |
| `06` | caído | `createCharge` falla sin crear nada |
| `07` | timeout ambiguo | el cobro se crea y la respuesta se pierde |
| `08` | nunca pagado | pasa a `expired` al llegar `expires_at` |
| `09` | extracto con diferencia | el extracto trae Bs 1,00 menos |
| otros | aprobado | |

**Transferencias salientes:** `00`/otros pagada · `01` fallida (`rejected_by_bank`) · `02` en tránsito 5 s · `06` caído (nada se envía) ·
`07` timeout, `17` un proxy contesta 502 con HTML, `27` socket cortado (en los tres la orden **se ejecuta**) · `08` en tránsito para siempre.
Reproducible por semilla (`SimulatedBank({ seed })`). `SimulatedBank.reset()` lo deja en blanco.

En sandbox, `MockPumpService` firma los callbacks que programa el simulador y los entrega a `CallbacksService`, que los verifica como
a los de un proveedor real (cada `MOCK_PUMP_INTERVAL_MS`).

### Cobro de punta a punta sin banco real (arnés e2e)

En `PAY_MODE=sandbox` un cobro QR de importe normal (cualquier importe cuyos centavos no sean un escenario especial; p. ej. `10000` = Bs 100,00)
termina cobrado **sin tocar nada a mano**, por dos caminos independientes (los dos probados en `test/end-to-end.spec.ts`, con temporizadores reales):

1. **Callback firmado (el camino principal).** `POST /charges` crea el cobro (`requires_action`, `next_action.type = display_qr`) y el simulador programa su
   callback `captured`. La bomba interna (`MockPumpService`) corre cada **`MOCK_PUMP_INTERVAL_MS`** (por defecto `1000`; `0` la apaga), lo firma con el secreto del
   conector (`PAY_SECRET_CONNECTOR_MOCK_WEBHOOK_SECRET`, Standard Webhooks) y lo entrega a `CallbacksService`, que lo verifica como a uno de un proveedor real.
   Resultado: `GET /charges/{id}` ⇒ `succeeded`; evento `connector.transaction.status_changed` con `observed_via: callback`. Sin esa variable de secreto el
   conector `mock` no firma y el servicio no cobra.
2. **Polling (si el callback no llega).** El poller consulta el estado cada **`POLLER_INTERVAL_MS`** (por defecto `15000`) a los cobros abiertos que ya cumplieron
   **`POLLER_MIN_AGE_MS`** (por defecto `30000`) y aplica lo que revela el banco con `observed_via: status_inquiry`. Para que el arnés no espere 30 s:
   `POLLER_MIN_AGE_MS=1000 POLLER_INTERVAL_MS=500`. También se puede forzar un cobro con `GET /charges/{id}/status?refresh=true`.

Los dos caminos son idempotentes entre sí: si el poller cobra primero, el callback que llega tarde se absorbe sin repetir el evento. Para probar el
camino de fallo del arnés, los centavos eligen el escenario (tabla de arriba): `05` = callback perdido (solo el polling lo revela), `08` = nunca pagado.
Con `MOCK_PUMP_INTERVAL_MS=0` y `POLLER_INTERVAL_MS=0` nada corre solo (las pruebas disparan cada tarea a mano).

### Cuenta recaudadora (`BANK_TRANSFER_*`)

- **sandbox:** las tres variables son **opcionales**. La que falta toma el valor **SINTÉTICO declarado** (`SANDBOX_BANK_ACCOUNT` en `src/config.ts`):
  `BANCO SIMULADO (SANDBOX)` · `ALOVIDA PAY (SANDBOX)` · `SANDBOX-0000-0001`. Llevan el rótulo SANDBOX a propósito: ninguno parece una cuenta real.
- **live:** los tres o ninguno. Sin ninguna (T-03: la cuenta recaudadora no existe) NO se inventa nada. A medias, o con el rótulo del simulador, el servicio no arranca.
- Un valor presente se valida igual en los dos modos (nombre y titular ≤ 100 caracteres; número de 4 a 40: letras, números, espacio, punto o guion).

## `PAY_MODE` al arrancar (D-26)

`PAY_MODE` es **explícito**: `sandbox` o `live`, sin valor por defecto (ausente, vacío o mal escrito ⇒ el proceso termina con código ≠ 0). Bajo `live` el servicio
**se niega a arrancar** si el entorno trae algún doble de sandbox: `PAY_SECRET_CONNECTOR_MOCK_*`, `MOCK_PUMP_INTERVAL_MS` (aunque sea `0`) o una cuenta con el
rótulo SANDBOX/simulado. Además el registro de conectores no deja cargar `mock` bajo `live` (`domain.spec.ts`). Probado con el binario real (`test/startup.spec.ts`).

## Capa sandbox: el «banco» detrás de `mock` es `pay-mockbank` (D-26, P4.H4)

- **Sin `MOCKBANK_URL`** (por defecto): el conector `mock` usa el banco en memoria (`SimulatedBank`), igual que siempre; las pruebas unitarias y los entornos mínimos no necesitan otro servicio.
- **Con `MOCKBANK_URL=http://127.0.0.1:3112`** (solo sandbox): el MISMO conector `mock` habla por HTTP con **`pay-mockbank`** (`HttpMockBankClient`, detrás de la interfaz `MockBankPort`); el conector `bank_transfer` lee su extracto de la cuenta `transfers` de ese banco;
  los callbacks los entrega `pay-mockbank` firmados a `POST /callbacks/mock` (la bomba en proceso no corre). El código `mock` y los contratos no cambian: `contracts/` no se tocó.
- **Regla 11 en el cliente:** solo son «no se ejecutó» los cuerpos exactos del contrato — `503 bank_unavailable` y la conexión que ni se estableció (`ECONNREFUSED`…) — ⇒ `ConnectorUnavailableError`. Un timeout, una conexión cortada, un 502 con HTML o cualquier 5xx ⇒ `ConnectorTimeoutError`/`ConnectorAmbiguousError` (pudo ejecutarse): se reintenta con la MISMA referencia.
- **Extracto:** `GET /statements` devuelve, en cada línea emparejada con un cobro conocido, `charge_id`, **`payment_intent_id`** y **`merchant_id`** (salen de NUESTRO registro de cobros: un banco no conoce nuestros `pi_…`/`mc_…`); sin cobro conocido los tres son `null`, nunca se infieren. Es la clave con la que `pay-settlement` cruza extracto y ledger.
- **Suite de contrato por conector (P4.H4.M1):** `CONNECTOR=mock yarn test:contract` (también `bank_transfer`, `mercantil_qr`, `mercantil_card`; sin variable, todos). `test/contract/connector-contract.ts` es UNA sola suite que corre idéntica contra el banco en proceso y contra el `pay-mockbank` real por HTTP; lo que un conector no puede aparece como `todo` con su motivo.
  `mercantil_qr` y `mercantil_card` están **BLOQUEADOS** (sin documentación ni ambiente de pruebas del banco: `docs/spikes/banco-mercantil.md`); su prueba de guardia falla cuando exista el adaptador para obligar a correr la suite contra él.

## Contratos de la ola 2

- **`GET /refunds/{id}`** (`cr_…`, solo `pay-payments`): con `refresh=true` y el reembolso `pending`, pregunta al proveedor (`Connector.getRefund`); `captured` ⇒ `succeeded`, `failed` ⇒ `failed`. Sin respuesta, con rechazo, sin `getRefund` o con `not_found` explícito ⇒ lo último que se sabe (`stale: true` salvo `not_found`); **nunca** se toca la fila ni la reserva por un silencio. `404` solo si este servicio no tiene la fila.
- **`refund_id`** (`re_…`) opcional en el pedido: se guarda, vuelve en `ConnectorRefund` y se copia al evento. Un mismo `refund_id` con otra `Idempotency-Key` ⇒ `409` (jamás un segundo `cr_…`).
- **Eventos:** el conector sale como `mock` (no `simulator`); `connector_transaction_id` y `subject` son el `ch_…`/`cr_…` de la API (sin `ct_…`); `failure_code` admite `card_declined`. `connector.transfer.status_changed` se publica por outbox, en la misma transacción que el cambio de estado de la transferencia (señal; la fuente autoritativa sigue siendo `GET /transfers/{reference}`).
- **`bank_transfer_instructions`** lleva `bank_name`, `account_holder` y `account_number` desde `BANK_TRANSFER_*` (ver «Cuenta recaudadora» abajo). Bajo `live` y sin cuenta (T-03) NO se inventa: salen solo `type` y `reference` y `pay-payments` responde `422 payment_method_unavailable`.
- Pendiente: el adaptador del Mercantil (el banco no publica su documentación).

## Modo de la clave (`X-Pay-Mode`, D-28)

- **Exigido** (`test` o `live`) en las 8 operaciones que mueven o consultan dinero: `POST /charges`, `GET /charges/{id}`, `GET /charges/{id}/status`, `POST /charges/{id}/cancel`, `POST /charges/{id}/refunds`, `GET /refunds/{id}`, `POST /transfers`, `GET /transfers/{reference}`. Ausente, repetido o inválido ⇒ `403 forbidden` **antes de cualquier efecto** (ni fila, ni clave de idempotencia, ni evento, ni llamada al proveedor). Nunca se cae en `live`.
- **Coincide con el despliegue:** `PAY_MODE=sandbox` ↔ `test`, `live` ↔ `live`. Una clave `live` contra un sandbox (o `test` contra un live) ⇒ `403`. El ruteo solo ofrece conectores del modo de la clave y la base lo impide (`connector_*_mode_match_ck`): `mock` jamás opera con una clave `live`.
- **Se guarda** en `pay_mode` (cobros, reembolsos, transferencias); la columna que describe el conector se llama `connector_mode` (es el `mode` que muestra la API). Toda lectura filtra por `(id, pay_mode)`: un id del otro modo da `404`.
- **La misma `Idempotency-Key` en `test` y en `live` son dos operaciones** (la clave se guarda por `llamador|modo`; los índices únicos incluyen `pay_mode`).
- **Callbacks:** no traen `X-Pay-Mode` (se ignora si viniera); el modo sale del registro del cobro y queda en `connector_callback_events.pay_mode` (nulo si la referencia no es nuestra).
- **Extractos y salud:** el contrato lo declara opcional; si viene se valida igual (inválido o de otro despliegue ⇒ `403`) y en extractos filtra el emparejamiento.
- **Llamadas salientes** (auditoría): la única es `HttpQrClient` → `pay-qr`, que propaga `X-Pay-Mode` con el modo del cobro. El resto de la salida es NATS (eventos) y el banco simulado (en proceso).

## Variables de entorno

Ver `.env.example` (`MOCKBANK_URL` y `MOCKBANK_TIMEOUT_MS` activan la capa sandbox; coherente con lo que levanta el arnés e2e: `PAY_QR_URL`, el secreto del mock y la cuenta sintética). Obligatorias: `DB_*`, `PAY_MODE`. Secretos [DEV]: `PAY_SECRET_CONNECTOR_<CODIGO>_<NOMBRE>` (lista separada por comas
para rotar sin corte); en producción los entrega OpenBao a través de `SecretProvider` (no corre en el entorno de trabajo).

## Comandos

```bash
yarn typecheck && yarn build && yarn test      # las pruebas usan Postgres (54321) y NATS (54222) reales
```
Variables de prueba: `PAY_TEST_DATABASE_URL=postgres://pay_connectors:dev_only_connectors@127.0.0.1:54321/pay_connectors`.

## Límites conocidos (no cubierto)

- Sin adaptadores del Mercantil (ver arriba). El formato de sus callbacks, firma y extractos es desconocido (Q-01, Q-11).
- `camt.053` sin validar contra el XSD oficial de ISO 20022 (no hubo acceso). La glosa del banco no sale del servicio hasta revisar su formato.
- Límite de velocidad de callbacks en memoria: con varias réplicas el tope efectivo es por réplica.
- Anular un cobro QR no anula el QR en `pay-qr` (falta el puerto de anulación).
- Conciliación `late_credit`/`unmatched`/`amount_mismatch` solo registra la excepción; resolverla es de una persona (P2).

## `X-Pay-Mode: sandbox` en las respuestas (D-26)

En un despliegue `sandbox` **toda respuesta** (éxitos, errores del contrato, `401` de callbacks, `403` del guard, `404`, salud, extractos JSON/CSV/XML) lleva `X-Pay-Mode: sandbox` (`contracts/openapi/common.yaml`, `XPayModeSandbox`); en `live` no se envía. Es la
cabecera de la RESPUESTA (el despliegue); la de la petición (`test|live`) es la del modo de la clave (D-28) y no la cambia. Probado en `test/sandbox-header.spec.ts`. Los spans de OpenTelemetry no guardan la URL cruda (`src/observability/scrub.ts`, regla 90.2).
`/health/ready` responde `503` (no `500`) si la base propia no contesta, sin el mensaje del error (`test/db-down.spec.ts`).
