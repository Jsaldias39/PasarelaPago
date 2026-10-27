# Carril INT — El monolito cobra a través de la pasarela

> **Estado:** `TODO` · **AVANCE: 0 / 5 — 0,0 %** · **Peldaño:** `UNKNOWN`
> **Predecesor:** ola 4 (capa sandbox) cerrada (los flujos E1–E8 en verde contra el stack real). **Lidera:** P3, con P1 (SDK y webhooks).
> **Issue:** [mdavila-2001/mantra-core-health-api#1026](https://github.com/mdavila-2001/mantra-core-health-api/issues/1026) · **Repos:** `mdavila-2001/mantra-core-health-api` (consumidor) · este repo (sin cambios de contrato).
> Plan maestro: [`../PLAN-MAESTRO.md`](../PLAN-MAESTRO.md) · Decisión: D-12 en [`../DECISIONES.md`](../DECISIONES.md)

**Skills:** `github-multirepo-coordination`, `refactoring-safely`, `release-and-rollback`, `api-testing`,
`nestjs-development`, `evidence-and-verification`.

## Resultado observable

`mantra-core-health-api` deja de hablar con Libélula (su PSP actual) y cobra (consultas, farmacia, suscripciones)
a través de la API pública de la pasarela, como un comercio más. Su módulo 42 se retira por
partes, detrás de un *flag*, sin cortar un solo cobro en curso.

**Kill-test:** con el *flag* encendido, cobrar una consulta desde la API. Si la API todavía llama
a Libélula directo, o si el estado del cobro en la API no coincide con el de la pasarela tras el
webhook, no está hecho.

## Criterios

- **REQ-INT-1** — Dado el *flag* `payments.via_gateway=on`, cuando la API crea un cobro, entonces llama a `POST /v1/payment_intents` con `Idempotency-Key` y nunca al PSP directo. — `MISSING`
- **REQ-INT-2** — Dado un webhook `payment_intent.succeeded` firmado, cuando llega a la API, entonces se verifica la firma, se actualiza la deuda o factura una sola vez, y un duplicado no repite el efecto. — `MISSING`
- **REQ-INT-3** — Dado el *flag* apagado, cuando se cobra, entonces el camino viejo (M42 → Libélula) sigue funcionando igual (rollback inmediato). — `MISSING`

| ID | Microtarea | CA (binario) | DoD | Estado |
|---|---|---|---|---|
| INT.H1.M1 | La API consume el SDK generado de `contracts/` con una clave `sk_live_` de AloVida como comercio | Un intento creado desde la API aparece en la pasarela | Test de integración contra el stack | TODO |
| INT.H1.M2 | Checkout de M42 detrás de `payments.via_gateway` | REQ-INT-1 y 3 | Tests de los dos caminos | TODO |
| INT.H1.M3 | Receptor de webhooks en la API con `@pay/webhook-signature` + inbox | REQ-INT-2 | Test con duplicado y firma inválida | TODO |
| INT.H1.M4 | Migración de conexiones y deudas abiertas de Libélula: las nuevas van a la pasarela, las abiertas terminan por el camino viejo | Ninguna deuda abierta queda huérfana | Consulta de conteo pegada | TODO |
| INT.H1.M5 | Retiro de las rutas viejas de M42 tras dos cortes semanales sin uso | Las rutas devuelven `410` y el README del módulo lo dice | PR a `dev` de la API, mergeable | TODO |
