# Revisión adversarial — carril INT en `mantra-core-health-api`

- Revisor: independiente del implementador y del integrador. SOLO LECTURA sobre el repo de la API (rama `claude/adoring-allen-ly7r6f`).
- Alcance: commits `78ed77d6`, `38351ad4`, `aa38ddbe`, `77dd6ec9` (el HEAD ya avanzó a `ea22ef3f`; los dos commits nuevos solo agregan/ajustan `test/integration/payments-gateway-charge.int-spec.ts`, no tocan `src/`).
- Marco: `AGENTS.md` de la API (PHI, autorización por rol Y propiedad, BOLA/IDOR, mass assignment, idempotencia, errores sin SQL/stack).
- Evidencia reproducible: [`REVISION-API-INT.evidencia/`](./REVISION-API-INT.evidencia/) (specs de la revisión, que viven FUERA del repo de la API, y sus salidas).
- Cada hallazgo dice si lo **CONFIRMÉ ejecutando** o es **INFERENCIA** (lectura de código).

## Resumen por severidad

| Sev. | # | Hallazgo | Estado de la prueba |
|---|---|---|---|
| **BLOQUEANTE** (para encender el flag; no bloquea mergear con el flag apagado) | B1 | El receptor es `@Public()` y no fija contexto de tenant: bajo RLS (rol de aplicación sin `BYPASSRLS`) todo `succeeded/failed/...` da 404 para siempre y los no terminales se descartan con 200 | CONFIRMADO ejecutando (BD real, política RLS copiada textual) |
| **MAYOR** | M1 | Un cobro `succeeded` de una intención sin sesión de checkout queda `applied:true`, `reconciliationRequired:false` y la deuda NO se toca: pago sin rastro de conciliación | CONFIRMADO ejecutando |
| **MAYOR** | M2 | Nada impide, antes de despachar, cobrar de más o dos veces la misma deuda (otra clave local = otra intención = otro QR); el sobrepago solo se detecta después, y `processed=false` no lo consume nadie | CONFIRMADO ejecutando (detección post-hoc) + INFERENCIA (no hay compuerta previa) |
| **MAYOR** | M3 | `processTransaction` carga la intención solo por UUID, sin comparar tenant: la única barrera es RLS (`RLS_ENFORCE=false` por defecto). Con el flag encendido un cajero de otro tenant crea un cobro real en la pasarela para una intención ajena y recibe su QR/cuenta bancaria | INFERENCIA fuerte (código sin filtro de tenant; no ejecutado por HTTP) |
| MENOR | m1 | Peticiones NO autenticadas devuelven 500 y escriben un `error` de log (content-type distinto de JSON, cuerpo vacío, barra final, mayúsculas en la ruta) | CONFIRMADO ejecutando |
| MENOR | m2 | Nada impide `sk_live_` con el flag encendido ni `http://` con una clave live | INFERENCIA (lectura; el propio informe lo anota como ambigüedad 9) |
| MENOR | m3 | Evento terminal de un `pi_…` desconocido: 404 y NINGÚN rastro persistente; si los reintentos se agotan, el dinero cobrado no queda en ninguna bandeja | CONFIRMADO ejecutando el 404; el resto INFERENCIA |
| MENOR | m4 | La unicidad del cobro descansa 100 % en la idempotencia de la pasarela (24 h); `paymentMethodType` no se persiste | INFERENCIA |
| MENOR | m5 | `fx-lock`, `risk-assessment` y `splits` siguen permitidos sobre una intención ya despachada | INFERENCIA |
| MENOR | m6 | `releaseDebt` libera la deuda aunque otra intención tenga una sesión abierta sobre ella | INFERENCIA |
| MENOR | m7 | Sin índice ni UNIQUE en `gateway_intent_ref` (el código asume unicidad) | INFERENCIA (DDL) |
| MENOR | m8 | Superficie pública: cuerpo de hasta 1 MB leído antes del throttle; el 401 y el 503 distinguen causas | CONFIRMADO ejecutando (413/401/503) |
| MENOR | m9 | `next_action` se reenvía sin validar; `dispatch` compara importe pero no moneda; `consult` no compara nada | INFERENCIA |

