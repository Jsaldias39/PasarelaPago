# Re-revisión adversarial — carril INT en `mantra-core-health-api` (post-correcciones)

- Revisor: distinto del autor del informe previo ([REVISION-API-INT.md](./REVISION-API-INT.md)) y del que implementó las correcciones. SOLO LECTURA sobre el repo: no edité ni commiteé nada en `/home/user/mantra-core-health-api`. Las mutaciones y los specs propios se ejecutaron en un `git worktree` aparte (ya borrado) y las bases/roles creados (`mantra_it_rev*`) ya no existen (verificado contra `pg_database` y `pg_roles`).
- Alcance: rama `claude/adoring-allen-ly7r6f`, HEAD `08a0e0688`. Correcciones revisadas: `c75e36688` (B1) y `08a0e0688` (M1, M2, M3, m1, m5, m6). **Dato de trazabilidad:** el cuerpo real de M1/M2/M3/m5/m6 no está en `08a0e0688` (ese commit sólo trae formato, 3 líneas de `src/` y ajustes de tests) sino en el commit anterior `21db68bd8` ("wip … SIN VERIFICAR por el integrador"); revisé el estado final de HEAD, no los commits sueltos.
- Marco: `AGENTS.md` de la API, reglas 11 de la pasarela y 30/35/80 de la casa.
- Cada hallazgo dice si lo **CONFIRMÉ ejecutando** o es **INFERENCIA**.
- Evidencia: [`RE-REVISION-API-INT.evidencia/`](./RE-REVISION-API-INT.evidencia/) (specs propios `rev-b1-rls.int-spec.ts` y `rev-charge.int-spec.ts`, `redos-raw-body.cjs` y sus salidas).

## Conclusión

**Con RLS activo (`RLS_ENFORCE=true`, rol `NOSUPERUSER NOBYPASSRLS`), B1 está cerrado de verdad**: no logré romper el receptor (ver «Lo que intenté romper»), y bajo esa misma configuración la carrera residual de M2 queda cerrada por una razón que no es de diseño (ver N2/N5).

**Pero no recomiendo encender el flag todavía**, por dos hallazgos MAYOR nuevos o residuales:

1. **N1 (MAYOR, nuevo, introducido por la corrección de m1):** `isGatewayWebhookPath` ejecuta un `replace(/\/+$/u, '')` de coste cuadrático sobre la URL de **toda** petición con cuerpo JSON, antes de autenticar y **con el flag apagado**. Una URL de 15 000 `/` bloquea el event loop ≈ 220–330 ms por petición. Es una regresión con el flag APAGADO. CONFIRMADO ejecutando sobre Express real.
2. **N2 (MAYOR, residual declarado, ahora medido):** sin `RLS_ENFORCE=true` la ventana de la carrera de M2 no es «dos despachos casi simultáneos» sino **toda la latencia HTTP a la pasarela**; en mi prueba **8 de 8** rondas con dos intenciones sobre la misma deuda produjeron dos cobros vivos. CONFIRMADO ejecutando.

Qué falta para encender: (a) arreglar N1 (una línea); (b) cerrar N2 sin depender de la transacción envolvente (reserva commiteada antes de la llamada HTTP) **o** declarar y exigir `RLS_ENFORCE=true` como precondición del flag y medir N5; (c) N6 (interbloqueo introducido por la corrección de m6) es MENOR pero produce 500 en el receptor y conviene corregirlo con el mismo cambio; (d) decidir sobre los menores heredados que esta ronda no tocaba (m2 `sk_live_`, m3, m4, m7, m8, m9 siguen abiertos).

## Resumen por severidad

