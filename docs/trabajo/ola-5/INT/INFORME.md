> **AVANCE INT: 0 / 5 — 0,0 %.** `INT.H1.M2` e `INT.H1.M3` están `A MEDIAS`. La revisión independiente ([REVISION-API-INT.md](../integracion/revision/REVISION-API-INT.md)) halló un BLOQUEANTE para encender el flag (B1: bajo RLS el receptor no ve nada) y tres MAYOR (M1 deuda sin sesión de checkout, M2 sin compuerta previa contra la deuda, M3 BOLA en `processTransaction`). Con el flag apagado, que es el defecto, no se activa nada de esto. Corrección en curso. `M1`, `M4` y `M5` están `BLOQUEADO` por algo externo.

# Informe INT — la API cobra por la pasarela (M2 + M3)

- Repo de la API: `mdavila-2001/mantra-core-health-api`, rama `claude/adoring-allen-ly7r6f`, HEAD `aa38ddbe` (subida; **sin PR**, por decisión del usuario).
- Peldaño de evidencia: `TESTED` en la API (dobles y almacén en memoria); `VERIFIED` solo para el cliente HTTP y la verificación de firma contra el stack sandbox real (abajo). No hay `REGRESSION_VERIFIED`.
- Implementó un agente distinto del integrador; el integrador repitió los gates.

## Verificación del integrador (salidas en `evidencia/`)

| Qué | Resultado |
|---|---|
| `tsc --noEmit` (heap 8 GB) en la API | exit 0 |
| `eslint` sobre `src/modules/payments`, `main.ts`, `app.module.ts` | exit 0 |
| `jest src/modules/payments --runInBand` | 17 suites / 361 tests en verde ([salida](./evidencia/api-payments-tests.txt)) |
| Cliente + verificador de la API contra el stack sandbox real de 12 servicios ([corrida](./evidencia/sandbox-real-corrida.txt), [script](./evidencia/run-client.ts.txt)) | crear → 201 `requires_action` (fee 425 de 15 000); repetir con la misma clave → `replayed:true`, mismo `pi_…`; el cobro llega a `succeeded`; 8 entregas de webhook, todas verifican con el verificador de la API; una entrega con un byte alterado → `no_matching_signature` |

## Qué hace (flag `PAYMENTS_VIA_GATEWAY`, apagado por defecto)

- El cobro se despacha en `POST /payments/intents/:id/transactions`, **no** al crear la intención (la compuerta de riesgo del camino viejo vive en `processTransaction`; despachar al crear la salteaba por construcción). `createIntent` solo valida que la pasarela pueda cobrarla.
- `Idempotency-Key` determinista `mantra-pi-v1-<sha256(tenant, deuda u orden, clave local)>`; timeout/5xx/409-en-curso se reintentan con la MISMA clave (regla 11); si se agotan: `504 PAYMENT_GATEWAY_RESULT_AMBIGUOUS` y la intención queda pendiente, sin anular nada.
- Mismas compuertas que el camino viejo (estado, operación abierta, riesgo, saldo), más: solo `SALE` por el importe completo; `PI_PROCESSING` sin cobro en la pasarela → 409; con `gatewayIntentRef` → consulta (no crea otro cobro). Con el flag apagado, el camino viejo no cambia (160 tests previos en verde sin tocar ningún spec).
- Receptor `POST /payments/gateway-webhooks`: Standard Webhooks (HMAC `v1`, Ed25519 `v1a`) sobre los bytes crudos, ventana anti-replay de 300 s, bandeja en `payment_webhook_events` (`gateway_event_ref = pay-gateway:<webhook-id>`, índice único, `FOR UPDATE` de la intención), 2xx solo tras `COMMIT`; paridad de firma con 15 vectores generados por `@pay/webhook-signature`.
- Hallazgos de la revisión de seguridad automática (3): reales, resueltos y cubiertos por tests con mutaciones (cada compuerta quitada a propósito hace fallar tests).

## Hallazgo para la pasarela

`pay-edge` rechazó con `422 card_number_detected` un `metadata` que llevaba un UUID: el guardia de PAN lo leyó como tarjeta. Es el falso positivo **DT-19** (ver `docs/trabajo/ola-1/P1/DECISIONES-TOMADAS.md`) observado con un cliente real: un UUID es un identificador legítimo y común. El cliente de la API lo evita no enviando `metadata`; la causa sigue abierta en la pasarela (P1/P3).

