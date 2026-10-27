# Decisiones tomadas sin confirmación — carril P5, ola 1

Supuestos que se tomaron para no detenerse. Cada uno dice a quién hay que confirmárselo. Sin valores de negocio inventados:
los números de pruebas son de prueba y están marcados como tales.

## pay-merchants

| ID | Decisión / supuesto | Confirmar con |
|---|---|---|
| D5-01 | **Los 18 puntos del alta legal** (3.1) se mapean: razón social, tipo societario, NIT y los 6 PDF (constitución, NIT, SEPREC, licencia, certificado SEDES, poder del representante) viven en `pay-merchants`; dirección, GPS central y de sucursales, gerentes y contactos viven en `directory` (M04) y se guardan como `directory_tenant_ref` opaco. **Pregunta escalada Q-22:** ¿`pay-merchants` referencia el `directory` o recaptura esos datos? | Stakeholder / dueño de `directory` |
| D5-02 | Para aprobar el KYC se exigen los 6 documentos y un nivel de riesgo (`low`/`medium`/`high`). | Cumplimiento |
| D5-03 | El NIT es único entre comercios no cerrados. | Negocio |
| D5-04 | El canal `direct` (7.9) no impone que su tasa sea menor que la de otros canales; se publica lo que se acuerde. | Negocio |
| D5-05 | Las claves `test` las pueden tener comercios `pending`/`active`; las `live`, solo `active`. Suspendido ⇒ `merchant_suspended`; cerrado ⇒ `forbidden`. | Producto |
| D5-06 | Gracia de rotación 24 h, tope 20 claves activas por comercio, documento KYC máximo 10 MiB. Son parámetros de arranque, no reglas. | Seguridad |
| D5-07 | Almacén de objetos de KYC: `FsObjectStore` es **[DEV]**; falta la implementación de producción (S3/MinIO con acceso autorizado y cifrado). | Infra (P1) |
| D5-08 | Versión 0 en `GET /merchants/me` = todavía no hay tarifario en vigencia. | P1 |
| D5-09 | Roles de operador propuestos (Q-21/Q-23) y llamador `pay-backoffice`. Sin verificador configurado, el back-office responde 401 (falla cerrado). | Identidad |
| D5-10 | Publicar un tarifario NO es idempotente por clave: cada POST crea una versión. `effective_from` pasado se rechaza (tolerancia 5 s). | P1 |
| D5-11 | Cerrar un comercio no revoca sus claves: los consumidores aplican `merchant.closed` (ver PR-07). | P1 / P3 |
| D5-12 | D-28 aplicado: el modo del llamador se lee de `X-Pay-Mode` (`test`\|`live`), nunca del cuerpo ni del token. | Coordinador |
| D5-13 | Hallazgo propio corregido: el almacén de idempotencia devuelve un error de negocio guardado como resultado; sin tratamiento, `POST /merchants` y `POST /api_keys` lo devolvían como 2xx al repetirse. Ahora se vuelve a lanzar como RFC 9457 (`src/idempotent.ts`, con prueba de regresión). | — |

## pay-risk

