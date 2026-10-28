# P3 · ola 2, tanda 2a — adaptación a los contratos (pay-payments, pay-vault)

Fuente: `docs/trabajo/ola-2/CONTRATOS.md` §3, §5 (lista «recomendadas» de pay-payments). Evidencia literal: [`evidencia/`](./evidencia/).
Gates: `typecheck`, `build`, `yarn eslint` (servicios) y `yarn lint` (raíz) en exit 0; `yarn test --maxWorkers=2` ×2 en pay-payments (18 suites, 226 pruebas, las dos veces) y en pay-vault (58 pruebas, las dos veces).

| # | Pedido | Qué se hizo | Dónde se prueba |
|---|---|---|---|
| 1 | `GET /refunds/{id}` | Ruta en `PaymentsController` → `PaymentsService.getRefund`; el ajeno y el de otro modo dan el mismo 404. | `ola2.contracts.spec.ts` §1; `intents.api.spec.ts` (rutas = contrato) |
| 2 | `risk_denied` / `payment_declined` | `deny`/`review` → `risk_denied`; 422 del proveedor y `card_declined` → `payment_declined` (`normalizeFailureCode`); `payment_method_unavailable` se publica como `validation_failed`. | §2, `payment.workflow.spec.ts` |
| 3 | Borrar `transferIdForEvent` | Los eventos citan `tx_` (cobro, contracargo) y `hd_` (reembolso) tal como los devolvió el ledger; sin id no hay evento de éxito. Una prueba verifica que el código no fabrica `tf_`. | §3 |
| 4 | Emitir `mock` | Sin tabla de traducción; un `simulator` de un productor sin migrar se normaliza a `mock` al LEERLO. | §4 |
| 5 | `refund_id` + `GET /refunds/{id}` del conector | El `re_…` viaja al conector, se guarda el `cr_…` (`refunds.connector_refund_id`) y, sin aviso, el workflow ESCALA una vez y CONSULTA cada `STATUS_INQUIRY_MS` (solo lectura). `stale`/`pending` no cambian nada; éxito confirma la retención, fallo la anula. Reemplaza la espera indefinida (P3-D11). | §5, `refunds.disputes.spec.ts` |
| 6 | Cuenta de `bank_transfer_instructions` | La informa el conector; `BANK_TRANSFER_*` es solo respaldo. Sin ninguna: se anula el cargo, el intento queda `failed` y el POST responde 422 `payment_method_unavailable`. | §6, `media.spec.ts` |
| 7 | `payment_intent.contradiction_detected` | `contradictionsRepo.record` publica el evento por outbox en la MISMA transacción, una vez por hecho (único por intento+origen). | §7 |
| 8 | D-28 | Columna `mode` en `payment_intents`, `refunds` y `disputes`; filtro `(comercio, modo)` en todo acceso; `X-Pay-Mode` obligatorio (403 si falta o no es `test\|live`) en las rutas públicas e internas; viaja a ledger y conectores; `mode` en todos los eventos; la clave de idempotencia y el id del intento incluyen el modo. | §8, `schema.drift.spec.ts` |
| 9 | Dobles contra `contracts/` | Los dobles ya cargaban los YAML de `contracts/openapi` y `contracts/asyncapi`; una prueba exige que ninguna ruta apunte a copias en `docs/`. El doble de conectores ahora implementa `GET /refunds/{id}`, `refund_id`, la cuenta recaudadora y `stale`; se prueba en los tres niveles. | §9, `doubles.spec.ts` |

## Lo que necesito de otros carriles (no toqué nada ajeno)
- **P4 (`pay-connectors`)**: que implemente de verdad `GET /refunds/{id}` (`cr_…`, `refresh`, `stale`), acepte `refund_id`, informe `bank_name/account_holder/account_number` y emita `mock` y `ch_/cr_`. Hasta entonces esas rutas se ejercitan solo contra el doble. Si el conector real devuelve un 404 con su cuerpo exacto para un `cr_` que él mismo creó, `pay-payments` lo trata como error de integración (escala y falla el workflow), no como «el reembolso no existe».
- **P1 (`pay-edge`)**: agregar `GET /refunds/{id}` a su tabla de rutas (ya está en su lista obligatoria) y reenviar `X-Pay-Mode`.
- **P5 (`pay-schedules`)**: mandar `X-Pay-Mode` en `POST /intents` y `GET /intents/{id}`: sin él ahora reciben 403.
- **P2 (`pay-settlement`)**: consumir `payment_intent.contradiction_detected` (tema `pay-payments.payment_intent.contradiction_detected`).

