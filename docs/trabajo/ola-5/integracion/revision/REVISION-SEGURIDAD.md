# Revisión adversarial de seguridad · ola 5 · pay-connectors (OpenBao), guardias de PAN, identidad entre servicios, pay-edge y pay-webhooks

- Revisor: independiente, SOLO LECTURA (no se editó ni se commiteó código del repo). Rama `claude/adoring-allen-ly7r6f`, HEAD `99a3024`.
- Alcance pedido: (1) `OpenBaoSecretProvider` y su config (commits d54ad57, 6b730e2); (2) guardias de PAN (contracts, pay-edge, pay-vault, pay-mockbank `VAULT_TOKEN`, commit e2c74a1); (3) identidad entre servicios y cabeceras de contexto; (4) pay-edge (tasa, clave de API, Idempotency-Key con PAN); (5) pay-webhooks (SSRF, firma, rotación).
- Leyenda de evidencia: **CONFIRMADO** = lo ejecuté y vi el resultado; **INFERIDO** = sale de leer el código, no lo ejecuté. No levanté ningún servicio, ni OpenBao ni Svix (los contenedores siguen detenidos). Los scripts de prueba viven en el directorio temporal de la sesión, fuera del repo. El número de tarjeta usado en las pruebas es el de prueba público `4111111111111111` (sintético).

## Resumen por severidad

| # | Sev. | Hallazgo | Evidencia |
|---|---|---|---|
| S-01 | BLOQUEANTE (para `live`) | La identidad entre servicios es una cabecera sin firma y no hay segmentación demostrada: `x-service-id`, `x-merchant-id` y `x-pay-mode` los fija quien alcance el puerto | CONFIRMADO por lectura y por el e2e E7; ya documentado en `MTLS-DECISION.md` |
| S-02 | MAYOR | `safeIdempotencyKey` guarda `masked-<sha256 sin sal>` de una clave con forma de PAN: el PAN se recupera por fuerza bruta | CONFIRMADO (recuperado en 1,1 s en un subespacio de 10^6) |
| S-03 | MAYOR | `X-Request-Id` con forma de PAN (16 dígitos) pasa la validación de pay-edge y de otros 8 servicios: se registra como `req.id`, se devuelve en la respuesta y se reenvía | CONFIRMADO (regex ejecutada) + lectura; no levanté el servicio |
| S-04 | MAYOR | pay-edge rechaza ≈0,37 % de los `card_token` legítimos de la bóveda con `422 card_number_detected` | CONFIRMADO (734 de 200 000 tokens generados con la fórmula de la bóveda) |
| S-05 | MAYOR | La réplica de claves de pay-edge no tiene cota de antigüedad: con NATS caído, una clave revocada o un comercio suspendido siguen sirviendo y `/health/ready` no lo marca | INFERIDO (código y comentario del propio readiness) |
| S-06 | MAYOR | `TRUST_PROXY_HOPS=0` por defecto y el límite por IP se aplica antes de autenticar: detrás de un proxy toda la clientela comparte IP y 30 autenticaciones fallidas por minuto bloquean a todos | INFERIDO (no hay manifiestos de despliegue en el repo) |
| S-07 | MENOR | `OpenBaoSecretProvider.invalidate()` no cancela lecturas en vuelo: el valor viejo se cachea todo el TTL | CONFIRMADO |
| S-08 | MENOR | `namespaceOf` + `startsWith` sin delimitar: un conector `mercantil` leería `CONNECTOR_MERCANTIL_QR_*` | CONFIRMADO (con un proveedor de juguete); hoy no hay códigos que choquen |
| S-09 | MENOR | Ventana de rotación de 24 h por defecto, sin tope superior de `OPENBAO_ROTATION_WINDOW_MS` ni de `OPENBAO_CACHE_TTL_MS` | CONFIRMADO (la config acepta 10 años) |
| S-10 | MENOR | La config `live` de pay-connectors acepta OpenBao en loopback, el token raíz de desarrollo y `NODE_TLS_REJECT_UNAUTHORIZED=0` | CONFIRMADO |
| S-11 | MENOR | Detectores de PAN secundarios (mockbank, pay-payments, pay-vault) solo ven dígitos ASCII con espacio o guion | CONFIRMADO para mockbank; INFERIDO para los otros dos (mismo código) |
| S-12 | MENOR | `VAULT_TOKEN` de mockbank deja pasar `tok_` + PAN de 16 dígitos + 8 ceros | CONFIRMADO (la regex lo acepta) |
| S-13 | MENOR | `pan-guard`/`containsCardNumber`: PAN de 12 dígitos no se detecta; valores de query e ids de ruta no se inspeccionan | CONFIRMADO (12 dígitos); INFERIDO (query/ruta) |
| S-14 | MENOR | Costo de CPU del guardia: 0,16 a 0,32 s de hilo bloqueado por cuerpo de 1 MiB, con cuerpos que no cumplen Luhn | CONFIRMADO |
| S-15 | MENOR | Redis caído ⇒ se desactivan límites y el freno por fallos de autenticación (fail-open, DT-1) | INFERIDO (documentado) |
| S-16 | MENOR | pay-ledger y pay-settlement ponen `ServiceIdentityGuard` por controlador, no global: un controlador nuevo nace abierto | CONFIRMADO por lectura (hoy los dos controladores sí lo llevan) |
| S-17 | MENOR | Webhooks con Svix: el guard de SSRF solo corre al registrar; Svix recibe la URL cruda; el rebinding no está probado | INFERIDO / NO PROBADO (documentado en `ola-5/P1/INFORME.md` §4) |
| S-18 | MENOR | Un secreto de firma mal formado en OpenBao produce `RangeError` ⇒ 500 en todos los callbacks, y uno malo en un par de rotación anula también al bueno | INFERIDO |
| S-19 | MENOR | Callbacks públicos de pay-connectors: el límite por `conector|IP de socket` corre antes de verificar la firma | INFERIDO |