| ID | Decisión / supuesto | Confirmar con |
|---|---|---|
| D5-20 | **Umbrales de sanciones** (`SANCTIONS_DENY_SCORE`, `SANCTIONS_REVIEW_SCORE`) y `PAYER_HASH_KEY` obligatorios y SIN valor por defecto: el servicio no arranca sin ellos. Los valores de las pruebas (0,80 / 0,60) son de prueba, no de negocio (Q-12). Se decide por umbral inclusivo, nunca por «hubo resultados». | Cumplimiento |
| D5-21 | **Límites** (D-23) versionados e inmutables; la versión 1 es «sin límites» (todo `NULL`) y `POST /assessments` responde `allow` con `no_limits_configured`. «Por día» = ventana móvil de 24 h (no día calendario). Velocidad = intentos DISTINTOS por pagador/comercio en la ventana; el intento número n+1 se rechaza. Los importes diarios suman solo intentos no rechazados. Horario en hora de La Paz (UTC-4), `[from, to)`, sin rangos que crucen la medianoche. | Negocio / banco |
| D5-22 | Sin nombre a cribar ⇒ `review` `screening_not_provided` (más conservador). Con un límite por pagador y sin huella del pagador ⇒ `review` `payer_unidentified`. | Cumplimiento + P3 (¿siempre mandan nombre?) |
| D5-23 | **Watchman caído, lento (> `SCREENING_TIMEOUT_MS`, 200 ms por defecto, máximo 250) o con respuesta inválida ⇒ HTTP 201 con `decision: review`, `reason_code: screening_unavailable`, `screened: false`** y rastro; nunca `allow`. El contrato borrador dice `503`; se siguió el carril (PR-11c). | P3 + P5 |
| D5-24 | Sin `entity_type` se hacen dos búsquedas (persona y empresa) y se toma el mayor puntaje; una búsqueda caída con la otra limpia ⇒ `unavailable`; una coincidencia fuerte manda aunque la otra falle. | Cumplimiento |
| D5-25 | El nombre se manda a Watchman SOLO como nombre y tipo (URL interna, Watchman no autentica). No se guarda ni se registra; en la idempotencia entra como HMAC. El rastro guarda el puntaje máximo y la lista/id **públicos** de la mejor coincidencia. | Cumplimiento |
| D5-26 | Listas del Watchman local: `v2-static` de 2019, SOLO sandbox. Las listas vigentes no se cargaron (sin acceso de red; spike). | Infra + cumplimiento |
| D5-27 | La carga de límites (`POST /rule_sets`) es una propuesta de contrato con rol `risk_admin` (PR-08, PR-11). | Identidad |

## pay-schedules

