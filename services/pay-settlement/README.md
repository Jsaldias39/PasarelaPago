# pay-settlement

Corte semanal, pagos a comercios, cobros netos (abono y comisiones), conciliación y excepciones. Carril P2
([`docs/plan/carriles/P2-ledger-y-liquidacion.md`](../../docs/plan/carriles/P2-ledger-y-liquidacion.md)).
**Nunca guarda saldos**: los saldos son del [`pay-ledger`](../pay-ledger/README.md); acá vive el estado de los procesos.

- **Base propia:** `pay_settlement` (`sql/ddl.sql`, **vendorizado** de `mantra-core-health-model` `SQL/pay/78_pay_settlement/ddl.sql`; el modelo es la única fuente, D-18: no se edita a mano, se regenera con `scripts/vendor-model-sql.sh` y se verifica con `--check`). Sin ORM: SQL parametrizado con `pg`;
  `src/settlement/schema-map.ts` es la capa de entidades y `test/drift.spec.ts` la verificación de deriva (97.2).
- **Contratos:** `contracts/openapi/internal-settlement-v1.yaml` (+ `GET /payouts` de `public-v1.yaml`, vía `pay-edge`), eventos en
  `contracts/asyncapi/ledger-settlement.yaml`. Dos rutas están **fuera del contrato** y marcadas PROPUESTA: `POST /charges` y
  `GET /exports/accounting` (ver `docs/trabajo/ola-1/P2/PROPUESTAS.md`).
- **Habla con:** `pay-ledger` (retenciones, asientos, saldos, extractos) y `pay-connectors` (extractos y transferencias salientes), solo por HTTP.
  Consume `ledger.transfer.posted` y `fee_schedule.published` por NATS (inbox).
- **Salud:** `GET /health/live`; `GET /health/ready` también informa `settlement.mode`, el riel y si es **simulado**.
- **Entorno:** ver `.env.example`. Sin variable obligatoria, o con una combinación peligrosa, el servicio no arranca.

## Qué hace

| Pieza | Dónde | Qué garantiza |
|---|---|---|
| Corte `POST /batches` | `batch.service.ts` | Idempotente por `cutoff_date`. Libera `pending → available` lo cobrado hasta T+7 (marca de agua + arrastre por comercio), cobra deudas y abono, y paga lo disponible. |
| Payout `POST /payouts` | `payout.service.ts` | Retiene → ordena por el riel → confirma o anula. Cada paso es idempotente y el pago retoma desde donde quedó. |
| Rieles | `rails.ts` | `bank_transfer` (modo A, real) y `acquirer_settlement` (modo B, **doble declarado**, `simulated: true`). |
| Neteo | `netting.service.ts` | Abono mensual (una vez por mes), comisión programada (7.8) y deuda por contracargo: cobra lo que hay y deja la deuda abierta. |
| Conciliación | `reconcile.ts`, `reconciliation.service.ts` | Cruza el extracto (JSON, CSV o camt.053) con el ledger; las diferencias son excepciones. **Nunca ajusta el ledger.** |
| Resolución | `POST /reconciliation_exceptions/{id}/resolve` | Lo decide una persona con `OperatorToken` (JWT RS256); `resolved_by` sale de la credencial. |
| Exportación | `export.service.ts` | Asientos de un periodo cerrado para M16; `balanced` compara con `platform:fees` del ledger. |

## Reglas de dinero que este servicio hace cumplir

1. **Un resultado ambiguo no es un fallo.** Un 502/503/504, un corte, un timeout o un 404 sin el cuerpo exacto del contrato después de ordenar un
   pago **no anula** la retención: el pago queda `in_transit`, se consulta de forma autoritativa (`GET /transfers/{business_ref:attempt}`) y, si no se
   resuelve, se escala (`settlement_audit`, acción `payout.needs_attention`). Solo es definitivo `502 connector_unavailable` (problem+json) al ordenar y
   `404 transfer_not_found` (problem+json) al consultar.
2. **Idempotencia en cada borde.** Mismo `Idempotency-Key` ⇒ misma respuesta; mismas referencias del ledger (`business_ref` + `attempt`) en cada reintento;
   la clave del riel es estable por pago.