| Sev. | # | Hallazgo | Prueba |
|---|---|---|---|
| **MAYOR** | N1 | `isGatewayWebhookPath` (`gateway/payments-gateway-raw-body.ts:20`): `.replace(/\/+$/u,'')` cuadrático sobre `req.url` en el `verify` del `json()` global (`main.ts`); pre-auth y con el flag apagado | CONFIRMADO ejecutando |
| **MAYOR** | N2 | La compuerta M2 no reserva la deuda antes de la llamada HTTP: sin transacción envolvente, dos despachos concurrentes sobre la misma deuda dan dos `pi_…` vivos (8/8 rondas) | CONFIRMADO ejecutando |
| MENOR | N3 | La compuerta M2 se esquiva si `sourceRefType` no es exactamente `'payment_debt'` y no hay sesión de checkout (mayúsculas, otro texto o ausente) | CONFIRMADO ejecutando |
| MENOR | N4 | Tras un resultado ambiguo (504) la deuda no queda reservada: otra intención se despacha, hay 2 `pi_…` vivos y el reintento de la primera responde 409 (choca con la regla 11) | CONFIRMADO ejecutando |
| MENOR | N5 | Con `RLS_ENFORCE=true` los bloqueos de intención/deuda/sesiones y una conexión del pool se sostienen durante TODA la llamada a la pasarela (hasta 3 × 10 s + espera por defecto); el comentario de `processViaGateway` afirma lo contrario | Bloqueo CONFIRMADO ejecutando; agotamiento del pool es INFERENCIA |
| MENOR | N6 | Interbloqueo `40P01` entre dos webhooks de intenciones distintas sobre la misma deuda con dos sesiones abiertas (orden de bloqueo invertido por la corrección de m6) | CONFIRMADO ejecutando (20–30 de 40 rondas) |
| MENOR | N7 | M3: la intención ajena se bloquea con `FOR UPDATE` antes de compararla; con la fila de la víctima bloqueada la petición ajena espera (709 ms) y la inexistente responde en 5 ms: oráculo de existencia por tiempo | CONFIRMADO ejecutando |
| MENOR | N8 | Intención con propósito factura (`INVOICE`) cobrada: `processed=true` y nada en `billing` (ambigüedad 5 del informe) — sin cola que lo muestre | INFERENCIA (lectura) |
| MENOR (heredado) | m2, m3, m4, m7, m8, m9 | No eran parte de esta ronda de correcciones; siguen abiertos tal como los describe la revisión previa | INFERENCIA (lectura) |

Cerrados y verificados: **B1, M1, M3, m5, m6, m1 (el síntoma)**; **M2** cerrado parcialmente (N2–N4).

---

## N1 — MAYOR (nuevo): coste cuadrático en la captura del cuerpo crudo

- **Dónde:** `src/modules/payments/gateway/payments-gateway-raw-body.ts:20` (`(url ?? '').split('?')[0].replace(/\/+$/u, '')`), invocado por `captureGatewayWebhookRawBody` desde `json({ verify })` en `src/main.ts`.
- **Escenario:** el `verify` corre para **toda** petición cuyo cuerpo JSON se lee, sin autenticar, aunque la ruta sea otra y aunque `PAYMENTS_VIA_GATEWAY` esté apagado. La URL `"/" + "/".repeat(n) + "x"` hace que `/\/+$/` pruebe cada posición inicial y recorra la tira de barras entera: O(n²). Node acepta ≈ 16 KB de línea de petición.
- **CONFIRMADO ejecutando** (micro-medición y Express real con el mismo `verify`; `RE-REVISION-API-INT.evidencia/salida-redos.txt`):

```text
normal ms 30
slashes 4000  ms 20
slashes 8000  ms 69
slashes 15000 ms 243
```
  (en el microbenchmark aislado: 1 000 → 1,3 ms; 8 000 → 83 ms; 16 000 → 330 ms). Cada petición bloquea el único hilo; ≈ 4 peticiones/s bastan para saturar un proceso. Un proxy con línea de petición de 8 KB (p. ej. nginx por defecto) lo reduce a ≈ 60–80 ms, pero no lo elimina.
- **Por qué importa más que un menor:** el camino viejo (flag apagado) queda afectado; el informe previo y el del carril aseguran que con el flag apagado «no cambia nada» y esto es falso para toda la API.
- **Dirección (no aplicada):** acotar la longitud antes de normalizar (`url.length > 2 * GATEWAY_WEBHOOK_PATH.length` ⇒ `false`) o quitar las barras finales con un bucle lineal; ambas formas son O(n). Añadir un test con una URL de 16 000 barras que acote el tiempo.

## N2 — MAYOR (residual): la compuerta de M2 no reserva antes de llamar