Lo que intenté romper y **resistió**: firma (15 000 casos diferenciales contra la librería de referencia, 0 divergencias), cuerpo crudo vs re-serializado, cabeceras duplicadas, ventana anti-replay, claves `v1`/`v1a` cruzadas, flag apagado, secretos en el repo, PHI en logs/payload, regresión del camino viejo. Detalle al final.

---

## B1 — BLOQUEANTE (para encender el flag): el receptor no ve nada bajo RLS

- **Dónde:** `src/modules/payments/controllers/payments-gateway-webhooks.controller.ts:30` (`@Public()`), `src/common/tenant/tenant-context.interceptor.ts` (`if (isPublic) return next.handle()` antes de fijar `app.current_tenant_id`), `src/modules/payments/services/payments-gateway-webhook.service.ts:305` (`findByGatewayIntentRefForUpdate`) y `:441` en adelante (`settleDebt`, `releaseDebt`).
- **Escenario:** producción corre con un rol sin `BYPASSRLS` (`runtime-role.guard.ts` aborta el arranque si no) y `RLS_ENFORCE=true`. La pasarela entrega `payment_intent.succeeded` firmado y correcto. La política `tenant_isolation` (`database/SQL/patches/2026-08-05_tenant_rls.sql`) es fail-closed sin `app.current_tenant_id` ni `app.system_context`; `payment_intents`, `payment_debts` y `payment_checkout_sessions` tienen `tenant_id`. La consulta devuelve 0 filas → `ResourceNotFoundException` (404) en cada reintento; los eventos no terminales (`processing`, `requires_action`) devuelven **200 con `ignored:true`**. El cliente pagó, la pasarela cobró, la intención sigue `PI_PENDING` y la deuda `DEBT_IN_CHECKOUT`. Tras las entregas agotadas la pasarela deshabilita el endpoint (`too_many_failures`, `public-v1.yaml:523`).
- **CONFIRMADO ejecutando:** base descartable en el Postgres de 127.0.0.1:54321 con el DDL real de `42_payments`, política copiada textual, rol `NOSUPERUSER NOBYPASSRLS`, servicio y repositorios reales, sin GUC. Superusuario (control): `applied:true`. Rol de aplicación: `succeeded` → `ResourceNotFoundException status=404 reason=PAYMENT_INTENT_NOT_FOUND`, intención sin cambio; `processing` → `{"ignored":true}`. Salida en `REVISION-API-INT.evidencia/resultados-rls.txt`; fuente `rls.int-spec.ts`.
- **Por qué no lo vio nadie:** `test/integration/payments-gateway-webhook.int-spec.ts` y `...charge.int-spec.ts` conectan como `postgres` (superusuario) y sin RLS.
- **No confirmado:** el recorrido completo por `AppModule` (no se levanta aquí). Sí es INFERENCIA que el callback legado `POST /payments/callbacks/:path` (también `@Public()`) tiene el mismo problema latente; no lo ejecuté.
- **Dirección de arreglo (no la apliqué):** resolver la intención bajo una elevación de sistema local a la transacción (`set_config('app.system_context','true',true)`) y, ya conocido el tenant de la intención, fijar `app.current_tenant_id` para el resto; más una prueba de integración con un rol sujeto a RLS.

## M1 — MAYOR: un pago sin sesión de checkout se asienta sin dejar rastro de conciliación

- **Dónde:** `payments-gateway-webhook.service.ts:449` (`if (sessions.length === 0) return true;`) y `:366` (`reconciliationRequired = !(await this.settleDebt(...))`).
- **Escenario:** una intención creada con `sourceRefType='payment_debt'`/`sourceRefId=<deuda>` (así la construye la prueba del propio carril) pero sin sesión de checkout que la ligue (`paymentIntentId` es opcional en `openSession`, `payments-checkout.service.ts:92`). El pago llega: la intención pasa a `PI_SUCCEEDED`, `applied:true`, **`reconciliationRequired:false`**, `processed=true`. La deuda sigue con su saldo completo. `settleDebt` ignora `sourceRefId`.
- **CONFIRMADO ejecutando** (BD real, superusuario): `SIN SESION => {"applied":true,"reconciliationRequired":false,"decision":"aplicar"} deuda: 150.000000 DEBT_IN_CHECKOUT`. Salida en `resultados-deuda.txt`.
- **Impacto:** dinero cobrado, deuda abierta, y ninguna cola (`processed=false`) lo muestra.

