# contracts

> Dueño de la forma: **P1** · Dueño de la semántica: el de cada servicio.

OpenAPI 3.1 (API pública `v1` e interna), AsyncAPI 3 (eventos sobre NATS JetStream), esquemas JSON (RFC 9457, sobre CloudEvents), SDK TypeScript generado y librerías técnicas `@pay/money`, `@pay/problem`, `@pay/idempotency`, `@pay/outbox`, `@pay/webhook-signature`.

Las librerías técnicas no tienen lógica de negocio. Un cambio que rompe un contrato con la etiqueta `v1-frozen` necesita la aprobación de su dueño y de cada consumidor ([`PLAN-MAESTRO.md` §4](../docs/plan/PLAN-MAESTRO.md)).