- **Dónde:** `payments-transactions.service.ts:364-403` (la compuerta corre en su propia transacción y se suelta antes de `gateway.dispatch`, línea 405-411); `payment-flow.repository.ts:508-545` (`findInFlightGatewayIntentsOnDebt` exige `gatewayIntentRef != null`, que sólo se escribe en `associate` DESPUÉS de la respuesta de la pasarela).
- **Escenario:** dos intenciones A y B (claves locales distintas, mismo `sourceRef` de deuda) con `POST …/transactions` simultáneo (doble clic, dos cajeros). Ninguna ve a la otra «en vuelo» porque ninguna tiene `pi_…` todavía; ambas llaman a la pasarela con claves distintas ⇒ dos QR.
- **CONFIRMADO ejecutando** (`rev-charge.int-spec.ts` REV-M2a, PostgreSQL real, doble de la pasarela con 250 ms de latencia, 8 rondas): `rondas con DOS cobros vivos sobre la misma deuda: 8/8`.
- **La ventana es toda la latencia de la pasarela** (reintentos incluidos), no un instante. «Residual declarado» subestima su alcance.
- **Evaluación de aceptabilidad:** no aceptable para un entorno sin `RLS_ENFORCE=true`. El sobrepago se detecta después (webhook ⇒ `processed=false`), pero el dinero ya se movió y no hay consumidor de esa cola (INFERENCIA, sin cambios desde la revisión previa).
- **Cómo se cierra:** reservar antes de llamar. En la transacción de la compuerta, dejar commiteada una marca de despacho (p. ej. columna `dispatch_started_at` o pasar la intención a `PI_PROCESSING` con una marca) y que `findInFlightGatewayIntentsOnDebt` cuente las intenciones con esa marca aunque aún no tengan `gatewayIntentRef`; o un `UNIQUE` parcial por deuda sobre intenciones despachadas y no terminales (repo del modelo). Una alternativa débil es un `pg_advisory_xact_lock` por deuda, que sólo sirve si se sostiene durante la llamada (ver N5).
- **Por qué con `RLS_ENFORCE=true` no ocurre (CONFIRMADO, REV-M2b, 0/4 rondas):** `TenantContextInterceptor` envuelve el handler entero en `em.transactional(...)`; el `transactional` interno de la compuerta pasa a ser anidado y los `FOR UPDATE` de la deuda no se sueltan hasta el final de la petición, así que el segundo despacho espera y luego ve a A con `pi_…` ⇒ 409. Es un efecto colateral, no una decisión de diseño documentada, y tiene el costo de N5.

## N3 — MENOR: la compuerta depende de un literal que nadie valida

- **Dónde:** `payments-transactions.service.ts:457` y `payment-flow.repository.ts:534` (`sourceRefType === 'payment_debt'`); `CreatePaymentIntentDto.sourceRefType` es texto libre (`@IsString @MaxLength(100)`, `payment-intent.dto.ts`) y ningún otro código del repo define ese valor.
- **CONFIRMADO ejecutando** (REV-M2c): con A ya despachada, una segunda intención con `sourceRefType='PAYMENT_DEBT'`, `'debt'` o sin `sourceRefType` (sólo `sourceRefId`) y sin sesión de checkout **se despacha igual** (3 de 3). En el webhook M1 lo mandaría a conciliación, pero el cobro doble ya ocurrió.
- **Impacto:** el cierre de M2 vale sólo si el front envía exactamente `payment_debt`. Convertir `purpose=DEBT` sin `sourceRef` resoluble en un rechazo en la compuerta (o validar el par en `createIntent`) lo cierra. Severidad MENOR porque requiere que quien llama se aparte de la convención, pero conviene verificar el contrato con el front.

## N4 — MENOR: ventana ambigua sin reserva (choca con la regla 11)

- **CONFIRMADO ejecutando** (REV-M2d): A recibe 504 (la pasarela SÍ creó el cobro, la API no lo asoció); B (misma deuda) se despacha sin problema ⇒ **2 `pi_…` vivos**; el reintento de A responde `409 PAYMENT_GATEWAY_DEBT_HAS_OPEN_CHARGE`.
- La regla 11 dice «resultado ambiguo ⇒ reintento con la MISMA clave, nunca bloqueo». Acá el reintento legítimo de A queda bloqueado por B y el `pi_…` de A queda huérfano y pagable, sin ninguna bandeja que lo muestre (es m3 del informe previo, ahora con una vía concreta). Se cierra con la reserva de N2 y con una forma de adoptar o cancelar el cobro huérfano (escala a una persona).

## N5 — MENOR: con RLS activo la llamada HTTP corre dentro de una transacción con bloqueos

- **CONFIRMADO ejecutando** (REV-M2b): mientras la llamada a la pasarela de A está en vuelo, `select … from payment_debts … for update nowait` desde otra conexión falla con `55P03`: la fila de la deuda sigue bloqueada. Lo mismo valen la intención y las sesiones (misma transacción).
- El docstring de `processViaGateway` (`payments-transactions.service.ts:338-342`) dice que «la llamada HTTP va fuera de ella, para no sostener el bloqueo de la fila durante los reintentos». Eso sólo es cierto con `RLS_ENFORCE=false`.
- **INFERENCIA (no medido):** con los valores por defecto (`timeoutMs` 10 000, `maxAttempts` 3, más espera) cada cobro en vuelo retiene una conexión «idle in transaction» y los bloqueos hasta ≈ 30 s; con la pasarela lenta y más cajeros que conexiones del pool el servicio se queda sin conexiones. Además cualquier webhook de esa deuda espera. Medir con una prueba de carga antes de encender.