## Re-revisión INT: correcciones de N1–N7 en la API (RAMA `claude/adoring-allen-ly7r6f`)

Corrige los hallazgos de [RE-REVISION-API-INT.md](../integracion/revision/RE-REVISION-API-INT.md). Peldaño: `TESTED` (unitarios con dobles, más tres int-specs contra PostgreSQL real con el doble declarado de la pasarela); no hay `VERIFIED` contra `pay-edge` ni contra la API arrancada. Cada arreglo tiene prueba en rojo contra el código anterior y una mutación que la vuelve a poner en rojo (salidas en el cuerpo del PR/entrega, no en el repo de la API).

| # | Qué se hizo | Dónde (API) |
|---|---|---|
| N1 | El recorte de query y barras finales de `isGatewayWebhookPath` es un bucle por índice (lineal). 100 000 barras: de 8,9 s a menos de 5 ms; barra final y mayúsculas se siguen reconociendo (m1). | `gateway/payments-gateway-raw-body.ts` |
| N2 + N4 | **Reserva de despacho solo-aplicación.** La compuerta, con la deuda bloqueada, escribe una marca `dispatching:<epoch-ms>:<uuid>` en `payment_intents.gateway_intent_ref` y la **confirma antes de llamar** a la pasarela. La compuerta contra la deuda cuenta como «en vuelo» a todo `pi_…` y a toda marca. El `pi_…` reemplaza la marca. Se libera solo si **todos** los intentos de la llamada fueron rechazos definitivos (un timeout/corte/5xx previo + un 4xx final conserva la marca; `422 idempotency_key_reused` también). Un 504 la conserva. La propia intención no se bloquea (misma clave, regla 11). **Una marca no vence como permiso para cobrar**: pasado el plazo (15 min o 4 × el peor caso) pasa a «requiere conciliación» (log, contador `payments_gateway_dispatch_reconciliation_required_total`, `listDispatchesRequiringReconciliation`) y SIGUE bloqueando; la salida es `reconcileGatewayDispatch`, que reenvía la misma creación con la misma clave (asocia el `pi_` existente o crea el cobro de ESA intención una vez). Con la marca de más de 23 h no reenvía y pide conciliación manual. | `gateway/payments-gateway-dispatch-mark.ts`, `gateway/payments-gateway.client.ts` (`earlierAttemptMayHaveReached`), `services/payments-transactions.service.ts` (`processViaGateway`, `assertDebtAllowsCharge`, `reconcileGatewayDispatch`), `services/payments-gateway-charge.service.ts`, `services/payments-committed-transaction.ts` |
| N3 | Una intención sin sesión de checkout que puede ser una deuda (propósito `DEBT`, o referencia de origen de un tipo que no es `payment_debt` ni uno conocido como ajeno, hoy `EDUCATION_COURSE`) se rechaza con `422 PAYMENT_GATEWAY_DEBT_UNRESOLVED`. No hay catálogo ni enum de `source_ref_type`: es texto libre en el DTO. | `payments.source-refs.ts`, `services/payments-transactions.service.ts` |
| N5 | La llamada HTTP ya no sostiene bloqueos de fila (la compuerta y la asociación son transacciones cortas confirmadas, también con `RLS_ENFORCE=true` mediante un `EntityManager` bifurcado con el mismo contexto de tenant). El comentario de `processViaGateway` describe lo que sí pasa. | `services/payments-committed-transaction.ts` |
| N6 | `findOpenCheckoutSessionsByDebt` lee sin `FOR UPDATE`: la deuda, ya bloqueada, serializa la lectura. 40 rondas con rol `NOBYPASSRLS`: de 21 interbloqueos `40P01` a 0. | `repositories/payment-flow.repository.ts` |
| N7 | El tenant va en el mismo `WHERE` del `FOR UPDATE` (`findByIdAndTenantForUpdate`): la intención ajena no se espera ni se bloquea. Con la fila de la víctima bloqueada, la petición ajena responde antes de 500 ms y con el mismo cuerpo que un UUID inexistente. | `repositories/payment-intents.repository.ts`, `services/payments-transactions.service.ts` |