| ID | Decisión / supuesto | Confirmar con |
|---|---|---|
| D5-30 | **La política de reintentos** (`RETRY_DELAYS_SECONDS`) y la URL del libro mayor son obligatorias y SIN valor por defecto. La de las pruebas (1 h, 2 h, 4 h) es de prueba. Intentos totales = esperas + 1. | Negocio |
| D5-31 | El pagador es `merchant:{id}:available` (no `user:{id}:wallet`): el mandato es de un comercio. Si el médico paga desde una billetera de usuario, cambia la cuenta de origen. | Dueño (E5 dice «saldo AloVida») |
| D5-32 | **Flujo del libro mayor:** retención `merchant:{pagador}:available → schedule:{mandato}:reserve` (hold) → confirmación → asiento `reserve → merchant:{beneficiario}:available` (`platform:fees` y código `fee` en las comisiones). **No se usa `pay-payments` `POST /intents`**: su respuesta no expone el asiento que exige el evento y duplicaría el movimiento del saldo. | P3 + P2 |
| D5-33 | 7.8 (Q-15, conservador): una comisión es un mandato `pay_commission` creado por el propio proveedor (su consentimiento), con importe fijo y beneficiario = `PLATFORM_MERCHANT_ID` (sin él, no se aceptan). Frecuencia mensual (el contrato no tiene semanal). | Stakeholder (#161 y Q-15) |
| D5-34 | Beneficiarios solo comercios de la pasarela y ACTIVOS (réplica por eventos `merchant.*`). Al crear: 422 `beneficiary_merchant_id` (`unknown`/`not_active`/`is_payer`). Al ejecutar una obligación: beneficiario no activo o inexistente ⇒ `failed` `merchant_suspended`, sin retener; si se bloquea entre fases se anula la retención (void) o se hace el asiento inverso, `needs_review`, y NUNCA se acredita. Pagador desconocido para la réplica no bloquea (manda lo que autenticó pay-edge). | Coordinador / P1 |
| D5-35 | Resultado ambiguo (timeout, corte, 5xx, 404/403, cuerpo no contractual) ⇒ se reintenta con la MISMA clave; nada se anula ni se borra; si la política se agota ⇒ `failed` `ledger_unavailable` con `needs_review`. Solo `422 insufficient_funds`/`validation_failed` exactos son definitivos. | — |
| D5-36 | Un periodo `failed` NO deja al mandato pausado: vuelve a `active` para los periodos siguientes. Un pago con dinero ya retenido se completa aunque se cancele el mandato. Un mandato pausado no materializa periodos nuevos hasta resolver el pendiente (se ponen al día de a uno por corrida). | Negocio |
| D5-37 | `mandate.created` etc. llevan solo ids y montos (la descripción libre no sale por el bus). El aviso al médico/proveedor es el evento; el webhook lo arma `pay-webhooks`. | P1 |
| D5-38 | Un `executed` sin `tf_…` del libro mayor ⇒ el pago queda `executed` con `needs_review` y sin evento (PR-09). | P2 |

> **Ola 2:** D5-38 queda sin efecto. `ledger_transfer_id` cita el `tx_…` de `Transaction.id` (docs/trabajo/ola-2/CONTRATOS.md §3 fila 1), el asiento inverso usa `code: adjustment` y los eventos de mandatos llevan `mode`.

## Ola 2, tanda 2c

| ID | Decisión / supuesto | Confirmar con |
|---|---|---|
| D5-40 | **D-29:** `pay-risk` criba siempre `screening.merchant_name` (por defecto como empresa, UNA búsqueda) y, si viene, `screening.name` del pagador. El resultado es el más grave de los dos (`match > unavailable > possible_match > clear`). `screening_not_provided` solo si falta el nombre del comercio; aun así, una coincidencia fuerte del pagador es `deny`. Pagador invitado sin nombre no bloquea. | P3 |
| D5-41 | **Credencial de operador (`pay-merchants`):** JWT RS256 con `iss`, `aud`, `exp`, `sub`, `roles` y **`mode`** (`sandbox\|live`) atado al despliegue; `OPERATOR_TOKEN_PUBLIC_KEY/ISSUER/AUDIENCE` completas o ninguna; sin valores por defecto; sandbox sin ellas arranca y NADIE es operador (401); `live` sin ellas no arranca. `scripts/sandbox-operator-token.mjs` emite credenciales sintéticas solo con `PAY_MODE=sandbox`. 401 si falta/no verifica/otro modo; 403 si falta el rol. | Identidad |
| D5-42 | **PAY_MODE** explícito (sandbox\|live), sin valor por defecto, en los tres servicios. Bajo `live` NO arrancan: `pay-merchants` con el almacén de KYC `fs` (doble [DEV]; hoy `live` no puede arrancar hasta que exista el almacén de producción) o con `DISABLE_BACKGROUND_JOBS=1`; `pay-risk` sin `WATCHMAN_LISTS=current` (las estáticas de 2019 son un doble) ; `pay-schedules` con `DISABLE_BACKGROUND_JOBS=1` (no embebe ningún doble). | Coordinador |
| D5-43 | **D-32:** cerrar revoca todas las claves vivas (también las que están en gracia de rotación) con motivo `merchant_closed`; las ya revocadas conservan su motivo y su hora; suspender no revoca y reactivar restaura (mismo secreto, mismo hash). | P1 (PR-16) |

## Ola 2, tanda 2d

| ID | Decisión / supuesto | Confirmar con |
|---|---|---|
| D5-44 | **D-33:** `pay-merchants` emite `legal_name` (la razón social del alta) SOLO en `merchant.created` y `merchant.activated`, dentro de la misma transacción que el cambio de estado; nunca en otro evento, ni en logs, trazas o errores. NIT, nombre de fantasía y documentos siguen sin salir. `pay-schedules` ignora el campo (el evento tipado no lo lleva y no se guarda). | P3 (consume) |
| D5-45 | **PROP-19:** en `pay-risk` el grupo es el INTENTO (`payment_intent_id`). Velocidad = intentos distintos en la ventana; importes diarios = cada intento una vez con el MAYOR importe que se le evaluó (no «el de la primera»: dos evaluaciones pueden compartir `created_at` y el orden por `id` es aleatorio); si alguna evaluación del intento fue `deny`, el intento no consume el límite. La evaluación en curso excluye a su propio intento. Re-evaluar con un importe menor no esquiva el límite; con uno mayor cuenta el mayor. | P3 |