Nada de lo revisado permite, por sí solo, que un cliente externo vía pay-edge fije identidad, comercio o modo (punto 3): ver «Lo que intenté romper y resistió».

---

## BLOQUEANTE

### S-01 · Identidad entre servicios sin firma ni segmentación (CONFIRMADO por lectura; ya documentado)

- `contracts/packages/service-auth/src/index.ts:39-41`: el guard solo exige que `x-service-id` exista, cumpla `^pay-[a-z]+$` y esté en la lista de la ruta. El propio comentario (`:12-14`) dice que no es una barrera suficiente fuera de una red con mTLS.
- Escenario: cualquier proceso con alcance de red a un servicio (un contenedor lateral, una SSRF desde un servicio con salidas, un invitado en la red de Coolify) manda `x-service-id: pay-connectors` + `x-merchant-id: mc_…` + `idempotency-key` a `pay-vault` `POST /tokens/{tok}/reveal` (`services/pay-vault/src/vault/vault.controller.ts:64-72`) y recibe `number`, `exp_*`, `holder_name`. Con `x-service-id: pay-payments` y `x-pay-mode: live` escribe en `pay-ledger` (`LEDGER_CALLERS`). Necesita conocer un `tok_` (96 bits al azar): eso limita el PAN a tarjetas cuyos tokens circulan, no a todas.
- La prueba E7 (`e2e/flows/e7.e2e.ts`) hace exactamente esa suplantación a diario.
- `platform/compose.yml` solo publica puertos en `127.0.0.1` y no incluye los servicios de negocio; no hay evidencia en el repo de una red segmentada ni de mTLS (`MTLS-DECISION.md` §1, y P1.H4.M3 sigue en `TODO`).
- Severidad: BLOQUEANTE para `live` (mueve dinero y expone PAN a quien llegue a la red), no para el entorno actual de desarrollo. No agrego propuesta nueva: la decisión A/B/C está en `MTLS-DECISION.md`. Sí hace falta una condición de salida: sin A o B demostrado, `live` no debería arrancar.

---

## MAYOR

### S-02 · La clave de idempotencia con forma de PAN se «enmascara» con un hash reversible (CONFIRMADO)