## Decisiones tomadas
- **Compatibilidad de ids**: `intentIdFor`/`refundIdFor` ahora derivan de `(comercio, modo:clave)`; los ids de intentos creados antes de este cambio ya no se re-derivan (solo hay datos de desarrollo).
- **Falla de la cuenta recaudadora**: no es un `failure_code` del catálogo, así que se guarda `payment_method_unavailable` en la fila y se publica/serializa como `validation_failed`; la respuesta del POST es el 422 del contrato.
- **P3-D11 queda reemplazada** por el punto 5. **PROP-2, 3, 4, 5, 7, 8, 9 (D-28), 10 y 11 de la ola 1 quedan aplicadas**; PROP-6 (disputas) sigue como decisión del dueño; PROP-13 y 14 son de plataforma.

## No cubierto
- Contra el conector, el ledger y el borde REALES (todo sigue contra dobles declarados que validan el contrato).
- `mode` en los consumidores de `connector.transaction.status_changed` (el evento no lo trae: se correlaciona por `payment_intent_id`/`refund_id`).
- El listado de reembolsos (diferido por el contrato).
- `fallos-p3.md` de la ola 1 lo reescribe la suite en cada corrida; se dejó como estaba en git.


# Tanda 2b

Evidencia: `evidencia/2b-*.txt` (typecheck, build, `yarn eslint` y `yarn lint` de la raíz en exit 0; pay-payments 19 suites / 245 pruebas ×2 y pay-vault 58 ×2, `--maxWorkers=2`; la corrida fallida previa está en `2b-pay-payments-test-0-FALLA-PREVIA.txt` con su clasificación). Pruebas nuevas: `test/ola2.tanda2b.spec.ts` (19).

1. **`payment_method_unavailable`**: no es del catálogo, así que respuesta, fila, `last_error` y evento usan el MISMO `validation_failed`; el motivo va en `detail` y en el código de campo documentado. El motivo fino se guarda aparte (`payment_intents.failure_reason`). Propuesta del código al catálogo: `PROPUESTAS.md` PROP-15 (con el parche exacto).
2. **Llamadas salientes**: todas llevan `X-Service-Id: pay-payments`; ledger y conectores llevan `X-Pay-Mode` igual al del cobro (probado en `test` y `live` con cobro, cancelación, reembolso+consulta y contracargo). Riesgo no lleva `X-Pay-Mode` porque su contrato no lo declara (PROP-16). pay-settlement: pay-payments no lo llama.
3. **`X-Pay-Mode` en TODA ruta**: prueba que recorre cada ruta del controlador público y del interno (los GET de reembolsos incluidos) y exige 403 sin modo o con modo inválido. Las disputas no tienen rutas HTTP (decisión del dueño, D-4): se prueba que no existen.
4. **Regla 11 con consultas autoritativas**: un `404` de `GET /refunds/{id}` o de `GET /charges/{id}/status` ya no anula nada. El reembolso queda `pending` con la retención puesta; se escala (`refund_not_found_at_connector` / `charge_not_found_at_connector`, con evento) y el workflow sigue vivo y se resuelve cuando el conector responde. Al vencer, un cargo que el conector dice no conocer NO vence ni se cancela: queda escalado y el workflow falla visible (decisión: no hay forma de saber si se pagó).
5. **Conector lento y refund_id**: consulta que tarda menos que el timeout (se aplica), más que el timeout (ambigua: no anula, se resuelve al recuperarse) y dos reembolsos del mismo cobro que el doble distingue por `refund_id`, resueltos de forma independiente.
6. **Arreglo de una falla intermitente propia**: el primer request de los dobles pagaba la compilación de Ajv dentro del timeout de 300 ms de riesgo; ahora `DoubleServer.start()` precalienta los validadores.


# Tanda 2c

