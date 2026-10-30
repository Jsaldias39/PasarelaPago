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
| N2 + N4 | **Reserva de despacho solo-aplicación.** La compuerta, con la deuda bloqueada, escribe una marca `dispatching:<uuid>` en `payment_intents.gateway_intent_ref` y la **confirma antes de llamar** a la pasarela. La compuerta contra la deuda cuenta como «en vuelo» a todo `pi_…` y a toda marca vigente. El `pi_…` reemplaza la marca; un rechazo definitivo la libera; un resultado ambiguo (504) la conserva. La propia intención no se bloquea a sí misma (misma clave, regla 11). Una marca más vieja que el plazo (15 min o 4 × el peor caso de la llamada) deja de bloquear a las OTRAS intenciones y queda en el log; no se borra. | `gateway/payments-gateway-dispatch-mark.ts`, `services/payments-transactions.service.ts` (`processViaGateway`, `assertDebtAllowsCharge`), `services/payments-gateway-charge.service.ts`, `services/payments-committed-transaction.ts` |
| N3 | Una intención sin sesión de checkout que puede ser una deuda (propósito `DEBT`, o referencia de origen de un tipo que no es `payment_debt` ni uno conocido como ajeno, hoy `EDUCATION_COURSE`) se rechaza con `422 PAYMENT_GATEWAY_DEBT_UNRESOLVED`. No hay catálogo ni enum de `source_ref_type`: es texto libre en el DTO. | `payments.source-refs.ts`, `services/payments-transactions.service.ts` |
| N5 | La llamada HTTP ya no sostiene bloqueos de fila (la compuerta y la asociación son transacciones cortas confirmadas, también con `RLS_ENFORCE=true` mediante un `EntityManager` bifurcado con el mismo contexto de tenant). El comentario de `processViaGateway` describe lo que sí pasa. | `services/payments-committed-transaction.ts` |
| N6 | `findOpenCheckoutSessionsByDebt` lee sin `FOR UPDATE`: la deuda, ya bloqueada, serializa la lectura. 40 rondas con rol `NOBYPASSRLS`: de 21 interbloqueos `40P01` a 0. | `repositories/payment-flow.repository.ts` |
| N7 | El tenant va en el mismo `WHERE` del `FOR UPDATE` (`findByIdAndTenantForUpdate`): la intención ajena no se espera ni se bloquea. Con la fila de la víctima bloqueada, la petición ajena responde antes de 500 ms y con el mismo cuerpo que un UUID inexistente. | `repositories/payment-intents.repository.ts`, `services/payments-transactions.service.ts` |

**Decisión de N2 y por qué.** No hace falta tocar el modelo: la marca vive en una columna que ya existe y que ya significa «esta intención tiene (o está creando) un cobro en la pasarela», lo que además hace que `lock fx`, `splits`, `risk-assessment DECLINE` y el camino directo al proveedor traten a una intención reservada como ya despachada. No se reutilizó `PI_PROCESSING` porque ya significa «operación abierta por el camino de siempre» y hay pruebas que lo exigen así. Una marca no puede resolverse por webhook (el receptor solo acepta `pi_[a-z0-9]{10,40}`) ni se consulta como si fuera un cobro. La expiración nunca borra la marca y ante una fecha ilegible bloquea.

**Riesgos que quedan (en presente).**

- Con `RLS_ENFORCE=true` el `TenantContextInterceptor` abre una transacción para toda la petición y esa conexión queda «idle in transaction» durante la llamada HTTP (hasta 3 × 10 s más esperas con los valores por defecto). Es propio del interceptor y alcanza a todas las rutas; con muchas llamadas lentas simultáneas se puede agotar el pool. No se midió con carga.
- Una marca vencida deja de bloquear: si la pasarela había creado ese cobro, existe un `pi_…` sin asociar que nadie vincula (m3). Queda el log con los ids de las intenciones afectadas. Si otra intención ya tomó la deuda, el reintento de la dueña de la marca vencida recibe 409 y ese `pi_…` hay que revisarlo a mano.
- Pasadas las 24 h de retención de idempotencia de la pasarela, repetir con la misma clave puede crear un segundo cobro (m4); el camino de salida de una marca lo hereda.
- Las pruebas de `RLS_ENFORCE=true` del camino de cobro simulan la transacción del interceptor sobre un usuario superusuario; no corren bajo el rol restringido.

**Anotados sin tocar (fuera de esta ronda, por pedido).** N8 (una factura cobrada no llega a `billing`: decisión del dueño de billing, ambigüedad 5), m2 (`sk_live_`/`http://`: política de despliegue, ambigüedad 9), m3 (terminal desconocido sin rastro: requiere definir quién concilia, ambigüedad 10), m4 (método de pago no persistido y retención de 24 h: requiere columna o decisión de producto), m7 (índice/UNIQUE de `gateway_intent_ref` y de la clave de idempotencia por tenant: repo del modelo), m8 (superficie pública: límites y `TRUST_PROXY_HOPS`), m9 (validación de `next_action`, moneda en la creación y en la consulta).

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
12. El plazo de la reserva (15 minutos como mínimo, 4 × el peor caso de la llamada) es un supuesto → P3 / dueño de M42.
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
