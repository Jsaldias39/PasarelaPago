# PasarelaPago — Pasarela de pagos ALOVIDA

Plataforma de pagos de ALOVIDA en **microservicios backend**: 11 servicios NestJS, cada uno con su
propia base de datos, imagen y despliegue, que solo se hablan por contratos (HTTP con OpenAPI o
eventos sobre NATS JetStream con AsyncAPI).

> **Estado:** ola 3 en curso. **AVANCE: 83 / 109 microtareas (76,1 %)**: los 12 servicios, el stack de pruebas E2E y el arnés de carga existen; el detalle y lo bloqueado están en [`docs/plan/PLAN-MAESTRO.md`](docs/plan/PLAN-MAESTRO.md).
> Empezá por [`docs/plan/PLAN-MAESTRO.md`](docs/plan/PLAN-MAESTRO.md).

## Qué resuelve

Los procesos **7.1–7.9** del stakeholder de AloVida: alta y contrato de comercios, comisión
acordada (porcentaje, fijo, canal directo y abono mensual), todo cobro por la pasarela, QR propio,
seguridad para los socios, pagos programados del médico y comisiones programadas de los proveedores.

Opera en **modo orquestador** ([D-02](docs/plan/DECISIONES.md)): cobra con PSP y bancos con
licencia y les paga a los comercios. **No mueve dinero real** hasta que existan la cuenta
recaudadora y el visto bueno legal (T-03).

## Mapa del repo

| Carpeta | Qué hay | Dueño |
|---|---|---|
| `docs/plan/` | Plan maestro, decisiones, investigación, carriles | — |
| `docs/cumplimiento/` | Alcance PCI DSS y cuestionario legal | P1 |
| `contracts/` | OpenAPI, AsyncAPI, SDK y librerías técnicas `@pay/*` | P1 |
| `platform/` | Compose local, plantilla de servicio, CI reutilizable | P1 |
| `services/pay-edge`, `services/pay-webhooks` | Borde público y webhooks salientes | P1 |
| `services/pay-ledger`, `services/pay-settlement` | Libro mayor y liquidación | P2 |
| `services/pay-payments`, `services/pay-vault` | Núcleo de pagos y bóveda de tarjetas | P3 |
| `services/pay-connectors`, `services/pay-qr` | Conectores, ruteo y QR | P4 |
| `services/pay-merchants`, `services/pay-risk`, `services/pay-schedules` | Comercios, riesgo y programados | P5 |

## Stack

Node 22 · NestJS 11 · MikroORM 7 · PostgreSQL · Yarn 4 · NATS JetStream · Temporal ·
TigerBeetle · Svix · OpenBao · moov Watchman · OpenTelemetry · Coolify.

## Flujo de trabajo

- Ramas `main` y `dev`. Todo PR va a `dev`, con revisión humana.
- Cada programador escribe solo en sus carpetas.
- Un contrato congelado (`v1-frozen`) cambia solo con la aprobación de su dueño y de sus consumidores.
- Estándar de la casa: `AlovidaPromptManager` (skills y reglas). Las reglas del repo están en [`CLAUDE.md`](CLAUDE.md).