## N6 — MENOR: interbloqueo introducido por la corrección de m6

- **Dónde:** `payments-gateway-webhook.service.ts:541-575` (`releaseDebt`) + `payment-flow.repository.ts:492` (`findOpenCheckoutSessionsByDebt` con `PESSIMISTIC_WRITE`).
- **Orden de bloqueo:** el webhook de A toma intención A → sesiones de A → deuda → *todas las sesiones abiertas de la deuda*; el webhook de B toma intención B → sesión de B → deuda. A tiene la deuda y pide la sesión de B; B tiene su sesión y pide la deuda.
- **CONFIRMADO ejecutando** (REV-11, rol `NOBYPASSRLS`, 40 rondas de `A failed ‖ B succeeded` con las dos sesiones abiertas): `{"40P01":22}` en una corrida y `{"40P01":30}` en otra (20 en la primera). Con el reintento (como hace la pasarela) las 40 rondas convergen a deuda `DEBT_SETTLED`, `outstanding 0.000000`; es decir, no hay pérdida, pero el receptor responde 500 y la pasarela suma fallos hacia `too_many_failures`.
- Requiere dos sesiones abiertas sobre la misma deuda (el estado excepcional que m6 pretende tolerar). **Dirección:** bloquear siempre la deuda ANTES que las sesiones (también en `settleDebt`), o leer las sesiones abiertas sin `FOR UPDATE` porque el bloqueo de la deuda ya serializa.

## N7 — MENOR: M3 filtra existencia por tiempo y bloquea la fila ajena

- **Dónde:** `payments-transactions.service.ts:364-372` (`findByIdForUpdate(tx, intentId)` y recién después `assertResourceInTenant`).
- **CONFIRMADO ejecutando** (REV-M3b): con la fila de la víctima retenida por otra transacción, `processTransaction` de OTRO tenant sobre ese UUID **espera** el bloqueo (resolvió `404` a los ≈ 709 ms, al soltarlo) mientras un UUID inexistente responde `404` en 5 ms. El mensaje y el cuerpo sí son idénticos (verificado además por el spec HTTP del carril, que no mide tiempo). Con `RLS_ENFORCE=false` también significa que una petición ajena toma un `FOR UPDATE` momentáneo sobre la intención de otro tenant.
- **Dirección:** cargar con `{ id, tenantId }` (sin bloqueo) para la comprobación y bloquear después sólo si es propia.
- **M3 en sí: cerrado.** Probé: sin contexto de tenant (superadmin sin `X-Tenant-Id`) ⇒ 422 `TENANT_REQUIRED`, cero llamadas y fila intacta (REV-M3a); el spec HTTP del carril cubre sin token, token con otro secreto, PATIENT, rol acotado a otro tenant, `X-Tenant-Id` de un tenant ajeno, CASHIER y `PAYMENTS_ADMIN` con UUID ajeno (404 idéntico) y el control del dueño. Rutas hacia el cobro de la pasarela: `PaymentsGatewayChargeService` (`dispatch`/`consult`/`associate`) sólo se invoca desde `processViaGateway` (`grep` sobre `src/`); `createIntent` sólo llama a `assertRoutable` (no cobra); los webhooks no crean cobros. Persisten sin comprobar tenant las rutas heredadas `fx-lock`, `risk-assessment` y `splits` (`findByIdForUpdate` por UUID): fuera de esta ronda, pero un `risk-assessment` `DECLINE` de otro tenant sobre una intención sin `pi_…` sigue siendo posible con `RLS_ENFORCE=false` (INFERENCIA).

## N8 — MENOR: intenciones de factura

- `settleDebt` devuelve `settled:true` para una intención sin sesión que no es de deuda; para `INVOICE` eso deja `processed=true` y `billing` sin enterarse (ambigüedad 5 del informe del carril). No es una regresión de M1, pero es el mismo patrón «cobrado sin rastro de conciliación». INFERENCIA.

---

## Lo que intenté romper y resistió

### (1) B1 — resolución del dueño bajo RLS (`payment-intents.repository.ts:165-196`)