## M2 — MAYOR: sin compuerta previa contra la deuda; el sobrepago y el doble pago se detectan tarde

- **Dónde:** `payments-transactions.service.ts:346-405` (`processViaGateway`: `assertWithinBalance` mide contra transacciones locales capturadas, no contra `outstanding_amount` de la deuda ni contra otras intenciones abiertas) y `payments-intents.service.ts:100-150` (el `amount` y el `sourceRefId` de la intención vienen del cuerpo; no se verifican contra la deuda).
- **Escenarios:** (a) dos clics del front con `idempotencyKey` distintas sobre la misma deuda → dos intenciones, dos `pi_…`, dos QR; el pagador paga los dos. (b) intención de 150 sobre una deuda de 100.
- **CONFIRMADO ejecutando** (post-hoc): dos intenciones de 150 sobre la misma deuda → el primero salda, el segundo `reconciliationRequired:true` y su fila en `payment_webhook_events` con `processed=false`. Intención de 150 sobre deuda de 100 → `reconciliationRequired:true`, la deuda queda en 100 / `DEBT_IN_CHECKOUT`. El diseño de no resolver por inferencia es correcto; lo que falta es evitar el segundo cobro **antes** de despachar. **INFERENCIA:** no encontré ningún consumidor de `processed=false` (ni job, ni alerta) más allá de un `logger.warn`.
- **Dirección:** antes de `dispatch`, exigir una sesión abierta que ligue la intención a una deuda del mismo tenant con `intent.amount <= outstanding_amount`, y rechazar si la deuda ya tiene otra intención con `gatewayIntentRef` no terminal.

## M3 — MAYOR: `processTransaction` no comprueba el tenant del recurso (BOLA)

- **Dónde:** `payments-transactions.service.ts:360` (`findByIdForUpdate(tx, intentId)` → `em.findOne(PaymentIntents, { id })`, `payment-intents.repository.ts:~130`), sin `assertResourceInTenant` ni `requireTenantId()`; `charge.service.ts:306-330` (`associate`) igual. El `TenantContextInterceptor` solo compara campos de propiedad declarados (`tenantId`) en ruta/cuerpo/query, no el dueño del `:id`.
- **Escenario:** un `CASHIER` del tenant A conoce (o filtra) el UUID de una intención del tenant B, con riesgo `APPROVE`. Con `RLS_ENFORCE=false` (por defecto, `docker-compose`/`.env.example`) llama `POST /payments/intents/{id}/transactions` con `operation:'SALE'` y `paymentMethodType:'bank_transfer'`: la API crea el cobro en la pasarela y devuelve `nextAction` (referencia, banco, titular y número de cuenta, o el QR). Con RLS activo lo frena la base, no el servicio.
- **Matiz:** el patrón es heredado (el camino viejo tampoco filtra); con el flag encendido pasa de mutar un estado local a crear un cobro real en un tercero y devolver datos de pago. Requiere rol `PAYMENTS_ADMIN/CASHIER` y el UUID. No lo ejecuté por HTTP.
- **Test que falta:** matriz negativa (otro tenant ⇒ 404 idéntico a inexistente) en `payments-intents.gateway.spec.ts`; hoy no hay ninguna.

## m1 — MENOR: 500 + log `error` para peticiones no autenticadas

- **Dónde:** `payments-gateway-webhook.service.ts:137-149` (cuerpo crudo ausente ⇒ 500 y `logger.error`); `payments-gateway-raw-body.ts:32` (igualdad exacta de la ruta).
- **CONFIRMADO ejecutando** (Nest real, sin `bodyParser:false`, mismo `verify` que `main.ts`; resultados en `resultados-http-y-firma.txt`): `Content-Type: text/plain` → 500 (1 log de error); sin cuerpo, sin firma → 500; `POST /payments/gateway-webhooks/` (barra final), aun con firma válida → 500; `/Payments/Gateway-Webhooks` (Express es insensible a mayúsculas) → 500; `//payments/...` → 404. Caso feliz y con `?x=1` → 200.
- **Impacto:** cualquiera sin credenciales sube la tasa de 5xx y llena el log de nivel `error` (hasta 600/min por IP); si alguien registra el endpoint en la pasarela con barra final, **todas** las entregas firmadas dan 500 para siempre. Falla cerrado (no hay bypass). Debería ser 400/415 y `warn`, y la captura de bytes debería comparar la ruta normalizada.
- **Resistió:** con `main.ts` tal cual (sin `bodyParser:false`), Nest detecta el middleware `jsonParser` ya instalado y no registra el suyo: el cuerpo crudo llega (caso A, 200).