- `contracts/packages/idempotency/src/card-number.ts:82-84`: `safeIdempotencyKey` devuelve `masked-<sha256(key)>`. SHA-256 sin sal sobre un valor de ~10^9 posibilidades (BIN conocido + Luhn) se invierte por enumeración.
- Qué ejecuté: tomé `masked-…` de `4111111111111111`, conocí el BIN `411111` y supuse conocidos los últimos 3 dígitos para acotar la demo; enumeré 10^7 candidatos y recuperé el número tras 1 111 112 intentos en 1,14 s (un solo núcleo). Sin esa suposición, el espacio completo con BIN conocido son ~10^9: del orden de 15 minutos en un núcleo, segundos en una GPU.
- Escenario: un comercio pega un PAN en `Idempotency-Key`. pay-edge lo reenvía como `masked-<hash>`; ese valor queda en claro en `idempotency_keys` 24 h y viaja en cabeceras a todos los servicios. Quien lea esa tabla o un volcado recupera el PAN. El comentario de la función promete que «el PAN no queda en ninguna parte»: no se cumple. Viola la regla 6 de `CLAUDE.md` y el criterio de PCI de que un hash de PAN debe ser con clave.
- Corrección (no aplicada): HMAC-SHA256 con una clave de servidor (la de OpenBao), también determinista, de modo que la idempotencia se conserva.

### S-03 · `X-Request-Id` con forma de PAN se registra, se devuelve y se reenvía (CONFIRMADO por regex + lectura)

- `services/pay-edge/src/app.module.ts:32-36`: `genReqId` acepta cualquier valor `^[A-Za-z0-9._-]{8,64}$`. Ejecuté la regex: `4111111111111111` pasa. No hay `containsCardNumber` (sí lo tienen `pay-payments/src/app.module.ts:28` y `pay-vault/src/app.module.ts:27`; `pay-vault/src/redact.ts` documenta que un PAN en el id de petición «se rechaza»).
- Efecto: ese id se usa como `req.id` en el log HTTP (`serializers.req`, `app.module.ts` de pay-edge), en `request_id` de los problemas (`problem.filter.ts:19-22`), en la cabecera `x-request-id` de la respuesta y en la que reenvía la tubería (`edge.pipeline.ts:98`). pay-connectors, pay-ledger, pay-merchants, pay-mockbank, pay-qr, pay-risk, pay-schedules, pay-settlement y pay-webhooks repiten el mismo `genReqId` sin el filtro y lo escriben en sus logs.
- Escenario: cualquier cliente, incluso sin autenticar (el logger corre antes de la autenticación), manda `X-Request-Id: <PAN>` y el número queda en los logs de pay-edge y de los servicios aguas abajo. Regla 6 de `CLAUDE.md`: el PAN no puede estar en logs.
- No levanté pay-edge para ver la línea de log; el camino es de lectura directa.

### S-04 · pay-edge rechaza tokens legítimos de la bóveda (CONFIRMADO)

- El hallazgo 14 (e2c74a1) se arregló solo en pay-mockbank (`VAULT_TOKEN`, `dto.ts:149`). pay-edge usa `containsCardNumber` sobre cada cadena del cuerpo sin exención (`pan-guard.ts:53`), y el token de la bóveda es `tok_` + 24 hex al azar (`pay-vault/src/backend/fake-vault-backend.ts:81`).
- Qué ejecuté: generé 200 000 tokens con `randomBytes(12).toString('hex')` y pasé `{"card_token":"tok_…"}` por `inspectBody`: **734 rechazados (0,367 %)** como `card_number`. Es decir, 1 de cada ~270 cobros con tarjeta legítimos recibe `422 card_number_detected` por un falso positivo, sin que el comercio pueda hacer nada salvo reintentar con otro token.
- Es un problema de disponibilidad, no una fuga, pero está en el guardia revisado y empuja a debilitarlo.
- Cuidado con la corrección obvia: copiar la exención `tok_[0-9a-f]{24}` al borde abre S-12 (cabe un PAN de 16 dígitos en 24 hex). La salida limpia es cambiar el alfabeto del token de la bóveda a uno con pocas probabilidades de 13 dígitos seguidos (por ejemplo base32 `a-z2-7`, donde esa probabilidad es del orden de 10^-9), no exentar por forma.

### S-05 · Revocación sin cota de antigüedad de la réplica (INFERIDO)

- `services/pay-edge/src/health.controller.ts:25-32`: la réplica solo se «informa» (`replica: { status: 'up', subscribed }`), nunca tumba el estado, y el comentario lo dice. `replica.repository.ts` lee la réplica local sin mirar cuándo se aplicó el último evento.
- Escenario: NATS desconectado o rezagado cuando se revoca una clave filtrada o se suspende un comercio por riesgo. pay-edge sigue aceptando esa clave indefinidamente. Al arrancar en `live` se exige `NATS_URL` (`config.ts:58`), pero no que la suscripción siga viva.
- Corrección: un tope de antigüedad (por ejemplo, «último evento o latido de la réplica hace más de N s ⇒ `503` o solo lecturas») y alarma sobre `subscribed=false`.