Evidencia: `evidencia/2c-*.txt`. Pruebas nuevas: `pay-payments/test/ola2.tanda2c.spec.ts` y `pay-vault/test/startup.mode.spec.ts`.

1. **Cribado D-29**: `assessRisk` manda a pay-risk la razón social del comercio (`screening {name, entity_type: business}`) y, si el intento trae nombre de pagador, hace una segunda evaluación (`entity_type: person`, clave `${intentId}:risk:payer`). Cualquier decisión que no sea `allow` (incluida `review`, D-30) cierra el cobro como `risk_denied`; pay-risk caído sigue siendo fail-closed (`risk_unavailable`). Pagador invitado sin nombre: no se manda nada y no bloquea. El nombre del pagador es un dato personal: columna `payer_name`, fuera de `IntentRow`, de las respuestas y de los eventos, y se borra al llegar el intento a un estado terminal.
2. **BLOQUEO A AVISAR (PROP-17):** no existe en `contracts/` ninguna fuente de la razón social del comercio para pay-payments (ni en `MerchantAdmin` ni en los eventos `merchant.*`). No se inventó: la réplica acepta `legal_name` de un evento si algún día llega y, mientras tanto, el cobro sale sin `screening` y pay-risk lo deja en `review/screening_not_provided` ⇒ `risk_denied`. **Con el contrato vigente ningún cobro real pasa el riesgo** hasta aplicar PROP-17. Tampoco hay fuente del nombre del pagador (PROP-18) y dos evaluaciones por intento necesitan que P5 confirme que no cuentan doble (PROP-19).
3. **Doble de riesgo**: ahora criba como el contrato: con `screening` y un nombre de su lista ⇒ `deny/sanctions_match` (comparación sin tildes ni mayúsculas), sin coincidencia ⇒ `allow/ok`, sin `screening` ⇒ `review/screening_not_provided` (nunca `allow`). `seedMerchant` carga una razón social sintética por defecto; los casos «sin nombre» la pasan en `null`.
4. **Apagado**: `IllegalStateError: Not running` se reproducía con `dist/main.js` + SIGTERM (código de salida 1): el Runtime de Temporal atrapaba la señal y detenía el worker antes del hook de Nest. Arreglo: `Runtime.install({ shutdownSignals: [] })` (el ciclo de vida es de Nest/`worker-main`) y `shutdown()` idempotente. La prueba levanta `dist/main.js` y fue VERIFICADA EN ROJO contra el código original (`code=1`) y en verde con el arreglo.
5. **`PAY_MODE`**: obligatorio y sin valor por defecto en pay-payments y pay-vault (`sandbox|live`; otro valor, vacío o con otra capitalización no arranca). Bajo `live`: pay-payments pregunta a pay-connectors `GET /connectors/health` y NO arranca si hay un conector `mock` o con modo distinto de `live`, si no contesta o si no informa ninguno (falla cerrado); pay-vault no arranca con `VAULT_BACKEND=fake`, y la misma regla (`assertBackendAllowed`) la repite el módulo antes de instanciar `FakeVaultBackend`. Los mensajes empiezan con `PAY_MODE=live:` y terminan en «se niega a arrancar».
6. **`.env.example`**: `PAY_MODE` en los dos servicios y `VAULT_URL` en pay-payments (opcional: hoy ningún flujo llama a la bóveda).

No cubierto en 2c: contra el pay-risk REAL (solo el doble que valida `internal-risk-v1.yaml`); `PAY_MODE=live` contra un `pay-connectors` real (no hay despliegue); en `live` no se puede detectar un doble de riesgo o de ledger (sus contratos no exponen un indicador de simulación).


# Tanda 2d (D-33)

Evidencia: `evidencia/2d-*.txt`. Pruebas nuevas: `pay-payments/test/ola2.tanda2d.spec.ts` (11).