## m2 — MENOR: `sk_live_` y `http://`

- **Dónde:** `payments-gateway.env.ts:33` (`API_KEY_PATTERN` admite `live`), `:39-48` (Joi admite `http`), `loadPaymentsGatewayConfig` no cruza clave y esquema ni clave y entorno.
- **Escenario:** staging con el flag encendido y una `sk_live_…` mueve dinero real (la regla 9 de `CLAUDE.md` de la pasarela lo prohíbe sin cuenta recaudadora y visto bueno T-03); con `http://` la clave viaja en claro en `Authorization`. Un `mode` live en el webhook solo se acepta si la clave es live, así que el chequeo de modo no lo frena.
- **Dirección:** exigir `https` con clave live y negar `sk_live_` fuera de `NODE_ENV=production` (o detrás de una variable explícita).

## m3 — MENOR: terminal desconocido sin rastro

- **Dónde:** `payments-gateway-webhook.service.ts:309-330`. Un `succeeded` de un `pi_…` sin intención local lanza 404 sin archivar nada (correcto para la carrera "el webhook llegó antes que la asociación"). Pero si el `pi_…` quedó huérfano (la API cayó entre la respuesta de la pasarela y `associate`, o se reintentó pasadas las 24 h y se creó otro), tras agotarse los reintentos no hay fila ni cola que diga que entró dinero. **CONFIRMADO** el 404 (parte B1); el huérfano es INFERENCIA.
- **Dirección:** al agotarse la espera razonable, archivar con `processed=false` o conciliar contra la pasarela (el informe ya lo lista como ambigüedad 10).

## m4 — MENOR: la unicidad del cobro es de la pasarela, y el método no se persiste

- **Dónde:** `payments-transactions.service.ts:398-405`, `charge.service.ts:224-300`.
- Dos `POST` simultáneos pasan la compuerta (el `FOR UPDATE` se suelta antes de la llamada HTTP) y ambos llaman con la MISMA clave: solo la idempotencia de la pasarela evita el doble cobro. Sus pruebas (`charge.int-spec` bloques 2 y 3) lo demuestran contra un **doble** que implementa esa idempotencia, no contra la pasarela real. **No pude romperlo:** no tengo el stack sandbox levantado.
- La clave es `sha256([tenant, tipo, deuda|factura, claveLocal])`: sin colisión entre tenants (confirmado por lectura y por su `idempotency.spec`), pero no incluye importe, moneda ni método. `paymentMethodType` no se guarda: reintentar tras un resultado ambiguo con otro método da `422 idempotency_key_reused` hasta que venza la retención de 24 h, y **pasadas las 24 h la misma clave crea un segundo cobro** (`common.yaml:58`). Mitigación: persistir el método, o no reintentar pasadas las 24 h sin consultar.

## m5 — MENOR: mutaciones sobre una intención ya despachada

- `lockFxRate` solo exige `PI_PENDING` (`payments-intents.service.ts:192`), y `requires_action` se mapea a `PI_PENDING`; cambia `amount` y moneda de una intención con QR vivo. `assessRisk` con `DECLINE` pone `PI_FAILED` sin mirar el estado (heredado, `:287`). El pago posterior termina en `contradiccion`/`reconciliationRequired` (sin pérdida silenciosa, requiere `PAYMENTS_ADMIN`), pero el cobro en la pasarela no se cancela. Con `gatewayIntentRef` presente, esas rutas deberían rechazar.

## m6 — MENOR: `releaseDebt` y varias intenciones

- `payments-gateway-webhook.service.ts:492-519`: al expirar/fallar una intención, la deuda vuelve a `DEBT_PENDING` aunque otra intención conserve una sesión `CHECKOUT_OPEN` sobre ella; se podría abrir un tercer checkout. Solo cuando la deuda está en `DEBT_IN_CHECKOUT` y sin otras sesiones abiertas debería liberarse.