Todo ejecutado contra PostgreSQL real con un rol `NOSUPERUSER NOBYPASSRLS` y la política copiada textual de `2026-08-05_tenant_rls.sql` (`rev-b1-rls.int-spec.ts`, 17/17 en verde; salida en `salida-rev-b1-rls.txt`). Previamente corrí también `payments-gateway-webhook-rls`, `payments-gateway-webhook` y `payments-gateway-charge` del carril: 73/73.

| Intento | Resultado |
|---|---|
| ¿La elevación se ejecuta antes de verificar la firma? | No. `receive()` hace 503/400/`verify`/`parse`/modo antes de `em.transactional`. REV-2: firma alterada, cabeceras ausentes, cuerpo vacío ⇒ 401/401/400 y **cero sentencias SQL** |
| Ventana de la elevación | REV-1 imprime la secuencia real: `begin` → `set_config('app.system_context','true',true)` → **una** consulta `select id, tenant_id … where gateway_intent_ref = ? limit 2` → `set_config('app.system_context','false',true)` → `set_config('app.current_tenant_id',…)` → `FOR UPDATE` de la intención. Nada más corre elevado |
| Fuga al pool por error | REV-5: 409 por referencia ambigua, 404 terminal desconocido, **permiso denegado en mitad de la ventana elevada** (REVOKE SELECT) y **fallo después de fijar el tenant** (REVOKE UPDATE sobre deudas): tras cada uno leí `current_setting` en 18 conexiones distintas del pool (`pg_sleep` simultáneo): 0 contaminadas. La transacción revierte, la intención sigue `PI_PENDING`, sin evento archivado, y el reintento aplica |
| Misma referencia en dos tenants / en el mismo tenant | 409 sin tocar nada (REV-6; el del carril ya cubría tenants distintos). `limit 2` basta para detectar >1 |
| Referencias hostiles | REV-3: mayúsculas, comilla + `drop table`, salto de línea final, 41 caracteres, 6 caracteres, comodines `%`, combinación Unicode ⇒ 422 sin SQL (`PAYMENT_INTENT_ID` es `^pi_[a-z0-9]{10,40}$`, y la consulta va parametrizada) |
| Elegir el tenant desde el cuerpo | REV-4: `data.object.tenant_id` y `metadata` apuntando a otro tenant se ignoran; sólo se afecta al dueño real |
| Terminal de un tenant sobre una deuda de otro | REV-7: `failed` de la intención de B con una sesión cruzada hacia la deuda de A no libera ni cierra nada de A; el `succeeded` equivalente ya lo cubría el spec del carril (concilia) |
| Concurrencia | REV-10: 30 rondas con 5 eventos mezclados (`succeeded/failed/expired/canceled/processing/requires_action`) más 2 duplicados, simultáneos: sin errores, estado final siempre coherente (cobrada ⇒ deuda saldada y sesión completada; fallada/cancelada ⇒ deuda `PENDING` 150, sesión expirada) |
| `HistoryMirrorSubscriber` | `audit.payment_intents_history` no tiene `tenant_id` (sin RLS); el actor sale de `getAuditRequestContext()` (nulo en la ruta pública). Sin hallazgo, pero **no lo ejercité** (los int-specs no registran el subscriber ni crean el esquema `audit`) |

No encontré un camino donde SYSTEM quede activo más allá de esa consulta, ni una resolución al tenant equivocado.

### (2) M1 / m6 — deudas y sesiones

- REV-8 (rol `NOBYPASSRLS`): dos intenciones con sesiones abiertas sobre la misma deuda; `failed` de A cierra su sesión y **no** libera la deuda (sigue `DEBT_IN_CHECKOUT`, sesión de B abierta); `succeeded` de B salda (`0.000000`); un `succeeded` posterior de A (contradicción con su `failed`) no toca la deuda y queda `reconciliationRequired`.
- REV-9: dos intenciones de 150 sobre una deuda de 150, ambas `succeeded` en paralelo: se salda **una** vez, la otra va a conciliación (`processed=false`), la deuda nunca queda negativa.
- No encontré una combinación que deje una deuda cobrada sin decrementar o liberada con otra sesión abierta, ni un evento aplicado dos veces (el dedupe es por `webhook-id` bajo el `FOR UPDATE` de la intención). Único defecto hallado: N6.

### (3) M2 — qué sí funciona