1. **`payer_name`** (opcional, 1..200) se acepta en `POST /payment_intents`: validación de servidor (longitud; un nombre en blanco, no-texto o con un número de tarjeta se rechaza con 422 sin repetir el valor), se guarda en `payment_intents.payer_name`, alimenta la segunda evaluación `person` y se BORRA al llegar el intento a un estado terminal (probado tras `succeeded` y tras `risk_denied`). No sale en la respuesta, la lectura, el listado, la repetición idempotente ni en el outbox. La misma `Idempotency-Key` con otro `payer_name` es `422 idempotency_key_reused`. El contrato (`validateRequest`) y el servicio coinciden en 1 y 200 caracteres.
2. **`legal_name`**: probado con eventos construidos y validados contra el AsyncAPI NUEVO (`merchants-schedules.yaml`), con y sin el campo, en `merchant.created` y en `merchant.activated`: con nombre el cobro llega a pay-risk con ese nombre (`business`) y avanza hasta el conector; sin nombre sale sin `screening` y el intento es `risk_denied` sin cargo. Un `legal_name` inválido (301 caracteres, vacío, en blanco, no-texto) se IGNORA —ya no se trunca a 300— y por lo tanto deniega.
3. **Dobles**: el de riesgo ya cribaba como `internal-risk-v1` (2c) y su contrato no cambió; el «doble de mercantes» son los eventos de la prueba, validados por el AsyncAPI real. `seedMerchant` sigue sembrando una razón social sintética.
4. **Cobro exitoso de punta a punta contra dobles**: comercio activo con `legal_name` + invitado sin nombre + riesgo `allow` ⇒ 201 con `display_qr`, UNA evaluación, cargo en el conector; capturado ⇒ `succeeded` con asiento en el ledger y `payer_name` nulo; respuestas conformes a `public-v1.yaml`.
5. **PROP-19**: claves sin cambios (`${intentId}:risk`, `${intentId}:risk:payer`). Ver PROP-20: puede quedar sin objeto.
6. **`.env.example`**: puertos corregidos según el PR-19 de P5 (`RISK_URL` 3108, `CONNECTORS_URL` 3103, `LEDGER_URL` 3105; `VAULT_URL` 3111).

## Qué falta para que pasen E1/E2 (`e2e/pending`)
Con P3 cerrado en 2d, quedan estas cosas, ordenadas por cuánto bloquean (ninguna se pudo ejecutar acá: no corrí el arnés E2E, es de otro carril):
1. **PROP-20 (contrato de riesgo ↔ pay-risk real) — BLOQUEA.** `pay-risk` espera el nombre del comercio en `screening.merchant_name`; el contrato escrito y P3 lo mandan en `screening.name`. El pay-risk real lo lee como pagador y responde `review/screening_not_provided` ⇒ `risk_denied`. Hace falta una decisión de contrato (recomendada: aplicar el `merchant_name` de P5) y, después, ~15 líneas en P3.
2. **La semilla del arnés (`e2e/lib/seed.ts`, P1)** escribe `legal_name` en la base de pay-merchants pero publica a mano `merchant.created|activated` SIN `legal_name`: pay-payments nunca lo recibe. Hay que agregar `legal_name` a los dos `emit(...)`. (El emisor real de pay-merchants lo emite en 2d por P5; la semilla lo esquiva.)
3. **Watchman del stack E2E (P1/P5):** `SANCTIONS_REVIEW_SCORE=0.60` con las listas estáticas de 2019: si el nombre sintético de la semilla (`COMERCIO E2E SINTETICO SRL`) puntúa ≥ 0,60 contra alguna entrada, el resultado será `review` ⇒ denegado aunque todo lo demás esté bien. Hay que verificarlo corriendo el arnés, no se puede deducir.
4. **`pay-edge` (P1)** debe reenviar `payer_name` (opcional; E1/E2 no lo usan, pero el contrato público ya lo declara) y aceptarlo en su validación del cuerpo.
5. **El tramo del medio sigue sin haberse ejecutado contra servicios reales** (la nota del ARNES lo dice): consumo del evento del conector, asiento en el ledger, `succeeded_at`, `GET /v1/balance`. Puede aparecer algún desajuste de contrato que mis dobles no ven; la reproducción es lo primero que hay que hacer una vez resueltos 1 a 3.
6. **Arranque**: pay-payments y pay-vault exigen `PAY_MODE` (el arnés ya lo pone en `lib/services.ts`) y un worker de Temporal (`TEMPORAL_RUN_WORKER` no debe ser `false` en el proceso del E2E).

No cubierto en 2d: lo de 1 a 5 contra servicios reales; el rechazo de `payer_name` por el pan-guard del borde (P1) —acá solo la defensa en profundidad del servicio—.