## m7 — MENOR: `gateway_intent_ref` sin índice ni UNIQUE

- `database/SQL/42_payments/02_tables.sql:79` (sin índice en `04_indexes.sql`). El comentario de `findByGatewayIntentRefForUpdate` afirma unicidad que ninguna constraint impone, y cada entrega firmada hace un barrido secuencial con `FOR UPDATE`. Reconocido en el informe (ambigüedad 8); queda a cargo del repo del modelo.
- Nota fuera de alcance: `uq_payment_intents_idempotency_key` es UNIQUE sobre `idempotency_key` **solo**, no `(tenant_id, idempotency_key)`: dos tenants no pueden usar la misma clave local y el segundo recibe un 23505 que revela que el valor existe en otro tenant. No introducido por INT, pero rige la clave determinista.

## m8 — MENOR: superficie pública

- **CONFIRMADO ejecutando:** cuerpo de 2 MB → 413 (el límite de 1 MB del `json()` global rige; el parseo ocurre antes del `@Throttle`, que no acota el costo de lectura); `reason` distinto para ventana (`GATEWAY_CALLBACK_OUTSIDE_REPLAY_WINDOW`) y firma (`GATEWAY_WEBHOOK_SIGNATURE_INVALID`) más `details.code` (`missing_headers`, `invalid_timestamp`, ...); el 503 con el flag apagado expone `GATEWAY_WEBHOOKS_DISABLED` a internet. Ninguno revela claves ni cuerpo. El límite `600/min` es por IP y usa `req.ip`: sin `TRUST_PROXY_HOPS` correcto todo el tráfico detrás del proxy comparte un cubo (un atacante agota el cupo de la pasarela). Un tope propio de 64 KB para esta ruta bastaría.

## m9 — MENOR

- `payments-gateway.client.ts` `parseIntent` no valida `next_action` (p. ej. el esquema de `redirect_to_card_form.url`) y el DTO lo reenvía al front; `charge.service.ts:262` compara `amount_minor` pero no `currency`; `consult` (`:344`) no compara importe ni moneda. La pasarela es de confianza, pero un `next_action` malformado llega tal cual al navegador.

---

## (c) Regresión con el flag apagado

Comparé el camino viejo contra `4e64353a` línea a línea (`git diff 4e64353a HEAD -- payments-transactions.service.ts`). Las comprobaciones extraídas (`assertIntentOpen`, `assertNoBlockingOpenOperation`, `assertRiskCleared(…, false)`, `assertWithinBalance`) conservan **el orden, los mensajes, los códigos y los `details`** del original; `REVIEW` sigue pasando. Cambios observables con el flag apagado:

1. **Nuevo 409 `PAYMENT_INTENT_VIA_GATEWAY`** (`payments-transactions.service.ts:136-143`) para una intención con `gatewayIntentRef`. Solo alcanzable si el flag estuvo encendido antes (el camino viejo nunca escribe esa columna: `grep gatewayIntentRef` solo en archivos de la pasarela). Aceptable y deseable; es un cambio de comportamiento del endpoint.
2. `ProcessTransactionDto` acepta `paymentMethodType` (`@IsIn`) y lo ignora; un valor inválido ahora da 400 como cualquier campo mal formado. Antes, un campo extra daba 400 (whitelist). Sin regresión para clientes existentes.
3. Existe una ruta pública nueva (`POST /payments/gateway-webhooks`) que responde 503 sin hacer trabajo criptográfico ni tocar la base con el flag apagado.
4. `main.ts`: el `json()` global lleva un `verify` que solo copia el buffer en esa ruta.
5. Joi: `.concat(paymentsGatewayEnvSchema)` con `.unknown(true)` igual que `webAnalyticsEnvSchema`; `PAYMENTS_VIA_GATEWAY` solo acepta booleanos de Joi (`1`/`yes` hacen fallar el arranque: falla cerrado).