### S-06 · Límite por IP y confianza en el proxy (INFERIDO)

- `edge.pipeline.ts:54-58` aplica `ip:<ip>` (300/min) y el bloqueo `authfail:<ip>` (30/min) antes de autenticar. `config.ts:98` deja `TRUST_PROXY_HOPS` en 0 y `configure-app.ts:13` lo pasa a Express. Nada en el repo lo fija (búsqueda: solo aparece en `config.ts`).
- Escenario detrás de Traefik/Coolify con el valor por defecto: `req.ip` es la IP del proxy para todos; 30 peticiones con clave falsa por minuto devuelven `429` a todos los comercios, incluidas las autenticadas. Con un valor mayor que los saltos reales sucede lo contrario: `X-Forwarded-For` se falsea y el límite no sirve.
- Corrección: en `live`, `TRUST_PROXY_HOPS` obligatorio y explícito (sin valor por defecto), como los demás guards de modo.

---

## MENOR

### Sobre `OpenBaoSecretProvider` y su configuración

**S-07 · `invalidate()` pierde la carrera con una lectura en vuelo (CONFIRMADO).** `openbao-secrets.ts:89-92` borra el caché, pero `load()` (`:108-121`) escribe `cache.set` al terminar la lectura que ya estaba en vuelo (`:99-106`, `:119`). Con un servidor de prueba que respondió con el valor viejo mientras rotaba y llamaba `invalidate()`, el resultado fue `[ 'old-secret' ]` y la lectura siguiente también `[ 'old-secret' ]` hasta vencer el TTL. Hoy nadie llama a `invalidate` fuera de las pruebas (búsqueda en `src`), por lo que es latente. Corrección: contador de generación por nombre que descarte el resultado de una lectura iniciada antes de la invalidación.

**S-08 · Prefijo de espacio de nombres sin delimitador (CONFIRMADO con un doble).** `secrets.ts:38-40` y `:62` usan `name.startsWith('CONNECTOR_<CODIGO>_')`. `SECRET_NAME` (`openbao-secrets.ts:52`) admite guiones bajos en el código y en el secreto, así que no se puede saber dónde termina uno: un `ScopedSecretProvider` de `mercantil` devolvió `SERVED:CONNECTOR_MERCANTIL_QR_API_KEY`. Hoy los códigos (`mock`, `mercantil_qr`, `mercantil_card`, `bank_transfer`) no chocan entre sí, y las políticas de OpenBao son por glob `CONNECTOR_<CODIGO>_*`, que tampoco distingue. Se activa en cuanto exista un conector cuyo código sea prefijo de otro. Corrección: ruta con segmentos (`<modo>/<conector>/<SECRETO>`) y política por directorio, o una lista cerrada de nombres por conector.

**S-09 · Ventanas sin tope (CONFIRMADO en config).** `config.ts:190-192` acepta cualquier entero para `OPENBAO_CACHE_TTL_MS` y `OPENBAO_ROTATION_WINDOW_MS`. Probé 1 año de caché y 10 años de ventana: aceptados. Por diseño, el secreto N-1 (que puede ser el filtrado) sigue valiendo hasta 24 h (`:113-118`) o hasta que el operador lo borre; la ventana se mide con el reloj local contra `created_time` del servidor. Falta el tope y un procedimiento escrito de «cerrar ventana ya» ante filtración.

**S-10 · La config `live` es más laxa que la de pay-edge (CONFIRMADO).** Con `PAY_MODE=live` `loadConfig` aceptó `OPENBAO_ADDR=https://127.0.0.1:8200`, `OPENBAO_TOKEN=dev-only-root` y `NODE_TLS_REJECT_UNAUTHORIZED=0` en el entorno. pay-edge sí rechaza loopback en `live` (`config.ts:55-59`). Un token estático tampoco se renueva: al vencer, el servicio falla cerrado sin aviso (disponibilidad). Corrección: en `live`, rechazar loopback, `NODE_TLS_REJECT_UNAUTHORIZED=0` y preferir AppRole.