**Decisión de N2 y por qué.** No hace falta tocar el modelo: la marca vive en una columna que ya existe y que ya significa «esta intención tiene (o está creando) un cobro en la pasarela», lo que además hace que `lock fx`, `splits`, `risk-assessment DECLINE` y el camino directo al proveedor traten a una intención reservada como ya despachada. No se reutilizó `PI_PROCESSING` porque ya significa «operación abierta por el camino de siempre» y hay pruebas que lo exigen así. Una marca no puede resolverse por webhook (el receptor solo acepta `pi_[a-z0-9]{10,40}`) ni se consulta como si fuera un cobro. La fecha vive dentro de la marca (no en `updated_at`, que cualquier escritura refresca) y un reintento no la renueva: de ella depende la única decisión peligrosa, si todavía se puede reenviar con la misma clave. **Corrección de la 2.ª revisión de seguridad:** una primera versión dejaba de bloquear a las otras intenciones al vencer la marca y liberaba la reserva ante cualquier 4xx final; ambas cosas permitían un segundo cobro con el primero ya creado (la ambigüedad no prueba que no se ejecutó). Ahora vencer solo cambia la clase, y la reserva se libera solo si todos los intentos fueron rechazos definitivos.

**Riesgos que quedan (en presente).**

- **Pool con `RLS_ENFORCE=true` (3.ª revisión, P1).** El interceptor retiene UNA conexión por petición y la compuerta/asociación/liberación piden OTRA: con tantos cobros simultáneos como conexiones (`DB_POOL_MAX`, 10) hay espera circular, sin importar la latencia, y `pg` espera sin límite. Mitigado, no eliminado: a lo sumo `ceil(DB_POOL_MAX/2) - 1` despachos simultáneos por proceso dentro de una transacción de petición (4 con el pool por defecto), sin cola: el excedente recibe `503 PAYMENT_GATEWAY_BUSY` (reintentable con la misma clave); y `DB_CONNECTION_TIMEOUT_MS` (30 s, **global** del pool de la API: es un tope de seguridad, un pool agotado pasa de colgar la API a fallar la petición; el riesgo es que una espera legítima de más de 30 s por una conexión ahora falla) acota la espera. El tope es por proceso y no ve el tráfico ajeno: con varias réplicas o mucho tráfico ocupando conexiones, el pool puede agotarse hasta ese timeout. La solución de fondo es que la ruta no corra dentro de la transacción del interceptor (un decorador que lo omita, con la transacción y el `set_config` de tenant por sección); no se hizo por tocar el interceptor de toda la API → dueño de la plataforma / P3.
- Una reserva sin `pi_…` bloquea la deuda hasta que se concilia o se cierra a mano (rutas del runbook). Nadie las llama sola: no hay job ni alerta (queda por definir quién mira el listado y la métrica) → P3 / dueño de M42. Un cierre manual cancela la intención aunque la pasarela hubiera creado el cobro (huérfano, P5): depende de que quien cierra lo haya comprobado; el motivo queda en el log estructurado (no en una columna: el modelo no tiene dónde) y la auditoría guarda quién, cuándo y qué intención.
- La conciliación necesita el mismo `paymentMethodType` de la primera vez (m4: no se persiste); con otro, la pasarela contesta `idempotency_key_reused`, la reserva se conserva y se pide conciliar contra la pasarela.
- Las pruebas de `RLS_ENFORCE=true` del camino de cobro simulan la transacción del interceptor sobre un usuario superusuario; no corren bajo el rol restringido.

- **P5 (abierto).** El cobro huérfano de un 504 que sí se ejecutó genera un webhook terminal para un `pi_…` que ninguna fila tiene: el receptor responde 404 y la pasarela reintenta hasta contarlo como entrega muerta (consecutivas pueden deshabilitar el endpoint). Propuesta: archivar para conciliación (`processed=false`) cuando el `pi_…` es desconocido y el terminal llega. No se hizo (cambia el contrato del receptor).
- **P8 (abierto, a acordar con el front).** La compuerta falla cerrado para cualquier `sourceRefType` que no sea `payment_debt` ni `EDUCATION_COURSE` si no hay sesión de checkout. El front actual no envía `sourceRefType` de pagos; hay que acordar el catálogo antes de encender el flag.