Con la intención ligada por `sourceRef` y por sesión, deuda propia en BOB y la otra intención ya con `pi_…`: 409; saldo en decimal exacto (`150.000000` vs `150.00`); deuda saldada ⇒ 422; reintento de una intención ya despachada ⇒ consulta (GET), no bloquea (sale antes de la compuerta; cubierto por su spec y por el mío). Defectos: N2, N3, N4. Operativo (INFERENCIA): una QR abandonada mantiene la deuda en «cobro en curso» hasta que la pasarela la expire y no hay forma de cancelarla desde la API; cambiar de medio de pago exige esperar.

### (4) M3 — ver N7. Sin otras rutas hacia el cobro; roles de plataforma sin tenant ⇒ 422.

### (5) Regresión con el flag APAGADO

- `git diff --name-status 4e64353a HEAD`: ningún `*.spec.ts` preexistente aparece como `M`; todos los specs del diff son archivos nuevos del carril. Las únicas modificaciones a specs del carril entre revisiones son de formato (prettier) y esperas por condición al cerrar; no vi aserciones borradas ni debilitadas (`git show 08a0e0688 -- '*spec.ts'`).
- `jest src/modules/payments --runInBand` en el worktree de HEAD: **18 suites / 405 tests, en verde** (la corrida previa del integrador: 17 / 361).
- Camino viejo de `processTransaction` comparado línea a línea con `4e64353a`: mismo orden (estado ⇒ operación abierta ⇒ riesgo ⇒ saldo), mismos mensajes, códigos y `details`. Cambios observables con el flag apagado: (a) nuevo `409 PAYMENT_INTENT_VIA_GATEWAY` sólo para intenciones con `gatewayIntentRef` (inalcanzable sin haber encendido el flag antes); (b) `fx-lock`, `splits` y `DECLINE` con `409` sólo si hay `gatewayIntentRef`; (c) `ProcessTransactionDto.paymentMethodType` validado con `@IsIn`; (d) ruta pública nueva que responde 503; (e) **N1**: el `verify` del `json()` global corre una expresión cuadrática en toda petición con cuerpo.

### (6) Higiene

- Sin restos de mutación de control negativo: `findByIdForUpdate`, `findByGatewayIntentRefForUpdate`, `findCheckoutSessionsByIntentForUpdate`, `findDebtByIdForUpdate`, `findOpenCheckoutSessionsByDebt` conservan `LockMode.PESSIMISTIC_WRITE`; no hay `findById(` sin bloqueo en las rutas del cobro (el `findById` de intenciones sólo existe en el repositorio, sin llamadas desde estos servicios); guardas de estado, importe y tenant con el sentido esperado (`decideGatewayEvent`, `amountMatches`, `settleDebt`, `assertDebtAllowsCharge`, `assertResourceInTenant`).
- Sin literales con forma de clave real: los `whsec_`/`whpk_` sólo están en `standard-webhook-signature.parity.spec.ts` y son los vectores sintéticos conocidos (bytes `01..20`); no hay `sk_live_`/`sk_test_` con cuerpo en `src/`, `test/` ni `.env.example`.
- Sin `TODO`/`FIXME`/`skip`/`only` añadidos, sin `console.*` en `src/`.
- PHI: los logs nuevos llevan sólo `operation`, `eventId`, `intentId`, `decision`, `reconciliationReason`, `status`, `gatewayCode`, `requestId`; el cuerpo hacia la pasarela es `{amount_minor, currency, payment_method.type, expires_in_seconds}`. Riesgo residual sin cambios: `payload_json` archiva `event.data` tal como lo manda la pasarela.

## No cubierto

- No levanté `AppModule` (ni la pasarela real ni el stack sandbox): todo sale de los servicios y repositorios reales sobre PostgreSQL real, sin HTTP salvo el arnés Express de N1 y el spec HTTP del carril (no re-ejecutado por separado, sí dentro de las 405 pruebas).
- `RLS_ENFORCE=true` se simuló envolviendo la llamada en `em.transactional` + `set_config` igual que el `TenantContextInterceptor`, sobre un usuario superusuario para la parte de cobro; los webhooks sí corrieron con el rol `NOBYPASSRLS`. No ejercité el cobro bajo el rol restringido ni con el espejo de historial.
- El agotamiento del pool (N5), el comportamiento con varias réplicas y el efecto de `too_many_failures` en la pasarela son inferencia.
- Esquema reducido (5–6 tablas, FKs a tablas ausentes omitidas), igual que los int-specs del carril.
- No revisé `billing`, reembolsos ni `wallet`.
- Los resultados contra el doble de la pasarela no son resultados contra `pay-edge`.
