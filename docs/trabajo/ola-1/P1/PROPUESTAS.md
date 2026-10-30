# Propuestas de cambio de contrato y de plataforma · P1 · ola 1

> Ningún contrato fue modificado por P1 (la regla del carril: los cambios se proponen). Cada propuesta lleva el **parche**, quién tiene que
> aprobarlo y qué prueba lo respalda. Las que tocan un contrato `v1-frozen` necesitan la aprobación de su dueño y de sus consumidores.

| # | Propuesta | Toca | Aprueba | Urgencia |
|---|---|---|---|---|
| 1 | Fijar `@mikro-orm/*` en 7.1.7 | `package.json` raíz | P1 + dueños de servicios con ORM | Media |
| 2 | Códigos `upstream_error/unavailable/timeout` (502/503/504) | `@pay/problem` + `public-v1.yaml` | P1 | Alta (el borde ya los emite) |
| 3 | **APLICADA** — `Mandate` no podía validar nunca: `allOf` + `additionalProperties: false` | `public-v1.yaml` | P5 (dueño de mandatos), avisado | Hecha por pedido del coordinador |
| 4 | Cabecera `X-Pay-Mode` (D-28) en los contratos internos y en la respuesta pública | `internal-*.yaml`, `public-v1.yaml` | P1 + todos los dueños | Alta |
| 5 | Declarar `403`, `429` y `422` de forma uniforme en toda operación pública | `public-v1.yaml` / `common.yaml` | P1 | Media |
| 6 | Catálogo de eventos de webhook, forma del payload y detalles de `webhook_endpoints` | `public-v1.yaml` | P1 | Alta |
| 7 | Credenciales y permisos de NATS por servicio | `platform/` | P1 | Alta antes de la ola 3 |
| 8 | `contracts:breaking` en el `package.json` raíz y en el CI | raíz, CI | P1 | Media |
| 9 | Códigos del 422 del borde (`card_number_detected`, `invalid_json`) documentados | `public-v1.yaml` | P1 | Baja |
| 10 | DDL de `pay_edge` y `pay_webhooks` al pipeline del modelo (D-18) | `mantra-core-health-model` | P1 | Ola 2 |

---

## 1 · Fijar MikroORM en 7.1.7

**Problema.** Con `^7.1.7` el lockfile de `pay-edge`/`orm-queryable` resolvió `@mikro-orm/core` 7.2.5, cuyos tipos no son compatibles con
`@mikro-orm/postgresql` (`SqlSchemaGenerator` sin `refresh`/`ensureIndexes`); `mantra-core-health-api` está en 7.1.7. `orm-queryable` lo
sorteó con un tipo estructural, pero cualquier servicio con ORM puede tropezar con el mismo error de compilación.

**Parche** (`package.json` raíz):

```json
"resolutions": {
  "@mikro-orm/core": "7.1.7",
  "@mikro-orm/postgresql": "7.1.7",
  "@mikro-orm/knex": "7.1.7"
}
```

**Prueba.** `yarn install` + `yarn workspaces foreach -A run typecheck` sin errores de MikroORM. No se aplicó porque el `package.json` raíz es compartido.

## 2 · Códigos 502 / 503 / 504 del borde

**Problema.** `pay-edge` responde `502 upstream_error` (servicio de destino con una respuesta inválida), `503 upstream_unavailable` (cortacircuitos
abierto o conexión caída, con `Retry-After`) y `504 upstream_timeout`. No están en `PROBLEM_CATALOG` ni en `public-v1.yaml`; hoy los arma
`services/pay-edge/src/edge-problem.ts` con `type: urn:alovida:pay:problem:<code>`.

**Parche** (`contracts/packages/problem/src/catalog.ts`):

```ts
upstream_error: { status: 502, title: 'El servicio de destino respondió algo inválido' },
upstream_unavailable: { status: 503, title: 'El servicio de destino no está disponible' },
upstream_timeout: { status: 504, title: 'El servicio de destino no respondió a tiempo' },
```

y en `contracts/openapi/common.yaml` tres respuestas `BadGateway`, `ServiceUnavailable` (con cabecera `Retry-After`) y `GatewayTimeout`, referenciadas desde toda operación pública.
**Prueba.** `services/pay-edge/test/proxy.spec.ts` (niveles límite e inválido) ya fija estos códigos; al aprobarse, `edge-problem.ts` pasa a usar el catálogo.

## 3 · `Mandate` no validaba nunca (defecto del contrato) — APLICADA