3. **El saldo nunca queda negativo**: lo impide el ledger, y este servicio cobra `min(deuda, disponible)`.
4. **Quién decide sale de la credencial**, nunca del cuerpo. Un rol insuficiente es 403 antes de tocar la idempotencia (el 403 no se guarda).
5. **El modo B es un doble** y se niega a arrancar con `PAY_MODE=live`.
6. **`PAY_MODE=sandbox|live` es obligatorio y no tiene valor por defecto.** Bajo `live` se niega a arrancar con cualquier doble: cliente del ledger o de conectores que no sea el HTTP real, riel simulado, modo B o el conector `mock` (`src/settlement/deployment.ts`). Una clave `test` solo opera contra `sandbox`; una `live`, contra `live` (`403` en cualquier otra combinación).

## Modo `test` / `live` (D-28)

Toda la API interna exige `X-Pay-Mode: test|live` (ausente o distinto ⇒ `403 forbidden`; nunca se cae en `live`). El modo sale **solo** de la cabecera. Los pagos, cortes,
cobros, corridas de conciliación y excepciones **guardan** su modo (columna `mode`, `CHECK IN ('test','live')`), toda consulta lo **filtra** (pedir un id del otro modo ⇒ `404`) y se
**propaga**: cada llamada al ledger y a los conectores lleva `X-Pay-Mode` con el modo del registro (un pago retomado por el barrido usa el modo con que nació). Consecuencias:

- El mismo lunes se corta una vez por modo (`UNIQUE (mode, cutoff_date)`); las marcas del corte (`settlement_merchant_marks`) son por `(modo, comercio)`.
- Una `Idempotency-Key` se guarda por `(llamador, modo)`; los ids estables de pagos y cobros incluyen el modo.
- El dinero de un modo no se paga ni se cobra desde el otro (el ledger tiene cuentas distintas por modo).
- `payout.created|paid|failed` llevan `mode`. Los demás eventos no lo llevan (el AsyncAPI no lo declara).
- `resolve`: `401` si la credencial del operador falta, venció o no verifica; `403` si es válida pero sin el rol (CONTRATOS.md §3, fila 17).

## Eventos que consume (con inbox) y que emite con modo

Todo consumidor usa inbox (`processOnce`: efecto único por `(consumidor, evento)`) y tolera entrega repetida, concurrente y sin orden (`test/consumers.spec.ts`, `test/nats.spec.ts`):

- `ledger.transfer.posted` → directorio de comercios (`first_seen_at` es el MÍNIMO y `last_activity_at` el MÁXIMO que llegaron, en cualquier orden).
- `fee_schedule.published` → tarifario; una versión vieja que llega tarde nunca pisa a la nueva.
- `payment_intent.contradiction_detected` (pay-payments, interno) → abre una excepción de conciliación `payment_contradiction` (sin corrida ni conector). **No mueve dinero**: no toca el
  ledger, los conectores ni los pagos. Un mismo hecho (aunque llegue con otro id de evento) abre una sola excepción; sin `mode` en el evento queda con modo desconocido y se ve desde los dos
  modos. Hoy el contrato no admite `kind: payment_contradiction` ni `run_id: null` en `ReconciliationException` (propuesta 8).
- `mode` en `settlement.batch.closed` y `reconciliation.exception.opened`: apagado (el AsyncAPI no lo declara); `EVENTS_CARRY_MODE=true` lo enciende cuando el contrato lo admita. `payout.*` ya lo llevan siempre.

## Probar

```bash
yarn typecheck && yarn lint && yarn test      # Postgres (54321) y NATS (54222) del compose; TigerBeetle para ledger-real.spec
platform/scripts/tigerbeetle-dev.sh start     # solo ledger-real.spec lo necesita (y requiere `yarn build` en services/pay-ledger)
```

Los colaboradores de las pruebas son **dobles declarados** (`test/helpers/fakes.ts`, `connectors-server.ts`) salvo `ledger-real.spec.ts` y
`nats.spec.ts`, que usan el `pay-ledger` real (proceso aparte) y NATS JetStream reales.
