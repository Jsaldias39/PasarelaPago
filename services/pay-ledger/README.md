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
- **Rastro de rechazos** (`ledger_rejections`): TigerBeetle no guarda las transferencias rechazadas.

## Probar

```bash
platform/scripts/tigerbeetle-dev.sh start   # un solo nodo, SOLO desarrollo
TB_ADDRESS=127.0.0.1:54300 yarn test
```

TigerBeetle es compartido por las suites: las cuentas de plataforma tienen nombre fijo. `LEDGER_ID_NAMESPACE` aparta los ids de un proceso de los de otro
(la suite del invariante y `pay-settlement/test/ledger-real.spec.ts` lo usan); en producción va vacío.