**Tercera revisión (sobre `97eaa006c`): qué se corrigió.** P1 mitigado (tope de despachos por proceso sin cola + `503 PAYMENT_GATEWAY_BUSY` + `DB_CONNECTION_TIMEOUT_MS`; no eliminado, ver riesgos). P2 cerrado: cada petición escribe su propio valor de marca y libera solo el suyo (comparar antes de borrar). P3 cerrado: un 4xx sin el cuerpo de error del contrato es ambiguo y conserva la reserva. P4 cerrado: la marca no vence como permiso; conciliación explícita. P6: el runbook de abajo (la salida es la conciliación). P7: README y `docs/modules/payments.md` corregidos. P9: se había cerrado quitando el riesgo del reintento con marca y la verificación mostró que, si el primer envío nunca llegó, el reintento creaba un cobro NUEVO bajo un `REVIEW` pendiente (D1): se restauró la evaluación de riesgo también con marca y se permite registrar `DECLINE` sobre una simple reserva (sin pasar la intención a `failed`, para que la deuda siga bloqueada); recuperar un cobro existente bajo un riesgo no aprobado exige un `APPROVE` o el cierre manual (la conciliación también exige riesgo aprobado, a diferencia de lo que se pidió: replayar sin riesgo aprobado puede crear el cobro). D2: rutas administrativas y cierre manual. D3: un problema del contrato exige la forma de `problem.schema.json`. D4: marcas de formato anterior o con fecha futura (más de 5 min) requieren conciliación y se listan. D5 (documentado): el tope por proceso limita a 4 cobros simultáneos con el pool por defecto y con `DB_POOL_MAX` ≤ 2 el mínimo de 1 deja un despacho sin conexión libre de reserva. D7 (documentado): un timeout de adquisición de conexión en `associate`, tras crearse el cobro, sale como 500 y deja la marca; se recupera con el reintento. P5 y P8 quedan abiertos (arriba). El hallazgo F1-A del primer pedido (un intento previo ambiguo + un 4xx final) está cerrado en el cliente (`earlierAttemptMayHaveReached`).

## Runbook: reservas colgadas, cobros huérfanos y apagado del flag

Qué es una **reserva**: `payment_intents.gateway_intent_ref = 'dispatching:<epoch-ms>:<uuid>'` en una intención sin `pi_…`. La deja la compuerta antes de llamar a la pasarela y la reemplaza el `pi_…`. Mientras existe, ninguna otra intención cobra esa deuda. Rutas (solo `PAYMENTS_ADMIN`, tenant del contexto, `@Audited`):

| Ruta | Para qué |
|---|---|
| `GET /payments/gateway-dispatches/pending-reconciliation` | Lista las reservas que requieren conciliación (`paymentIntentId`, `ageMs`, `canReconcile`) |
| `POST /payments/gateway-dispatches/:intentId/reconcile` `{ paymentMethodType }` | Concilia reenviando la misma creación con la misma clave (exige riesgo aprobado) |
| `POST /payments/gateway-dispatches/:intentId/close` `{ reason }` | Cierra a mano la reserva, sin contactar a la pasarela |

1. **Detectar.** Listado (arriba); log `payments.gateway.debt-gate` (error, `reconciliationRequiredIntentIds`) y `payments.gateway.reconcile`; métrica `payments_gateway_dispatch_reconciliation_required_total{reason}` (`stale_blocks_debt`, `too_old_to_resend`, `key_reused`) y `payments_gateway_dispatch_reconciled_total{outcome}` (`replayed`, `created`, `ambiguous`, `rejected`, `closed_manually`). **Falta** una alerta que consuma esas señales (nadie las lee hoy); `@opentelemetry/api` es no-op si no hay un SDK conectado.
2. **Reserva con menos de 23 h (`canReconcile: true`).** `reconcile` con el MISMO medio de pago de la primera vez. Si la pasarela ya tenía el cobro lo asocia y lee su estado vigente; si nunca llegó lo crea una vez para esa intención. Si el riesgo vigente es `REVIEW`/`DECLINE` responde 422: o se registra un `APPROVE`, o se cierra a mano. Con otro medio de pago la pasarela contesta `idempotency_key_reused` (el cobro existe): `409 PAYMENT_GATEWAY_RECONCILIATION_REQUIRED` y la reserva se conserva. Repetir `POST /payments/intents/:id/transactions` hace lo mismo.
3. **Reserva con más de 23 h, fecha ilegible (formato anterior `dispatching:<uuid>`) o con fecha futura (`canReconcile: false`).** No se reenvía (la pasarela retiene la clave 24 h; repetir podría crear un segundo cobro). Consultar la pasarela por importe, moneda y hora de creación: si el cobro existe y se cobró, ver si hay que conciliarlo contablemente por el camino de siempre; en cualquier caso, **`close`** con un motivo que diga qué se comprobó (sin datos personales). `close` solo acepta una reserva que ya requiere conciliación (`409 PAYMENT_GATEWAY_DISPATCH_IN_FLIGHT` si puede seguir en vuelo). Deja la intención en `PI_CANCELED` y la deuda libre. Está prohibido corregirla en la base (regla 97.1.5).
4. **Cobro huérfano** (la pasarela lo creó y la API no lo asoció): expira solo según `expires_in_seconds`; su webhook terminal responde 404 hasta entonces (P5); nadie recibió su QR si la respuesta se perdió.
5. **Apagar el flag sin dejar intenciones atrapadas.** Con el flag apagado una intención con reserva o `pi_…` responde `409 PAYMENT_INTENT_VIA_GATEWAY` a `/transactions` y a `fx-lock`/`splits`, y `reconcile` responde `NOTHING_TO_RECONCILE`; el listado y `close` siguen funcionando. Antes de apagar: (a) dejar de aceptar cobros nuevos y esperar que terminen los que están en vuelo; (b) listar y resolver todas las reservas (puntos 2 y 3) con el flag encendido; (c) dejar el receptor de webhooks encendido hasta que no queden cobros `PI_PENDING`/`PI_PROCESSING` con `pi_…` (apagado responde 503 y esos terminales no se aplican); (d) recién entonces apagar. Si se apagó antes, volver a encender, resolver y repetir; una reserva que ya no se quiere conciliar se puede cerrar con el flag apagado.