# Tanda 2e (PROP-20 aplicada)

Evidencia: `evidencia/2e-*.txt`. Pruebas tocadas: `ola2.tanda2c.spec.ts` §1, `ola2.tanda2d.spec.ts` (+ §1b nueva), `doubles/doubles.spec.ts`.

1. **UNA evaluación por intento**, clave `${intentId}:risk`. `assessRisk` arma un solo bloque `screening`: `merchant_name` = razón social de la réplica (siempre que se conozca), `name` = `payer_name` SOLO si el intento lo trae. Desapareció la segunda llamada, la clave `:risk:payer` y `RiskRequest.keySuffix`.
2. **Tipos de entidad: no se adivinan.** `merchant_entity_type` no se manda (la réplica no guarda el tipo legal del comercio; pay-risk usa `business` por defecto) y el `entity_type` del pagador tampoco (el contrato público solo trae un nombre, no si es persona o empresa): sin él pay-risk busca como persona y como empresa y manda el puntaje mayor, que es lo conservador para sanciones. Si P5/el dueño quieren otra cosa, es una línea en `RiskClient.screeningBody`.
3. **Sin razón social** (la réplica no la tiene): la evaluación sale SIN `merchant_name` (con `name` si hay pagador; sin `screening` si tampoco) y pay-risk responde `review/screening_not_provided` ⇒ `risk_denied`. No se inventa ningún nombre (probado: el cuerpo no contiene el id ni nada derivado).
4. **Doble de riesgo** cribando como el contrato nuevo (valida contra el YAML nuevo): `merchant_name` obligatorio para no caer en `review`; `name` opcional y un invitado no bloquea; un nombre de la lista en CUALQUIERA de las dos partes ⇒ `deny/sanctions_match` (gana la más grave, también si falta `merchant_name`); idempotente por clave.
5. **Pruebas en tres niveles** (en `ola2.tanda2c.spec.ts` §1 y `ola2.tanda2d.spec.ts`): comercio con nombre ⇒ allow; sin razón social ⇒ risk_denied sin nombre inventado; pagador en la lista ⇒ deny (sin cargo); invitado sin nombre ⇒ no bloquea; riesgo caído ⇒ `risk_unavailable` fail-closed; `review` ⇒ deny.
6. **Privacidad (§1b)**: stdout/stderr de un cobro con `payer_name` hasta el estado terminal no traen ni `payer_name` ni la razón social; `payer_name` no queda en ninguna tabla (salvo la columna de los intentos aún no terminales) y la razón social solo en `merchant_replica`. El log HTTP no serializa cuerpos (`src/app.module.ts`, serializers de `req`/`res`).
7. Riesgo residual: si la razón social llega a la réplica ENTRE dos reintentos de la activity `assessRisk`, el segundo intento manda un cuerpo distinto con la misma clave y pay-risk responde `idempotency_key_reused` (422) ⇒ `RiskRejected` (no reintentable) y el workflow falla visible. Es raro (ventana de segundos tras el alta del comercio) y es fail-closed.

**E1/E2 (actualiza la lista de la tanda 2d):** el punto 1 (PROP-20) queda resuelto del lado de P3. Siguen: la semilla del arnés debe publicar `legal_name` (P1, `e2e/lib/seed.ts`); el puntaje de Watchman del nombre sintético contra las listas de 2019 (`SANCTIONS_REVIEW_SCORE=0.60`) solo se sabe corriendo el arnés; `pay-edge` debe reenviar `payer_name`; y el tramo del medio contra servicios reales no se ha ejecutado nunca. Que el `pay-risk` real acepte exactamente el cuerpo que arma `RiskClient` (`merchant_name`, `name`) no se ejecutó: coincide con su controlador (`assessments.controller.ts`), pero lo prueba solo el arnés.


# Tanda 2h (reanudación tras el reinicio del contenedor)

Evidencia: `evidencia/2h-*.txt` (typecheck, build, `yarn eslint services/pay-payments services/pay-vault`, `yarn lint` de la raíz y `yarn contracts:lint` en exit 0; pay-payments 24 suites / 314 pruebas y pay-vault 7 suites / 79, `--maxWorkers=2`).