**S-18 · Valor de secreto mal formado (INFERIDO).** `contracts/packages/webhook-signature/src/index.ts:98-103` lanza `RangeError` si el secreto decodificado no mide 24 a 64 bytes; `mock.connector.ts:96-103` solo captura `WebhookVerificationError`, así que el callback da 500 en vez de 401. Fail-closed (nunca acepta), pero un par de rotación con un valor malo anula también al bueno.

### Guardias de PAN

**S-11 · Los detectores secundarios son los débiles (CONFIRMADO en mockbank).** `pay-mockbank/src/sandbox/dto.ts:28-36` ejecutado: detecta `4111111111111111` y `4111 1111 1111 1111`, pero **no** `4111.1111.1111.1111`, `4111/1111/…`, `4111_1111_…`, dígitos de ancho completo ni con espacio de ancho cero. `pay-payments/src/domain/pan.ts` y `pay-vault/src/redact.ts:28` son la misma lógica (solo `\d` y separadores espacio o guion). Aguas abajo del borde esto es defensa en profundidad y pay-edge sí normaliza (NFKC, `\p{Nd}`, cualquier separador); el hueco aparece si el dato llega por otra vía interna.

**S-12 · Exención `VAULT_TOKEN` de mockbank (CONFIRMADO por regex).** `dto.ts:149,157-159`: `tok_411111111111111100000000` cumple `^tok_[0-9a-f]{24}$`, así que `cardTokenLooksLikePan` devuelve `false`. Mockbank es de sandbox y el parser no guarda el token; pay-edge lo rechazaría antes (S-04 al revés). Si se copia la exención al borde, se vuelve un canal para PAN.

**S-13 · Huecos del guardia compartido.**
- PAN de 12 dígitos (Maestro): `card-number.ts:20` fija `MIN_PAN = 13`. Ejecuté un número de 12 dígitos válido por Luhn (`500000000009`) y `containsCardNumber` devolvió `false`. El código anterior de mockbank cubría 12 a 19; el comentario de `pan-guard.ts` y de `card-number.ts` no lo declara como límite.
- Partidos por letras o por caracteres de letra invisibles (relleno hangul `U+3164`): no se detectan (`4111a1111a…`, `4111ㅤ1111ㅤ…` dieron `false`). Está declarado como límite en `card-number.ts:16`; solo importa si algún consumidor aguas abajo quita los no dígitos.
- Valores de consulta (`status`, `starting_after`, `created_from`…) y ids de ruta (`/payment_intents/4111111111111111` cumple `[a-z0-9_-]{1,64}`, `routes.ts:47`) se reenvían sin inspeccionar (`edge.pipeline.ts:159-170`); los logs de la aplicación los enmascaran con `safeUrl`, pero el proxy de entrada fuera del repo sí los registra.
- PAN dividido en varios campos: límite declarado.

**S-14 · Costo del guardia (CONFIRMADO).** Cuerpos de 1 MiB (el tope por defecto, `config.ts:99`) que no cumplen Luhn: 160 ms de dígitos ASCII, 316 ms con dígitos árabe-índicos, 183 ms con dígitos Adlam. Es CPU síncrona en un solo hilo después de autenticar: con `keyPerWindow=600` una sola clave puede ocupar más de un núcleo del borde. Corrección: tope de bytes menor para rutas que no lo necesitan, o ejecutar el análisis en un worker.

**S-15 · Fail-open del limitador (INFERIDO, documentado).** `edge.pipeline.ts:128-135`: sin Redis se deja pasar y se registra. También deja sin efecto el freno por fallos de autenticación.

### Identidad y rutas

**S-16 · Guard por controlador (CONFIRMADO por lectura).** `pay-ledger/src/ledger/ledger.controller.ts:14,111` y `pay-settlement/src/settlement/settlement.controller.ts:44` usan `@UseGuards(ServiceIdentityGuard)`, mientras los demás servicios lo registran como `APP_GUARD`. Hoy todos los controladores de negocio de ambos lo llevan (verifiqué con `@Controller`), pero el principio «seguro por defecto» del guard no se cumple allí.

### Webhooks