## Qué NO cubre

- ~~Persistencia real de la bandeja~~ **Cubierta** (commit `77dd6ec9` de la API): `test/integration/payments-gateway-webhook.int-spec.ts`, 11 pruebas contra PostgreSQL real con el DDL real de `42_payments`, sin levantar `AppModule`. Sigue sin cubrirse: la persistencia del camino de COBRO (`createIntent`/`processTransaction`), HTTP real, varias réplicas de la API, FK omitidas (6) y esquema reducido a 5 tablas.
- La API arrancada de punta a punta (UI → solicitud → respuesta → persistencia → recarga).
- `openapi/openapi.yaml`, `openapi/ENDPOINTS.md` e inventario generado: hay ruta nueva y campos nuevos sin reflejar (requieren infraestructura levantada).
- Autorización negativa del endpoint público más allá de la firma; refunds por la pasarela; modo `wallet`; varias deudas por intención; la factura de `billing`.
- Suite completa de la API tras el último commit (la corrida previa tuvo un único rojo, `xlsx-parser.spec.ts`, clase `ENVIRONMENT`: `cdn.sheetjs.com` bloqueado por el proxy).

## Ambigüedades y decisiones (supuesto → a quién confirmar)

1. Dónde se despacha el cobro (movido a `processTransaction`; el carril decía «al crear un cobro») → P3 / dueño de M42.
2. Riesgo `REVIEW`: el camino viejo lo deja pasar; con la pasarela se bloquea (conservador) → dueño de M42.
3. `expired` → `PI_FAILED` (no existe `PI_EXPIRED`) → dueño de M42.
4. Tras `failed`/`canceled`/`expired` la deuda vuelve a `DEBT_PENDING` y el checkout se cierra como expirado → P3 / producto.
5. La factura de `billing` no se actualiza desde payments → dueño de billing.
6. Con el flag apagado el receptor responde 503 (no 410, que haría que la pasarela deshabilite el endpoint): los cobros en vuelo no se aplican hasta reencender → P1 / P3.
7. Se reutiliza el `gatewayId` de la intención porque `payment_webhook_events.gateway_id` es obligatorio; una fila propia exige seed y cambio en el repo del modelo → dueño del modelo / P3.
8. Falta el índice `ix_payment_intents_gateway_intent_ref` (propuesta para `mantra-core-health-model`; no se hizo).
9. Nada impide configurar una `sk_live_` con el flag encendido → P1.
10. Un cobro ambiguo se retoma solo si el cliente repite la operación; no hay job de reconciliación → decidir quién lo hace y cuándo se escala a una persona.
11. La reserva de despacho vive en `gateway_intent_ref` con el prefijo `dispatching:`. Un endurecimiento posible para el repo del modelo es un `UNIQUE` parcial por deuda sobre intenciones despachadas y no terminales, y una columna propia de reserva con su fecha; no se hizo ni es necesario para cerrar N2/N4 → dueño del modelo / P3.
12. El plazo para pasar a «requiere conciliación» (15 minutos como mínimo, 4 × el peor caso de la llamada) y el margen de 1 h bajo las 24 h de retención de la clave son supuestos → P3 / dueño de M42.
13. Una intención con propósito `DEBT` o con referencia de origen de tipo desconocido, sin sesión de checkout, se rechaza (422) en vez de cobrarse sin medir la deuda → P3 / dueño de M42 (y el front debe enviar `payment_debt`).

