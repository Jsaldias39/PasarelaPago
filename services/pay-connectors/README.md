# pay-connectors (P4)

Un adaptador por proveedor detrás de **una sola interfaz** (`Connector`), ruteo por reglas versionadas, recepción de callbacks
auténticos, consulta de estado cuando el callback no llega, extractos para conciliar y transferencias salientes. Puerto 3103.
Contrato: `contracts/openapi/internal-connectors-v1.yaml`; eventos: `contracts/asyncapi/connectors.yaml`.

- **Base propia:** `pay_connectors`. Esquema de referencia: `sql/001_connectors.sql` (+ las tablas técnicas de `@pay/idempotency` y
  `@pay/outbox`). A mover al modelo (D-18); los índices tienen nombre explícito.
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
| Cobros, reembolsos, transferencias | `src/core/{charges,refunds,transfers}.service.ts` |
| Callbacks / poller / salud | `src/core/{callbacks,poller,health}.service.ts` |

## Reglas que el código hace cumplir

1. **Un resultado ambiguo no es un fallo** (CLAUDE.md regla 11). Antes de cada llamada que puede mover dinero se marca «pudo llegar»
   (`ambiguous` en cobros, `may_have_reached_provider` en reembolsos y transferencias). Un timeout, un corte o un 5xx de proxy dejan
   la fila y la marca; un `Unavailable` o rechazo **posterior a un intento ambiguo** se eleva a ambiguo (`ProviderGateway.callIdempotent`).
   Solo la **primera** llamada que falla con `Unavailable` prueba «no se envió» (`502 connector_unavailable`). No hay conmutación a otro
   conector después de un intento ambiguo. Los registros de dinero no se borran.
1b. **Un envío a la vez por transacción de dinero.** `withSendLock` (candado de sesión de Postgres con sondeo) serializa los envíos de un mismo cobro, reembolso o transferencia; el que espera vuelve a leer el estado y no llama de nuevo si ya quedó resuelto. El flag «pudo llegar» se lee y marca en una sola sentencia, es monótono (trigger `connector_money_flags_monotone`) y el «no se envió» exige ser el único reclamo (`send_claims`).
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

## Variables de entorno

Ver `.env.example`. Obligatorias: `DB_*`, `PAY_MODE`. Secretos [DEV]: `PAY_SECRET_CONNECTOR_<CODIGO>_<NOMBRE>` (lista separada por comas
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
