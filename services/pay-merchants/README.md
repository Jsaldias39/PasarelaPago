# pay-merchants

Comercios de la pasarela de pagos ALOVIDA (carril P5, `P5.H1`): alta, KYC, contrato versionado, tarifario por canal, claves de API y estado.

- **Base propia:** `pay_merchants`. No leas la base de ningún otro servicio.
- **Esquema:** `sql/001_merchants.sql` es **SQL de referencia, a mover a `mantra-core-health-model`** cuando exista el pipeline `.puml → SQL/ → base → ORM` (D-18). Las tablas técnicas (outbox, inbox, idempotencia) vienen de `contracts/packages/*/sql`.
- **Rutas públicas** (las reenvía `pay-edge` con `X-Service-Id: pay-edge`, `X-Merchant-Id` y `X-Pay-Mode: test|live`, D-28): `GET /merchants/me`, `POST|GET /api_keys`, `POST /api_keys/{id}/rotate`, `DELETE /api_keys/{id}`. Contrato: `contracts/openapi/public-v1.yaml`.
- **Back-office** (`X-Service-Id: pay-backoffice` + credencial de operador con rol): 13 operaciones en `docs/trabajo/ola-1/P5/propuestas/internal-merchants-v1.yaml` (PROPUESTA, ver `PROPUESTAS.md`).
- **Eventos** (outbox → NATS, `contracts/asyncapi/merchants-schedules.yaml`): `merchant.created|activated|suspended|closed`, `fee_schedule.published`, `api_key.created|revoked`. Solo ids, estados e importes.

## Reglas que el código hace cumplir

- Un comercio solo pasa a `active` con KYC `approved` **y** el contrato vigente aceptado; si falta algo, `409` con el motivo y no cambia nada.
- La aceptación del contrato y las versiones del contrato y del tarifario son **inmutables en la base** (triggers).
- La clave de API se muestra **una vez** (`sk_<modo>_<id>_<secreto>`, D-27); en la base queda solo `sha256$…`. Una clave de un modo no crea, lista, rota ni revoca las del otro (D-28).
- Los documentos de KYC van **fuera de la base** (interfaz `ObjectStore`), con tipo real por magic bytes y tamaño máximo. Nombres, NIT y documentos no salen por logs, eventos ni errores.
- La comisión sale solo de `@pay/money.splitFee` (neto half-up, D-20): comisión + neto = bruto.

## Puntos de extensión que NO son de producción

| Pieza | Por defecto | Falta |
|---|---|---|
| `OBJECT_STORE` | `FsObjectStore` **[DEV]** (filesystem local) | S3/MinIO con acceso autorizado y cifrado (DECISIONES-TOMADAS D5-07) |
| `OPERATOR_AUTHENTICATOR` | `DenyAllOperatorAuthenticator`: niega a todos (el back-office responde 401) | Servicio de identidad de operadores (Q-21, Q-23, PR-08) |

## Entorno

Ver `.env.example`. Sin variable obligatoria, el servicio no arranca.

## Comandos

```bash
yarn typecheck && yarn test        # las pruebas usan Postgres REAL (puerto 54321); el verificador de operadores es un [DOBLE] declarado
```