## 10 · Re-revisión independiente de las correcciones (ola 5)

Informe completo: [RE-REVISION-API-INT.md](../integracion/revision/RE-REVISION-API-INT.md). Conclusión del revisor: **B1 (RLS) quedó cerrado de verdad** (17/17 con rol `NOBYPASSRLS` y la política real; la elevación a contexto SYSTEM no se alcanza antes de verificar la firma, 0 sentencias SQL con firma inválida; 18 conexiones del pool inspeccionadas, 0 contaminadas). **Aun así no recomienda encender el flag** hasta cerrar:

| # | Severidad | Qué | Estado |
|---|---|---|---|
| N1 | MAYOR (afecta con el flag APAGADO) | `.replace(/\/+$/u,'')` cuadrático en `payments-gateway-raw-body.ts:20`, corre antes de autenticar: 15 000 `/` ≈ 240 ms de event loop por petición (lo introdujo la corrección de m1) | corregido en la API (lineal; 100 000 `/` en menos de 5 ms); falta re-revisión independiente |
| N2 | MAYOR | La compuerta de M2 no reserva la deuda antes de llamar a la pasarela: 8/8 rondas con 2 `pi_` vivos si `RLS_ENFORCE=false` | corregido en la API con una reserva solo-aplicación (marca de despacho confirmada antes de llamar); falta re-revisión independiente |
| N3 | MENOR | La compuerta se esquiva si `sourceRefType` ≠ `'payment_debt'` exacto y no hay sesión | corregido en la API (falla cerrado con 422); falta re-revisión independiente |
| N4 | MENOR | Tras un 504 la deuda no queda reservada ⇒ 2 `pi_` vivos | corregido con N2 (la reserva sobrevive al 504); falta re-revisión independiente |
| N5 | MENOR | Con `RLS_ENFORCE=true` el lock de la deuda y una conexión del pool se sostienen durante la llamada HTTP (el comentario dice lo contrario) | corregido en la API: la llamada no sostiene bloqueos de fila; la conexión de la transacción de la petición con `RLS_ENFORCE=true` sigue tomada (riesgo documentado arriba); falta re-revisión independiente |
| N6 | MENOR | Interbloqueo 40P01 entre dos webhooks sobre la misma deuda (20–30 de 40 rondas) | corregido en la API (0 de 40 rondas); falta re-revisión independiente |
| N7 | MENOR | Oráculo de existencia por tiempo (~700 ms vs 5 ms) por bloquear la intención ajena antes de comparar tenant | corregido en la API; falta re-revisión independiente |
| N8 | MENOR | Intención de factura cobrada: `processed=true` y nada llega a billing | abierto (dueño de billing) |

`INT.H1.M3` y `INT.H1.M2` siguen `A MEDIAS` hasta que una re-revisión independiente confirme las correcciones de N1–N7. Siguen abiertos m2 (`sk_live_`/`http://` con el flag), m3, m4, m7, m8 y m9 de la primera revisión.

## 11 · Tercera revisión independiente (sobre 97eaa006c, marca `dispatching:`)

Informe: [TERCERA-REVISION-API-INT.md](../integracion/revision/TERCERA-REVISION-API-INT.md) (105/105 y 18/18 en sus arneses). **Lo central resistió:** con 3 despachos simultáneos sobre la misma deuda hubo siempre un solo cobro (20 rondas por modo, `RLS_ENFORCE` falso y verdadero); la marca nunca se trata como un `pi_` real (el receptor exige `^pi_…`); N1 (100 000 barras en 0,35 ms), N5, N6 (0 × `40P01` en 160 rondas) y N7 quedaron cerrados; con el flag apagado no hay regresión; sin restos de mutaciones ni literales de clave.