**S-17 · SSRF con Svix (INFERIDO / NO PROBADO).** `endpoint.service.ts:93,98` valida con `TargetGuard` solo al registrar y guarda y envía a Svix la URL **cruda** (`svix-engine.ts:78-83`), no la normalizada que validó el guard; con el motor en proceso sí se re-valida y se fija la IP en cada entrega (`delivery.worker.ts:107`, `https-transport.ts:35-40`). Con Svix el control pasa al servidor Svix: `ola-5/P1/INFORME.md` §4 prueba que bloquea loopback, metadatos y red privada, y declara que **el rebinding no se probó** y que el control de salida de red está pendiente (DT-21). Dos riesgos: diferencia de intérpretes de URL entre Node y Svix, y rebinding si Svix resuelve y conecta en pasos separados. Corrección: enviar a Svix `new URL(...).href` ya validado, y red de salida de Svix sin ruta a la red interna.

**S-19 · Callbacks (INFERIDO).** `callbacks.service.ts:81-95`: la ventana de 600/min es por `conector|IP de socket` y corre antes de la verificación de firma; detrás de un proxy la IP de socket es la del proxy, así que un atacante sin firma puede agotar el cupo de callbacks legítimos del banco. La IP de socket también falsea el sentido de `allowed_source_cidrs`. Sin filas en `connector_callback_endpoints` solo rige la firma (`endpoint-policy.ts:84`).

---

## Lo que intenté romper y resistió

**OpenBao (punto 1)**
- Inyección de ruta: el nombre pasa `SECRET_NAME` (mayúsculas, dígitos, `_`; sin `.`, `/`, `%`, salto de línea: probé `CONNECTOR_MOCK_X\n` ⇒ rechazado); `mount` y `pathPrefix` pasan `isSafePath` (`../sys`, `Secret` y vacío ⇒ rechazados por la config, ejecutado).
- Redirección/SSRF: levanté un servidor que responde 307 hacia un segundo servidor que registra `X-Vault-Token`. Resultado: `[]`, evento `redirect`, **el token no llegó** al segundo servidor. `redirect: 'manual'` y la dirección sale de la config (`addr.origin`), no de entrada externa.
- Fail-closed: revisé cada rama de `read`/`send`/`login`/`json`: red, timeout, 403, 404 (con y sin `deletion_time`/`destroyed`), 3xx, 5xx, cuerpo ilegible y valor vacío o enorme devuelven `[]`; nada lanza hacia el llamador; un fallo no se cachea. Si la última versión está borrada no se cae a una anterior.
- Rotación: N-1 solo se acepta si `previous.version === current.version - 1`, está viva, y N tiene menos de la ventana; sin `created_time` interpretable no se acepta.
- Fuga: los eventos (`OpenBaoEvent`) no tienen campo de valor; el log de la fábrica emite tipo, nombre del secreto y estado; los errores de config no repiten el token (`OPENBAO_KV_MOUNT inválido: …` repite el mount, que no es secreto). No hay `JSON.stringify(config)` ni log del objeto de configuración (búsqueda en `src`).
- Modo: la ruta usa `config.mode` (validado por `parseMode`), nunca la entrada. Prefijos `mercantil` vs `mercantil_qr`: ver S-08 (confusión posible, hoy sin choque).
- Config `live` (ejecutada): rechaza `http`, userinfo, ruta, `SECRET_PROVIDER=env` o ausente, secretos del simulador `mock`, token + AppRole a la vez. Ver S-10 para lo que acepta de más.

**Guardias de PAN (punto 2)** — ejecuté `inspectBody`/`containsCardNumber` sobre: clave duplicada (`{"a":"4111…","a":"x"}`) ⇒ detectado; escape `4…` ⇒ detectado; número JSON, `4.111111111111111e15` y `41111111111111110000e-4` ⇒ detectados; anidado profundo ⇒ detectado; PAN como nombre de clave ⇒ detectado; ancho completo, marca combinante, salto de línea, `%34`, `&#52;` ⇒ detectados; cuerpo con BOM ⇒ `invalid_json`. Quedaron fuera solo los límites ya declarados (campos divididos, base64, letras) y los de S-13.

