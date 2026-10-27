# pay-ledger

Libro mayor de partida doble de la pasarela. Carril P2 ([`docs/plan/carriles/P2-ledger-y-liquidacion.md`](../../docs/plan/carriles/P2-ledger-y-liquidacion.md)).
**Es el único servicio que mueve y conoce saldos.** El dinero vive en **TigerBeetle**; Postgres guarda lo que TigerBeetle no tiene.

- **Base propia:** `pay_ledger` (`sql/001_ledger.sql`; a mover a `mantra-core-health-model`, D-18) y TigerBeetle (`TB_ADDRESS`).
  Sin ORM: `src/ledger/schema-map.ts` + `test/drift.spec.ts` (deriva, 97.2).
- **Contratos:** `contracts/openapi/internal-ledger-v1.yaml` y `GET /balance` de `public-v1.yaml`; eventos en `contracts/asyncapi/ledger-settlement.yaml`.
- **Salud:** `GET /health/live`; `GET /health/ready` (Postgres y TigerBeetle).
- **Entorno:** ver `.env.example`. Sin `TB_ADDRESS` el servicio no arranca.

## Cómo funciona (hallazgos del spike en `docs/spikes/tigerbeetle.md`)

- **El llamador no manda ids de 128 bits**: manda `business_ref` + `attempt` y el servidor deriva los ids (`ids.ts`). Un id **rechazado** por TigerBeetle
  no se puede reintentar (`id_already_failed`), por eso `attempt` forma parte del id: tras un rechazo el reintento usa `attempt + 1`.
  `attempts.ts` hace cumplir la regla en el servidor (solo `N + 1` tras un rechazo; nunca otro intento tras uno aceptado).
- **Atomicidad:** un asiento son patas enlazadas (`linked`): todas o ninguna. Las retenciones son transferencias de dos fases con vencimiento.
- **Recuperación:** ids deterministas ⇒ si el proceso cae entre TigerBeetle y Postgres, repetir el mismo `(business_ref, attempt)` converge
  (`exists` / `id_already_failed`) sin mover el dinero dos veces.
- **Eventos:** `ledger.transfer.posted` (uno por pata) y `ledger.hold.*` van al outbox **en la misma transacción** que registra el asiento.
- **Invariante global** (`invariant.service.ts`): débitos = créditos y TigerBeetle = extracto de Postgres, por job y por prueba.
- **Deuda por contracargo:** `pending` y `available` nunca quedan en negativo (TigerBeetle lo impide). Un contracargo (pata `adjustment` de `pending` a la compensación de un conector) lo parte el servidor en un lote enlazado: `min(bruto, pendiente)` desde `pending` y el exceso desde `merchant:{id}:debt`, cuenta deudora que no se puede pagar de más; el corte de `pay-settlement` la netea contra el disponible.
- **Rastro de rechazos** (`ledger_rejections`): TigerBeetle no guarda las transferencias rechazadas.

## Modo `test` / `live` (D-28)

Todas las rutas (internas y `GET /balance`) exigen `X-Pay-Mode: test|live`; ausente o distinto ⇒ `403 forbidden`, nunca se cae en `live`. El modo sale **solo** de la
cabecera (un `mode` en el cuerpo o en la consulta es un campo desconocido, `422`).

Cómo se separa, sin reglas de negocio nuevas:

- **Identidad:** el modo entra en el id de cada cuenta de TigerBeetle, en el de cada transferencia y en los ids públicos `tx_`/`hd_`. `merchant:X:pending` de `test` y de `live`
  son DOS cuentas distintas; una pata no puede nombrar una cuenta del otro modo (el modo es uno por petición) ni gastar su saldo (rechazo por saldo).
- **Registro:** columna `mode` en las seis tablas (`CHECK IN ('test','live')`), claves únicas `(mode, …)`, y las claves foráneas de las patas y del extracto son
  compuestas `(mode, account)`. Toda consulta filtra por modo.
- Pedir por un id, un `business_ref`, una cuenta o una retención del OTRO modo da `404 resource_not_found`: no se revela que existe.
- La `Idempotency-Key` de `post`/`void` se guarda por `(llamador, modo)`.
- El invariante global verifica cada `(modo, cuenta)` por separado.
- Los eventos `ledger.*` NO llevan `mode` todavía: el AsyncAPI es `additionalProperties: false` y no lo declara (propuesta 1 en `docs/trabajo/ola-2/P2/PROPUESTAS.md`). El código ya lo conoce: con `EVENTS_CARRY_MODE=true` cada evento lo lleva, sin tocar código.

## Cambiar la derivación de ids (migración obligatoria)

Los ids de TigerBeetle (cuentas y transferencias) y los públicos (`tx_`, `hd_`, `tf_`, `sl_`) **no se guardan como un contador: se derivan** con SHA-256 de
`namespace | tipo | modo | business_ref | intento | índice` (`src/ledger/ids.ts`). Por eso son **deterministas y estables** entre reinicios y entre réplicas: no dependen del reloj,
del azar, del idioma ni de la zona horaria (`test/ids.spec.ts` lo prueba con valores fijados y con procesos aparte).

Esa estabilidad es lo que une cada fila de Postgres con su cuenta o transferencia en TigerBeetle. **Cambiar la derivación en un ledger con datos** —el algoritmo, el orden de las partes,
el modo, `LEDGER_ID_NAMESPACE` o `BASE_NAMESPACE`— hace que los ids nuevos no coincidan con los ya asentados: el dinero registrado queda huérfano (las cuentas «nuevas» arrancan en cero
y los asientos repetidos no se reconocen como repetición). **Exige una migración** (recalcular y reasignar, o transferir saldos con asientos de apertura), nunca un despliegue sin más.
La ola 2 la cambió una vez al agregar el modo (D-28): solo era posible porque no había un ledger con datos.

## Probar

```bash
platform/scripts/tigerbeetle-dev.sh start   # un solo nodo, SOLO desarrollo
TB_ADDRESS=127.0.0.1:54300 yarn test
```

TigerBeetle es compartido por las suites: las cuentas de plataforma tienen nombre fijo. `LEDGER_ID_NAMESPACE` aparta los ids de un proceso de los de otro
(la suite del invariante y `pay-settlement/test/ledger-real.spec.ts` lo usan); en producción va vacío.