| # | Severidad | Qué | Estado |
|---|---|---|---|
| P1 | **BLOQUEANTE con `RLS_ENFORCE=true`** | Espera circular de conexiones: el interceptor retiene una conexión toda la petición y `runCommitted` pide una segunda; con pool 10 pasan 9 simultáneas y 10 se cuelgan todas, y `pg` espera sin límite (sin `connectionTimeoutMillis`) ⇒ se cuelga todo acceso a la base | corrección en curso (evitar la 2.ª conexión o semáforo < pool/2 + `connectionTimeoutMillis`) |
| P2 | MENOR con consecuencia de dinero | `releaseReservation` borra la marca de otra petición en vuelo de la misma intención ⇒ 2 cobros vivos | en curso (compare-and-set) |
| P3 | MENOR | Cualquier 4xx libera la reserva sin mirar el cuerpo del contrato (regla 11) | en curso |
| P4 | MENOR | Expiración de la marca a los 15 min | en curso (no es permiso para cobrar; conciliación explícita) |
| P5 | MENOR (preexistente) | Cobro huérfano ⇒ webhook terminal 404 que la pasarela reintenta | abierto, documentado |
| P6 | MENOR | Intención con marca sin salida por API (409 «ya tiene un cobro» aunque no se creó nada): trampa de rollback | en curso (conciliación + runbook) |
| P8 | MENOR | Catálogo de `sourceRefType` (solo `payment_debt` y `EDUCATION_COURSE`) a acordar con el front | abierto (decisión con el front) |
| P9 | MENOR | El reintento con marca vuelve a evaluar el riesgo (un `REVIEW` posterior al 504 impide recuperar un cobro que sí existe) | en curso |

**Conclusión del revisor:** con el flag apagado no hay regresión; encendido con `RLS_ENFORCE=false` no hay bloqueantes; **con `RLS_ENFORCE=true` hay un bloqueante (P1)**, así que `INT.H1.M3` no se marca HECHA todavía. Supuesto declarado: producción usará `RLS_ENFORCE=true` (confirmar con quien opere el despliegue). Condiciones para encender el flag: cerrar P1, P2 y P3; alertas sobre el log de reservas vencidas y sobre los terminales 404; acordar P8 con el front; runbook para marcas colgadas y cobros huérfanos.

## 12 · Verificación del delta 2 (b881a4f15) — D8 y D9 en `close`

Informe: [VERIFICACION-DELTA-2-API-INT.md](../integracion/revision/VERIFICACION-DELTA-2-API-INT.md). **Cerrados (confirmado ejecutando):** D1 (el riesgo se exige también con reserva; REVIEW/DECLINE posterior frena el reintento y la conciliación; APPROVE posterior destraba con un solo cobro; 30 rondas DECLINE vs despacho sin cobro tras DECLINE), D3 (`parseProblem` estricto: reconoce los 23 códigos reales del catálogo y rechaza JSON ajeno), D4 (marcas sin fecha o con fecha futura listables y cerrables) y **toda la autorización de D2** (401/403/404 idéntico a inexistente, sin mass assignment, motivo 10–300).

| # | Severidad | Qué | Estado |
|---|---|---|---|
| D8 | MAYOR (confirmado 36/36 rondas, RLS true y false) | `close` decide «vencida» con la fecha original de la marca: un reintento del dueño ya confirmado y con su HTTP en curso parece vencido ⇒ la intención queda cancelada con el `pi_` asociado, el QR se entrega, la deuda queda libre y otra intención cobra ⇒ 2 cobros vivos. Un CAS sobre la marca no alcanza (`close` lee después del commit) ni un lock de fila (el reintento no retiene ninguno durante su HTTP) | última ronda de corrección: `close` exige `updated_at` vencido + `associate` no entrega QR a una intención cancelada |
| D9 | MAYOR (MENOR si el front solo usa `payment_debt`) | `close` no libera las sesiones de checkout: la deuda queda `IN_CHECKOUT` sin salida | última ronda |
| D10 | MENOR | Un DECLINE registrado con el primer envío en vuelo responde 201 pero no detiene el cobro (27/30) | lo cubre D8 (2) |
| D11–D13 | MENOR | motivo acepta basura; `close` repetible; cobro huérfano tras `close` sin alerta | última ronda si caben |

Regla acordada: **esta es la última ronda de corrección.** Si la verificación corta del resultado encuentra otro MAYOR, no se itera más: el flag `PAYMENTS_VIA_GATEWAY` queda documentado como **«no encender»** y `INT.H1.M3` en `A MEDIAS`. Mientras D8 y D9 estén abiertos, la alternativa operativa es no desplegar la ruta `close`.
