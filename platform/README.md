# platform

Dueño: **P1**. Stack local, plantilla de servicio y scripts de verificación.

## Stack local

```bash
cp platform/.env.example platform/.env        # HUB=docker.io; usá un espejo si tu red limita Docker Hub
docker compose -f platform/compose.yml up -d --wait
platform/scripts/check-db-separation.sh       # un rol y una base por servicio, sin permisos cruzados
```

Todos los puertos publicados escuchan solo en `127.0.0.1` (revisión de seguridad). Credenciales: **solo desarrollo local**.

| Servicio | Puerto local | Verificado |
|---|---|---|
| postgres (un rol y una base por servicio + `pay_test`) | 54321 | sí, `healthy` |
| nats (JetStream) | 54222 (monitor 54822) | sí, `healthy` |
| redis | 54379 | sí, `healthy` |
| temporal + temporal-db | 54233 | sí, `healthy` |
| jaeger (UI 54686, OTLP 54317/54318) | 54686 | sí, `healthy` |
| watchman `v2-static` — **solo sandbox, listas OFAC de 2019** | 54084 | sí, `healthy` |
| `--profile full`: openbao (54200), svix (54800) | — | **sí** (por `HUB=mirror.gcr.io`): OpenBao 2.7.2 y svix-server 1.104.0 verificados con sus suites (ver `docs/COMO-CONTINUAR.md`); svix necesita 3 perillas de prueba |
| tigerbeetle (54300) | — | **sí, por binario** con `platform/scripts/tigerbeetle-dev.sh`; la imagen de ghcr.io no se pudo bajar |

## Servicios nuevos

```bash
platform/scripts/new-service.sh pay-ledger 3102   # crea services/pay-ledger desde platform/templates/service
platform/scripts/verify-template.sh               # genera, verifica de verdad y borra un servicio de prueba
```

La plantilla trae NestJS 11, MikroORM 7 (`forRoot`, como la API), pino con `request_id`, Terminus (`/health/live` y
`/health/ready`), errores RFC 9457, OpenTelemetry opcional, el relé del outbox hacia NATS y un `Dockerfile` por servicio.
Pendiente: el adaptador MikroORM → `Queryable` (P1.H1.M9).

## Pruebas de integración

`yarn test` corre contra el Postgres y el NATS del Compose (no contra el ORM mockeado). Si no están arriba, falla con un mensaje
que dice cómo levantarlos. Variables: `PAY_TEST_DATABASE_URL`, `PAY_TEST_NATS_URL`.
