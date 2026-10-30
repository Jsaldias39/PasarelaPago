# Carril INT — El monolito cobra a través de la pasarela

> **Estado:** `EN CURSO` · **AVANCE: 1 / 5 — 20,0 %** · **Peldaño:** `TESTED` (M2 y M3 contra dobles; cliente y firma además contra el sandbox real) · [informe](../../trabajo/ola-5/INT/INFORME.md)
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
| INT.H1.M1 | La API consume el SDK generado de `contracts/` con una clave `sk_live_` de AloVida como comercio | Un intento creado desde la API aparece en la pasarela | Test de integración contra el stack | BLOQUEADO (externo) — necesita una clave `sk_live_` con cuenta recaudadora y visto bueno legal (T-03); con `sk_test_` el cliente ya se probó contra el sandbox real ([corrida](../../trabajo/ola-5/INT/evidencia/sandbox-real-corrida.txt)) |
| INT.H1.M2 | Checkout de M42 detrás de `payments.via_gateway` | REQ-INT-1 y 3 | Tests de los dos caminos | A MEDIAS · [informe](../../trabajo/ola-5/INT/INFORME.md) — anda: flag `PAYMENTS_VIA_GATEWAY` (apagado por defecto), cobro por la pasarela con clave determinista y reintento con la misma clave, mismas compuertas que el camino viejo, 361 tests de pagos en verde y camino viejo intacto. No anda / falta: probar con persistencia real y la API arrancada; confirmar con P3 y el dueño de M42 que el despacho ocurra en `processTransaction` y no al crear (ambigüedades 1–4 del informe). Rama `claude/adoring-allen-ly7r6f` de la API, sin PR |
| INT.H1.M3 | Receptor de webhooks en la API con `@pay/webhook-signature` + inbox | REQ-INT-2 | Test con duplicado y firma inválida | HECHO · [informe](../../trabajo/ola-5/INT/INFORME.md) · receptor con firma Standard Webhooks (paridad de 15 vectores con `@pay/webhook-signature`), anti-replay y bandeja idempotente; 8 entregas reales del sandbox verificadas por el verificador de la API; y `test/integration/payments-gateway-webhook.int-spec.ts` contra **PostgreSQL real** (DDL real de `42_payments`, 11 pruebas verificadas por el integrador): duplicado ×3 = un efecto, 10 entregas concurrentes ×8 rondas = una fila y la deuda descontada una vez, orden invertido sin retroceso, importe distinto archivado, rollback sin efecto parcial, cobro desconocido ⇒ 404; con mutaciones (sin `FOR UPDATE` o sin índice único, las pruebas fallan). Salvedades: FK a tablas ajenas omitidas y esquema reducido a 5 tablas; no se probó sobre HTTP real ni con varias réplicas; la prueba es opt-in (`PAYMENTS_WEBHOOK_IT=local-throwaway-db`); queda sin reflejar `openapi/openapi.yaml` ni el inventario generado |
| INT.H1.M4 | Migración de conexiones y deudas abiertas de Libélula: las nuevas van a la pasarela, las abiertas terminan por el camino viejo | Ninguna deuda abierta queda huérfana | Consulta de conteo pegada | BLOQUEADO (externo) — depende de los datos reales de Libélula y de una decisión de corte con producto; no se inventan deudas |
| INT.H1.M5 | Retiro de las rutas viejas de M42 tras dos cortes semanales sin uso | Las rutas devuelven `410` y el README del módulo lo dice | PR a `dev` de la API, mergeable | BLOQUEADO (externo) — exige dos cortes semanales sin uso del camino viejo en producción; no se puede adelantar |
