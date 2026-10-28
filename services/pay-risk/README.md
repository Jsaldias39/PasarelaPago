# pay-risk

Evaluación de riesgo de un cobro antes de mandarlo al proveedor (carril P5, `P5.H2`): motor de reglas versionado, cribado de sanciones con moov Watchman y rastro auditable de cada decisión.

- **Base propia:** `pay_risk`. No leas la base de ningún otro servicio.
- **Esquema:** `sql/ddl.sql` es el DDL que GENERA el modelo (`mantra-core-health-model`, D-18), vendorizado con `node scripts/p5-vendor-model-sql.mjs` (`--check` lo contrasta con el modelo). `src/schema-map.ts` es el mapa de lo que el código usa (sin ORM) y `test/drift.spec.ts` verifica mapa ↔ base ↔ SQL. `sql/reference/001_risk.sql` es el SQL de referencia anterior: se conserva fuera de `sql/` (para que el arnés e2e no lo aplique junto al `ddl.sql`) hasta que el modelo quede estable, y entonces se borra.
- **API:** `POST /assessments` (idempotente por `Idempotency-Key`: 201 la primera vez, 200 con la misma decisión al repetir) y `GET /assessments/{id}`; solo las llama `pay-payments`. Contrato: `contracts/openapi/internal-risk-v1.yaml`. Carga de límites (`POST /rule_sets`, `GET /rule_sets/current`, solo `pay-backoffice` con rol `risk_admin`): PROPUESTA en `docs/trabajo/ola-1/P5/propuestas/internal-risk-rule-sets-v1.yaml`.
- **Contrato vigente** (`internal-risk-v1.yaml`, ola 2): implementa sus 4 operaciones y todos sus campos (`screening.entity_type`, `/rule_sets`); `test/contract-conformance.spec.ts` lo comprueba. Un nombre en blanco y una huella vacía (válidos para el contrato) se tratan como ausentes. El `503` queda reservado: nunca se devuelve.
- **Sin eventos:** no hay eventos de riesgo en el AsyncAPI.

## Decisión

| `decision` | cuándo | `reason_code` (en orden de prioridad) |
|---|---|---|
| `deny` | sanciones fuertes, o un límite superado | `sanctions_match`, `amount_over_limit`, `daily_limit_exceeded`, `payer_daily_limit_exceeded`, `velocity_exceeded`, `merchant_velocity_exceeded` |
| `review` | coincidencia aproximada, cribado caído o ausente, pagador sin huella con límites por pagador, fuera de horario | `sanctions_possible_match`, `screening_unavailable`, `screening_not_provided`, `payer_unidentified`, `outside_allowed_hours` |
| `allow` | cribado limpio y nada superado | `ok`, o `no_limits_configured` si no hay ningún límite cargado (para que se vea que la regla no está activa) |

- **Nunca `allow` sin cribar** (`screened: false` ⇒ como mucho `review`); la tabla lo impide con una restricción.
- **Cribado (D-29):** se criba siempre el nombre legal del comercio (`screening.merchant_name`, por defecto como empresa) y, si el pagador dio nombre, también el suyo (`screening.name`); gana el más grave. `screening_not_provided` solo si falta el nombre del comercio; un pagador invitado sin nombre no bloquea. El contrato `internal-risk-v1.yaml` ya declara `merchant_name` y `merchant_entity_type` (PR-17); ningún campo de `screening` es obligatorio.
- **Agrupación por intento (PROP-19):** el grupo es `payment_intent_id`. Dos evaluaciones del mismo intento (comercio y pagador, `${intentId}:risk` y `${intentId}:risk:payer`) cuentan UNA vez en la velocidad y en los límites diarios; el importe que cuenta es el MAYOR evaluado del intento (no depende del orden) y un intento con algún `deny` no consume límite.
- **Sin límites por defecto (D-23):** la versión 1 del conjunto de reglas es «sin límites» (todo `NULL`). Los límites los carga el negocio o el banco.
- **Los umbrales de sanciones no tienen valor por defecto** (`SANCTIONS_DENY_SCORE`, `SANCTIONS_REVIEW_SCORE`): los fija cumplimiento; sin ellos el servicio no arranca. Se decide por umbral, nunca por «hubo resultados».
- **Datos personales:** el nombre se manda a Watchman (solo nombre y tipo) y **no se guarda ni se registra**; el pagador se guarda como HMAC (`PAYER_HASH_KEY`). El rastro es inmutable (triggers).
- **Latencia:** la prueba de carga real (2× el volumen objetivo, T-01) es de la ola 3; `test/latency.spec.ts` mide en la máquina compartida y es sensible a la carga externa (P5.H2.M4 sigue A MEDIAS).
- **Watchman en el entorno local es `v2-static` con listas de 2019, SOLO sandbox.** Nunca se presenta como el cribado real.

## Modo

`PAY_MODE` (`sandbox` \| `live`) es obligatorio y sin valor por defecto. Bajo `live` hay que declarar `WATCHMAN_LISTS=current`: las listas estáticas de 2019 son un doble de sandbox y el servicio no arranca con ellas.

## Entorno

Ver `.env.example`. Obligatorias y sin valor por defecto: `WATCHMAN_URL`, `SANCTIONS_DENY_SCORE`, `SANCTIONS_REVIEW_SCORE`, `PAYER_HASH_KEY`.

## Comandos

```bash
yarn typecheck && yarn test        # Postgres y Watchman REALES; los fallos de Watchman se prueban con un [DOBLE] declarado
```