No encontré divergencia. **No cubierto:** no corrí los specs del camino viejo (`payments-transactions.service.spec.ts`, `payments-intents.service.spec.ts`): el candado `/tmp/pay-heavy.lock` estuvo ocupado por otros procesos durante toda la sesión. Lo afirmado sale de leer el diff. El bloque (7) de `charge.int-spec.ts` (camino viejo contra BD real) existe, pero tampoco lo ejecuté.

## (d) PHI/PII

Resistió. El cuerpo enviado a la pasarela es `{amount_minor, currency:'BOB', payment_method:{type}, expires_in_seconds?}` (`charge.service.ts:151-186`); sin `metadata` y sin ids de paciente, deuda ni factura. Cabeceras: `Idempotency-Key` es un SHA-256 y `X-Request-Id` lleva `mantra-<uuid de intención>` (id interno, no dato de salud). Logs: solo `operation`, `intentId`, `eventId`, `decision`, `status`, `gatewayCode`, `requestId`; los errores del cliente descartan el cuerpo de la pasarela y `retryHeaders` solo conserva `Retry-After`; la clave de API solo va en `Authorization` y `attempt()` descarta el error de axios. Respuestas de error: sin SQL ni stack (el 500 es genérico `INTERNAL`). `payment_webhook_events.payload_json` guarda `event.data` de la pasarela, firmado y con política "solo ids, estados e importes". Riesgo residual: lo que la pasarela decida poner en `data.object` se archiva sin filtrar.

## (e) Configuración y secretos

- Secretos en el repo: **ninguno**. `grep` sobre el diff completo: los únicos `whsec_/whpk_` literales son vectores sintéticos de `standard-webhook-signature.parity.spec.ts` (bytes `01..20`) y `TEST_API_KEY` se arma en ejecución; `*.testing.ts` está excluido de `tsconfig.build.json`. `.env.example` deja todo vacío.
- Validación al arranque: Joi exige URL, clave y secreto con el flag encendido y `loadPaymentsGatewayConfig` (fábrica del proveedor) valida formato de `whsec_/whpk_` y falla al construir el módulo; el mensaje nombra la variable, no el valor. Sin flag no se exige nada. Resistió.
- Con `sk_live_` y flag encendido: ver m2.

## (f) Verificador de firma copiado vs referencia

`src/modules/payments/gateway/standard-webhook-signature.ts` vs `contracts/packages/webhook-signature/src/index.ts`: lectura de ambos y **prueba diferencial ejecutada** (`diff.spec.ts`): 15 000 casos (5 cuerpos incl. binario y UTF-8, 2 conjuntos de firmas v1/v1+v1a, 20 mutaciones de cabeceras — mayúsculas, valores en array, espacios, tabs, comas dobles, base64 sin relleno / URL-safe / con cola, `V1` en mayúsculas, ceros a la izquierda, `+`, dígitos árabes, 13 dígitos, id vacío —, 5 listas de confianza, 5 desfases de reloj, 3 tolerancias) contra `dist/index.js` de la referencia: **0 divergencias**.

Comportamientos compartidos por ambos (no son divergencias, pero conviene saberlos):
- La decodificación base64 de Node es permisiva: una firma válida con basura **después** del relleno `=`, o sin relleno, **verifica** (`firma con 3 bytes de cola => ok`). No es una falsificación (hace falta el MAC válido) pero hace maleable la cabecera; por eso la deduplicación debe seguir siendo por `webhook-id` y nunca por `webhook-signature`, como hoy.
- Con cabeceras duplicadas, Node las une con `, `: `webhook-id`/`webhook-timestamp` duplicados no verifican; `webhook-signature` duplicado sí (el primer candidato conserva la coma final y se decodifica igual).
- Marcas de tiempo futuras dentro de ±300 s se aceptan.
- La API no puede importar la librería; los vectores de `parity.spec.ts` son estáticos, así que si la referencia cambia nada avisa. Conviene un contrato de versión o regenerar los vectores en CI.

## (a) Receptor público — qué intenté y qué pasó

