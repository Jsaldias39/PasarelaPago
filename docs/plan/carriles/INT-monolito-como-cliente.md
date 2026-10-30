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
| INT.H1.M3 | Receptor de webhooks en la API con `@pay/webhook-signature` + inbox | REQ-INT-2 | Test con duplicado y firma inválida | HECHO · [informe](../../trabajo/ola-5/INT/INFORME.md) · receptor de webhooks y camino de cobro por la pasarela detrás del flag `PAYMENTS_VIA_GATEWAY` (apagado por defecto), tras CUATRO revisiones independientes de solo lectura ([última](../../trabajo/ola-5/integracion/revision/VERIFICACION-DELTA-3-API-INT.md): ningún MAYOR abierto, con `RLS_ENFORCE` verdadero y falso). Verificado por el integrador en `mantra-core-health-api@3a2b56836`: tsc 0, eslint 0, 618 pruebas unitarias de pagos y 120 de integración contra PostgreSQL real (rol `NOBYPASSRLS` con la política real para el receptor), 0 bases/roles residuales. **LIMITACIONES DECLARADAS (HECHO ≠ listo para encender el flag):** P1 (pool con RLS) está MITIGADO, no eliminado (tope por proceso `ceil(DB_POOL_MAX/2)-1` y 503 reintentable; la solución de fondo es sacar la ruta de la transacción del interceptor, decisión del dueño de M42); D10 abierto (un DECLINE durante el vuelo del primer envío no detiene ese cobro); el cobro huérfano tras un `close` manual expira solo y, si se paga, cae en conciliación, pero no se verificó que haya exportador/alerta de las métricas; el cobro bajo rol `NOBYPASSRLS` con política real no se probó (solo los webhooks) y no se levantó `AppModule`; todo contra el doble de la pasarela, no contra `pay-edge`; catálogo de `sourceRefType` por acordar con el front (P8); N8 (factura cobrada no llega a billing); m2/m3/m4/m7/m8/m9 abiertos; menores D14–D16. Producción supuestamente usa `RLS_ENFORCE=true` (confirmar con quien opere el despliegue) |
| INT.H1.M4 | Migración de conexiones y deudas abiertas de Libélula: las nuevas van a la pasarela, las abiertas terminan por el camino viejo | Ninguna deuda abierta queda huérfana | Consulta de conteo pegada | BLOQUEADO (externo) — depende de los datos reales de Libélula y de una decisión de corte con producto; no se inventan deudas |
| INT.H1.M5 | Retiro de las rutas viejas de M42 tras dos cortes semanales sin uso | Las rutas devuelven `410` y el README del módulo lo dice | PR a `dev` de la API, mergeable | BLOQUEADO (externo) — exige dos cortes semanales sin uso del camino viejo en producción; no se puede adelantar |