**Estado.** El coordinador pidió aplicarla (P5 la encontró también). Cambio en `contracts/openapi/public-v1.yaml`: `MandateFields` (sin `additionalProperties`), `MandateCreate = allOf[MandateFields] + unevaluatedProperties: false` y `Mandate = allOf[MandateFields, {id, object, status, next_run_on, created_at}]`. `yarn contracts:lint` en verde (`evidencia/contracts-lint.txt`); `services/pay-edge/test/contract-mandate.spec.ts` y `proxy.spec.ts` validan respuestas reales de `Mandate` sin excepciones. Lo que sigue abajo es el análisis original.

**Problema.** `Mandate` se define con `allOf: [MandateCreate, …]` y `MandateCreate` lleva `additionalProperties: false`: ninguna respuesta real de
`Mandate` (que tiene `id`, `object`, `status`, `created_at`) puede validar. Lo demuestra el doble ya validado contra el contrato: las respuestas
de `POST /mandates` y `GET /mandates` fallan con «additional properties».

**Parche** (`public-v1.yaml`):

```yaml
MandateFields:            # los campos, sin additionalProperties
  type: object
  required: [beneficiary_merchant_id, amount_minor, currency, frequency]
  properties: { … los de hoy … }
MandateCreate:
  allOf: [{ $ref: '#/components/schemas/MandateFields' }]
  unevaluatedProperties: false
Mandate:
  allOf:
    - { $ref: '#/components/schemas/MandateFields' }
    - { type: object, required: [id, object, status, created_at], properties: { id: …, object: { const: mandate }, status: …, created_at: … } }
```

**Prueba.** `services/pay-edge/test/proxy.spec.ts` tiene `KNOWN_CONTRACT_DEFECT` y una prueba «DEFECTO CONOCIDO vigente» que **falla cuando el contrato se corrige**: ahí se borra el `Set`.

## 4 · `X-Pay-Mode` (D-28)

**Qué hace hoy el borde.** Reenvía `X-Pay-Mode: test|live`, tomado del **registro replicado** de la clave (no del token ni del cliente), a todo servicio dueño, y **descarta**
cualquier `X-Pay-Mode`, `X-Merchant-Id` o `X-Service-Id` del cliente (`services/pay-edge/test/authz.spec.ts`, `proxy.spec.ts` D-28). Además marca la respuesta pública
con `X-Pay-Mode: sandbox` cuando el borde corre en sandbox.

**Parche.** En cada `internal-*-v1.yaml`, un parámetro de cabecera obligatorio en toda operación que llame `pay-edge`:

```yaml
- { name: X-Pay-Mode, in: header, required: true, schema: { type: string, enum: [test, live] }, description: 'Lo fija pay-edge desde el registro de la clave (D-28). El servicio NUNCA lo toma de otro lado.' }
```

y en `public-v1.yaml` la cabecera de respuesta `X-Pay-Mode: { schema: { const: sandbox } }` (solo presente en sandbox).
**Pregunta abierta.** Los dueños deben **rechazar** (no ignorar) una petición sin `X-Pay-Mode` válido para que un servicio mal cableado no caiga en `live` por defecto.

## 5 · Respuestas 403 / 429 / 422 uniformes

**Problema.** `GET /balance` y otras operaciones no declaran `403` (`merchant_suspended`) ni `429` (`rate_limited`) aunque el borde puede responderlos en
cualquiera. Los tests de `authz.spec.ts` los validan contra `POST /payment_intents`, que sí los declara.
**Parche.** Agregar a `common.yaml` un bloque reutilizable y referenciarlo desde cada operación pública (o declarar `default` con `application/problem+json`):

```yaml
'403': { $ref: 'common.yaml#/components/responses/Forbidden' }
'429': { $ref: 'common.yaml#/components/responses/TooManyRequests' }
```

## 6 · Webhooks: catálogo, payload y detalles de `webhook_endpoints`

1. **Catálogo de eventos suscribibles.** Hoy `enabled_events` solo exige el patrón `^([a-z_]+\.[a-z_.]+|\*)$`. `pay-webhooks` rechaza con 422 (`unknown_event_type`) todo lo que no
   sea uno de estos 21 (`services/pay-webhooks/src/events/public-events.ts`) o `*`: `payment_intent.{created,requires_action,processing,succeeded,failed,canceled,expired}`,
   `refund.{created,succeeded,failed}`, `dispute.{opened,won,lost}`, `payout.{created,paid,failed}`, `mandate.{created,canceled}`,
   `scheduled_payment.{executed,failed,insufficient_funds}`. Propuesta: `items: { enum: [...], }` más `'*'`.