1. **Estado heredado de 2g:** la corrida 1 de 2g había fallado (`ola2.tanda2g.kill.spec.ts`, conflicto de reembolso) y la 2 quedó cortada por el reinicio. Clasificación: **TEST_BUG**. El workflow escala `refund_status_conflict` DESPUÉS de dejar el reembolso `succeeded`; el test leía las contradicciones justo al ver `succeeded`. Arreglo sin debilitar: `waitFor` por condición (20 s) antes de la misma aserción. El archivo en aislado pasó 12/12 (`2h-kill-spec.txt`).
2. **Corridas completas pay-payments:** `2h-pay-payments-test-1.txt` PASS (314/314), `-test-2.txt` FAIL (1 prueba) y `-test-3.txt` PASS (314/314). Pay-vault ×2 PASS.
3. **Falla intermitente SIN causa demostrada (abierta):** `internal.api.spec.ts` «el mismo mandato y periodo…» (10 POST concurrentes con otra `Idempotency-Key` cada uno) recibió 2 valores distintos de `body.id` en la corrida 2 (un id y, casi seguro, una respuesta de error sin `id`). **No se reprodujo**: 48 repeticiones aisladas (8 + 40, estas últimas con 4 procesos quemando CPU) y 2 corridas completas posteriores pasaron. No tengo evidencia para clasificarla como PRODUCT_BUG ni como TEST_BUG; la lectura del código no muestra una carrera (el id del intento es determinista y el `INSERT` es `ON CONFLICT (id) DO NOTHING`). Para que la próxima aparición sea diagnosticable, la aserción ahora lanza un error con el estado HTTP, el código y el detalle de cada respuesta (misma exigencia, solo más información). **Riesgo residual:** si fuera un producto, sería un cobro programado que responde error bajo concurrencia, no un doble cobro (hay un solo `payment_intent` por mandato y periodo por el índice único).
4. **No cubierto:** E3 contra `pay-connectors` y `pay-ledger` reales; caída de Postgres y NATS.

# Tanda 3b (esquema de pay-payments y pay-vault desde el modelo, D-18)

Evidencia: `docs/trabajo/ola-3/P3/evidencia/3b-*.txt`. Modelo: commit `af60b79` (coincide con `753338a` en `pay_payments` y `pay_vault`: mismo sha256, `5360e87a…` y `24218c4…`).

1. `services/<svc>/sql/ddl.sql` = copia vendorizada de `SQL/pay/74_pay_payments/ddl.sql` y `SQL/pay/79_pay_vault/ddl.sql`; `sql/ddl.sql.source` anota commit y sha256. `scripts/vendor-model-sql.sh` (`yarn sql:vendor`) copia; `--check` (`yarn sql:check`) compara y sale 0 con SKIP si el repo hermano no está (probado con `MODEL_REPO` inexistente y con una mutación: exit 1).
2. Los helpers de test (`pay-payments/test/helpers/stack.ts`, `pay-vault/test/helpers/app.ts`) y por tanto los `schema.drift.spec` aplican solo el `ddl.sql` (sin las SQL de las librerías: ya trae outbox, inbox e idempotencia). Los `001_*.sql` se borraron tras pasar todo. READMEs actualizados.
3. P3.H1.M2 pasa a HECHO. **ORM = mapa del código (schema-map.ts): los servicios usan pg directo, sin ORM; el modelo es la única fuente (D-18).**
4. `yarn lint` de la raíz da exit 1 por dos errores de OTROS carriles (`services/pay-ledger/test/sensitive-data.spec.ts:2`, `services/pay-mockbank/test/idempotency-parallel.spec.ts:17`, `no-unused-vars`); no los toqué. `yarn eslint services/pay-payments services/pay-vault` da exit 0. Desajuste con el modelo: ninguno (no hay propuesta nueva).
5. `e2e/lib/infra.ts` (P1) `ddlFiles` lee todos los `*.sql` de `services/<svc>/sql` en orden: con solo `ddl.sql` sigue aplicando (después de las SQL de las librerías, que son `IF NOT EXISTS`). No lo ejecuté (arnés E2E de P1): lo dice la lectura del código, no una corrida. P1 puede simplificarlo según INTEGRACION.md.