**Autenticación entre servicios y pay-edge (puntos 3 y 4)**
- Un cliente externo no inyecta cabeceras de contexto: la tubería no copia las del cliente, las **construye desde cero** con `serviceHeaders('pay-edge', {…})` (`edge.pipeline.ts:94-103`). Corrí `services/pay-edge/test/authz.spec.ts` (`yarn test`, con `flock`): **28 de 28 pasan**, incluido «X-Merchant-Id, X-Service-Id y X-Pay-Mode del cliente no llegan». `RESERVED_HEADERS` (`:21`) es una constante sin uso; no hace falta, pero es código muerto que sugiere un filtrado que no existe.
- El modo sale solo del registro: `Principal.mode = record.mode` (`:156`) y `credentialOk` exige `record.mode === allowedMode` según `PAY_MODE` del borde; el token ni se consulta para el modo. `verifyApiKey` ata modo e id al hash.
- Clave de API: se calcula el hash también cuando no existe (`DUMMY_HASH`), la respuesta es una sola para todos los fallos, comparación en tiempo constante.
- Rutas internas: pay-edge solo enruta la tabla `ROUTES` con ids `[a-z0-9_-]{1,64}` y reconstruye la ruta desde la plantilla (`routes.ts:74`), así que no hay recorrido de rutas ni acceso a `/tokens/*`, `/callbacks/*` ni a back-office. Las rutas de back-office de pay-merchants llevan además `OperatorGuard` con JWT RS256 (`alg`, `iss`, `aud`, `exp`, `mode` atados; por defecto `DenyAll`).
- Los `@PublicRoute()` son solo salud y el callback firmado.

**Webhooks (punto 5)** — ejecuté `TargetGuard.check` con 40 formas de URL y un resolvedor falso: 127.0.0.1 en decimal, hex, octal, `0`, `[::1]`, `[::ffff:7f00:1]`, `[::127.0.0.1]`, NAT64, 6to4, `fe80::`, `fd00::`, CGNAT, metadatos `169.254.169.254`, `*.localhost`, `*.internal`, `*.svc.`, `localhost.`, userinfo, `#@`, puerto 8443, un nombre con una dirección pública y otra privada, y A que resuelve a `::ffff:10.0.0.1`: **todo rechazado**. Solo pasan los públicos legítimos (y `3fff::/20`, rango de documentación, irrelevante). La entrega en proceso fija la IP validada, valida el certificado contra el nombre, no sigue redirecciones y tiene plazo duro. Firma: compara en tiempo constante, tolerancia de 300 s, marca de tiempo con forma validada, sin secretos no coincide nada (`webhook-signature/src/index.ts:150-179`). Secretos sellados con AES-256-GCM y IV aleatorio, atados al id del endpoint.

## No cubierto

- No levanté pay-edge, pay-vault, OpenBao ni Svix: todo lo marcado INFERIDO sale de leer el código. En particular no vi la línea de log de S-03 ni el comportamiento de rebinding de Svix (S-17).
- No revisé la infraestructura de despliegue (Traefik/Coolify, redes, egress), que decide S-01 y S-06.
- Dentro de pay-vault solo el controlador, `redact.ts`, `log-safe.ts` y el `genReqId`; no el backend de cifrado ni la tabla de tokens. No revisé pay-qr, pay-risk, pay-schedules ni pay-settlement más allá de sus guards y `genReqId`.
- Webhooks: no revisé el inbox/idempotencia de eventos ni el reconciliador de Svix.
- No ejecuté la suite completa ni el e2e; solo `authz.spec.ts` de pay-edge.
- Dinero (rondas de ledger, hold, idempotencia de transferencias): fuera de este alcance; hay otro informe en esta carpeta (`REVISION-DINERO.md`), que no toqué.

## Evidencia reproducible

Los scripts están en `/tmp/claude-0/-home-user/e2a1ca80-8ad4-54a7-8e83-0b9ce0655bff/scratchpad/t/` (copias de los fuentes con la extensión `.ts` en los imports; Node 22 con `--experimental-transform-types`). No tocan el repo.
- `a.mjs`, `b.mjs`, `f.mjs`: guardia de PAN (casos, tasa de falsos positivos 734/200 000, tiempos).
- `c.mjs`: OpenBao (redirección sin fuga de token, carrera de `invalidate`, prefijo de espacio de nombres).
- `d.mjs`: recuperación del PAN desde `masked-<sha256>`.
- `e.mjs`: 40 URLs contra `TargetGuard`.
- `g.mjs`: `looksLikePan` de mockbank.
- `cfg/h.mjs`: validaciones de `loadConfig` bajo `PAY_MODE=live`.
- Prueba del repo: `cd services/pay-edge && flock /tmp/pay-heavy.lock yarn test test/authz.spec.ts` ⇒ `Tests: 28 passed, 28 total`.