2. **Forma del payload entregado** (no está en el contrato):

   ```yaml
   WebhookEvent:
     type: object
     required: [id, object, type, created_at, mode, data]
     properties:
       id: { type: string, format: uuid, description: 'Igual a la cabecera webhook-id y estable en los reintentos.' }
       object: { const: event }
       type: { type: string }
       created_at: { $ref: 'common.yaml#/components/schemas/Timestamp' }
       mode: { type: string, enum: [test, live] }
       data: { type: object, required: [object], properties: { object: { type: object, additionalProperties: { type: [string, number, boolean, 'null'] } } } }
   ```

3. **Política de payload** (M5): solo ids, estados, códigos, fechas e importes; valores con correo, teléfono o tarjeta ⇒ el evento **se rechaza** y no se entrega. Documentarla en el contrato.
4. **`GET /webhook_endpoints`** no declara `limit` ni `starting_after`, aunque la respuesta lleva `next_cursor`. El servicio los acepta; el borde los rechaza (422 `unknown_parameter`) hasta que se declaren. Agregar `$ref: Limit` y `StartingAfter`.
5. **Códigos del 422 al registrar** (campo `url`): `invalid_url`, `https_required`, `credentials_in_url`, `port_not_allowed`, `internal_name`, `private_address`, `unresolvable`; campo `enabled_events`: `unknown_event_type`; campo `endpoint`: `limit_reached`.
6. **Idempotencia:** `POST /webhook_endpoints` y `rotate_secret` repiten el mismo cuerpo, incluido el secreto, con la misma `Idempotency-Key`; el contrato debe decirlo (hoy solo lo implica).
7. **`DELETE /webhook_endpoints/{id}`** responde 404 la segunda vez (el recurso ya no existe); el contrato lo declara y es consistente.
8. **Secretos v1a:** lo que se muestra es la clave **pública** `whpk_…`; la secreta `whsk_…` nunca sale. El texto del esquema ya lo dice; falta aclararlo en `rotate_secret`.

## 7 · NATS: credenciales por servicio

**Problema.** Dos consumidores de P1 **confían en el bus**: la réplica de claves de `pay-edge` (quien publique `api_key.created` en `pay-merchants.*` puede crear una clave que
autentica) y `pay-webhooks` (quien publique `payment_intent.succeeded` hace que se notifique un pago). Hoy NATS corre sin autenticación en el Compose local.
**Propuesta (ola 3).** Una cuenta/usuario NATS por servicio con permisos de publicación **solo** sobre sus temas (`pay-merchants.>` para `pay-merchants`, etc.) y de suscripción solo a los streams que consume;
`pay-edge` y `pay-webhooks` sin permiso de publicar en ningún tema de negocio. **Prueba a escribir:** un cliente con las credenciales de `pay-payments` intenta publicar en `pay-merchants.api_key.created` ⇒ denegado.
El consumidor ya valida forma y origen (`source: /pay-merchants`), pero eso no sustituye la autorización del bus: el campo `source` lo escribe quien publica.

## 8 · `contracts:breaking`

**Parche** (`package.json` raíz, en `scripts`):

```json
"contracts:breaking": "node contracts/scripts/check-breaking.mjs"
```

y un paso de CI (cuando el CI propio vuelva) con `oasdiff` instalado (`go install github.com/oasdiff/oasdiff@latest`) que corra `yarn contracts:breaking --base origin/dev`.
Falla (exit 1) ante cualquier ruptura en un contrato cuyo encabezado de la **base** diga `v1-frozen`; los borradores solo avisan; si no puede comparar, sale con 2 (nunca verde falso).
Ver `docs/trabajo/ola-1/P1/evidencia/P1.H1.M7.txt`. Hoy ningún `internal-*`/`public-v1` está marcado `v1-frozen` (solo `common.yaml`), así que **congelar un contrato = poner `v1-frozen` en sus primeras líneas**.

## 9 · Códigos del 422 del borde

`card_number_detected` (el cuerpo trae un número de tarjeta; mandar un `card_token`) e `invalid_json` (el cuerpo no es JSON) se agregan a la descripción de `Unprocessable` en `common.yaml`.

## 10 · DDL al pipeline del modelo

`services/pay-edge/sql/001_edge.sql` y `services/pay-webhooks/sql/001_webhooks.sql` son la referencia; D-18 manda que entren a `mantra-core-health-model`. Pendiente para la ola 2 (el repo del modelo no se tocó).
Tablas: `api_key_replica`, `merchant_replica`, `inbox_events` (edge); `webhook_endpoints`, `webhook_secrets`, `webhook_deliveries`, `webhook_delivery_attempts`, `inbox_events` (webhooks); más `idempotency_keys` en ambos.