| Intento | Resultado |
|---|---|
| Firma por comparación no constante | `timingSafeEqual` con longitudes iguales en `v1`; `v1a` por `crypto.verify`. Sin hallazgo |
| Cuerpo re-serializado vs crudo | Se firma sobre `rawBody` y `JSON.parse(rawBody)` se usa para el contenido; nunca `req.body`. Espacios, saltos de línea y acentos pasan (caso A) y un byte distinto da 401. Sin hallazgo |
| Cambiar `webhook-id` sin cambiar la firma | Cubierto por la firma; además `headerId !== event.id` ⇒ 422 |
| Mezclar `v1` con claves públicas y viceversa | Con solo `secrets` una firma `v1a` no verifica (y al revés). Dentro del diferencial, 0 divergencias |
| Replay | Ventana ±300 s (`webhookToleranceSeconds` entre 30 y 3600); dentro de la ventana el mismo `webhook-id` devuelve `duplicate:true` sin repetir efectos (UNIQUE `uq_payment_webhook_events_gateway_event_ref` + `FOR UPDATE`; cubierto por la int-spec del integrador, no re-corrida por mí). Las entregas de la pasarela se refirman con la hora del intento (`delivery.worker.ts:156`), así que los reintentos no caen fuera de ventana |
| Content-Encoding / charset | `charset=utf-16` ⇒ 400 antes del servicio; gzip, no concluyente en mi arnés |
| Fugas | Ver m8; ninguna de claves ni cuerpo |
| DoS por cuerpo grande | 413 a 1 MB. Ver m8 |
| Rate limit | `@Throttle` 600/min por IP; ver m8 |
| Flag apagado | 503 antes de leer cuerpo o hacer HMAC; sin efecto |
| Modo `test/live` | Evento de otro modo ⇒ 422 (`PreconditionFailed`) antes de tocar la base |

## (b) Camino de cobro — qué intenté y qué pasó

| Intento | Resultado |
|---|---|
| Monto/moneda desde el cliente | El importe enviado sale de `intent.amount` persistido (`decimalToMinorUnits`, sin redondeo); `dto.amount` solo se acepta si es igual (`PAYMENT_GATEWAY_AMOUNT_MUST_MATCH_INTENT`). Pero el `amount` persistido lo puso el cliente en `createIntent` (ver M2). Moneda ≠ BOB ⇒ 422 |
| Doble cobro por dos `POST` simultáneos | Ver m4: lo evita la pasarela; no lo pude romper sin ella |
| Reintentar un cobro ya despachado | `gatewayIntentRef` ⇒ `consult` (GET), no crea otro. `PI_PROCESSING` sin referencia ⇒ 409 |
| Estado de la deuda por evento | `requires_action`/`processing`: sin cambio. `succeeded`: salda o descuenta solo si hay exactamente una deuda del mismo tenant, BOB, no saldada, positivo y sin exceder el saldo; si no, **no toca la deuda y archiva `processed=false`** (confirmado, ver M1/M2). `failed/canceled/expired`: cierra la sesión y la deuda vuelve a `DEBT_PENDING` (ver m6). Retrocesos y contradicciones entre terminales no sobreescriben (`decideGatewayEvent`) |
| Importe distinto en el webhook | `succeeded` con `amount_minor`/moneda distintos ⇒ `contradiccion`, intención sin cambio |
| Colisión de `Idempotency-Key` entre tenants | La clave incluye `tenantId` y se serializa con `JSON.stringify` de un arreglo (el `|` en `localIdempotencyKey` no mueve fronteras). Sin colisión |
| Mass assignment | `paymentMethodType` está en lista blanca (`@IsIn`); `operation` fuera de `SALE` ⇒ 422 |

## Qué NO cubrí (declarado)

- Ejecuté mi propio arnés contra el Postgres de 127.0.0.1:54321 (DB y rol descartables, ya eliminados); **no re-corrí** `payments-gateway-webhook.int-spec.ts` ni `payments-gateway-charge.int-spec.ts` ni los specs del camino viejo (candado `pay-heavy.lock` ocupado). Mis conclusiones sobre ellos salen de leerlos.
- No levanté `AppModule` ni la pasarela real/sandbox: M3, m4 y la ausencia de BOLA por HTTP son lectura de código, no ejecución. B1 está probado a nivel de base y servicio, no de la aplicación entera.
- No revisé `billing`/facturas (el informe lo deja fuera), reembolsos, `wallet`, ni la sección de `docs/` salvo lo necesario para ubicar el flag.
- Una reproducción del caso gzip quedó sin resultado concluyente en mi arnés.
